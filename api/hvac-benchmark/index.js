const https = require("https");
const crypto = require("crypto");
const { BlobServiceClient } = require("@azure/storage-blob");

// Team-scoped store for the HVAC PM price-benchmark index (Bid-Out).
//
// PHASE A of team isolation (see docs/team-isolation-plan.md). The Bid-Out userscript parses an
// "HVAC PM Price Benchmarking" workbook client-side into an index (hvacBuildIndex output) and,
// until now, kept it GM-local per user. This endpoint stores that index server-side scoped to the
// caller's TEAM, so a manager drops the workbook once and their whole team reuses it - and no
// other team can see or overwrite it (the target prices are competitive).
//
//   POST /api/hvac-benchmark            body { index }            -> save my team's index
//   GET  /api/hvac-benchmark                                      -> read my team's index
//   GET  /api/hvac-benchmark?action=whoami                        -> { email, teamId, scope }
//   GET  /api/hvac-benchmark?action=roster    (admin only)        -> the roster doc
//   POST /api/hvac-benchmark?action=roster    (admin only) { roster } -> replace the roster doc
//
// Identity boundary (NEVER trust a client-supplied team): two layers, same as user-role -
//   1. shared key (x-bwn-key vs WO_INGEST_KEY) - coarse gate
//   2. the Umbrava access token (Authorization: Bearer ...) - the REAL identity, PROVEN by asking
//      Umbrava's own GraphQL current-user (Umbrava tokens are HS256 / Umbrava-signed; a third
//      party cannot verify them locally, so Umbrava is the verifier). Team is then resolved from
//      the VERIFIED email against the roster - never from anything the client sends.
//
// Fail CLOSED: an unrostered caller gets a PRIVATE per-user scope (never another team's data);
// a missing roster => everyone is private (no accidental sharing before the roster is seeded).

const CONTAINER_NAME = "broadway-data";
const ROSTER_BLOB = "teams/roster";
const MAX_INDEX_BYTES = 4000000;    // ~4MB JSON - a 50-site index is ~100KB; generous headroom
const MAX_ROSTER_BYTES = 500000;

// ---- Umbrava identity (mirrors api/user-role - kept self-contained, house style) ------------
const ISS = process.env.UMBRAVA_ISS || "https://login.umbrava.com/";
const API_AUD = process.env.UMBRAVA_AUD || "https://app.umbrava.com/api";
const GRAPHQL_URL = process.env.UMBRAVA_GRAPHQL || "https://app.umbrava.com/api/graphql";
const EMAIL_CLAIM = "https://umbrava.com/email";
const TENANT_CLAIM = "https://umbrava.com/tenantid";
const ALLOWED_TENANTS = (process.env.UMBRAVA_TENANTS ||
  "42726f61-6477-6179-4e61-74696f6e616c,2fc24a61-4adf-41b0-a0f0-5c50fb9a862b")
  .split(",").map((s) => s.trim()).filter(Boolean);
const CLOCK_SKEW_S = 60;
const ROSTER_ADMINS = (process.env.ROSTER_ADMINS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key, Authorization",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}
function b64urlToBuf(s) { return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"); }
function b64urlJson(s) { try { return JSON.parse(b64urlToBuf(s).toString("utf-8")); } catch (e) { return null; } }

function httpsJson(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error("bad-url")); return; }
    const payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : "";
    const h = Object.assign({ "Accept": "application/json" }, headers || {});
    if (payload) { h["Content-Type"] = h["Content-Type"] || "application/json"; h["Content-Length"] = Buffer.byteLength(payload); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: method, headers: h, timeout: 10000 }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; if (buf.length > 2000000) { req.destroy(); reject(new Error("resp-too-large")); } });
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch (e) { /* leave null */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}
function decodeClaims(bearer) {
  const parts = String(bearer || "").split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const claims = b64urlJson(parts[1]);
  if (!claims) throw new Error("malformed");
  if (claims.iss !== ISS) throw new Error("bad-iss");
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (auds.indexOf(API_AUD) === -1) throw new Error("bad-aud");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_SKEW_S) throw new Error("expired");
  return claims;
}
let ROLE_QUERY = null;
const ROLE_CANDIDATES = [
  ["currentUser", "{ currentUser { id role } }"],
  ["me", "{ me { id role } }"],
  ["viewer", "{ viewer { id role } }"],
  ["currentMember", "{ currentMember { id role } }"],
  ["user", "{ user { id role } }"],
];
async function umbravaVouch(bearer) {
  const tries = ROLE_QUERY ? [ROLE_QUERY] : ROLE_CANDIDATES;
  let sawAuthFail = false, sawNet = false, saw200 = false;
  for (const [name, q] of tries) {
    let r;
    try { r = await httpsJson("POST", GRAPHQL_URL, { "Authorization": "Bearer " + bearer }, { query: q }); }
    catch (e) { sawNet = true; continue; }
    if (r.status === 401 || r.status === 403) { sawAuthFail = true; continue; }
    if (r.status < 200 || r.status >= 300) { sawNet = true; continue; }
    saw200 = true;
    const u = r.json && r.json.data && r.json.data[name];
    if (u && u.id) { ROLE_QUERY = [name, q]; return { ok: true, user: u }; }
  }
  if (sawNet && !saw200 && !sawAuthFail) throw new Error("upstream");
  return { ok: false };
}
// Resolve + PROVE the caller. Returns { ok, email, tenantId, role } or { err:{status,body} }.
async function resolveIdentity(req) {
  const expected = process.env.WO_INGEST_KEY;
  if (!expected) return { err: json(503, { error: "not configured" }) };
  const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
  if (!key || key !== expected) return { err: json(403, { error: "unauthorized" }) };
  const authz = req.headers && (req.headers["authorization"] || req.headers["Authorization"] || "");
  const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
  const token = m ? m[1] : ((req.body && req.body.token) || "");
  if (!token) return { err: json(401, { error: "no token", code: "NO_TOKEN" }) };
  let claims;
  try { claims = decodeClaims(token); }
  catch (e) { return { err: json(401, { error: "invalid token", code: String((e && e.message) || "invalid") }) }; }
  let vouch;
  try { vouch = await umbravaVouch(token); }
  catch (e) { return { err: json(503, { error: "identity provider unavailable", code: "UMBRAVA_UNAVAILABLE" }) }; }
  if (!vouch.ok) return { err: json(401, { error: "token not accepted by Umbrava", code: "not-vouched" }) };
  const email = String(claims[EMAIL_CLAIM] || claims.email || "").trim().toLowerCase();
  const tenantId = claims[TENANT_CLAIM] || "";
  if (!ALLOWED_TENANTS.length || ALLOWED_TENANTS.indexOf(tenantId) === -1) {
    return { err: json(403, { error: "not a Broadway tenant", code: "WRONG_TENANT" }) };
  }
  if (!email) return { err: json(403, { error: "no email claim", code: "NO_EMAIL" }) };
  return { ok: true, email: email, tenantId: tenantId, role: (vouch.user && vouch.user.role) || null };
}

// ---- roster -> team resolution --------------------------------------------------------------
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function emailHash(email) { return crypto.createHash("sha256").update(normEmail(email)).digest("hex").slice(0, 32); }
// A team = an OWNER (a Manager, or a Supervisor for a Supervisor-run team) + members (their
// coordinators, and any Supervisors working under that Manager). Owner or member -> that team.
function teamOf(roster, email) {
  email = normEmail(email);
  if (!roster || !Array.isArray(roster.teams)) return null;
  for (let i = 0; i < roster.teams.length; i++) {
    const t = roster.teams[i]; if (!t || !t.id) continue;
    const owner = normEmail(t.owner || t.manager);
    const members = Array.isArray(t.members) ? t.members.map(normEmail) : [];
    if ((owner && owner === email) || members.indexOf(email) !== -1) return String(t.id);
  }
  return null;
}
function scopeFor(roster, email) {
  const team = teamOf(roster, email);
  if (team) return { scope: "team", teamId: team, key: "teams/" + team + "/hvac-benchmark" };
  return { scope: "private", teamId: null, key: "users/" + emailHash(email) + "/hvac-benchmark" };
}

// ---- blob helpers (mirror send-bid / data-store) --------------------------------------------
let containerPromise = null;
function getContainerClient() {
  if (containerPromise) return containerPromise;
  containerPromise = (async () => {
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
    const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER_NAME);
    await container.createIfNotExists();
    return container;
  })().catch((err) => { containerPromise = null; throw err; });
  return containerPromise;
}
async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function readJsonBlob(container, name) {
  const blob = container.getBlockBlobClient(name);
  try {
    const dl = await blob.download();
    const txt = await streamToString(dl.readableStreamBody);
    return { exists: true, data: JSON.parse(txt), meta: dl.metadata || {} };
  } catch (err) {
    if (err.statusCode === 404) return { exists: false, data: null, meta: {} };
    throw err;
  }
}
async function writeJsonBlob(container, name, obj, metadata) {
  const blob = container.getBlockBlobClient(name);
  const body = JSON.stringify(obj);
  await blob.upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    metadata: metadata || undefined,
  });
}

// ---- validation -----------------------------------------------------------------------------
// The index is hvacBuildIndex output: { price:{key:{...}}, assets:{key:{...}}, meta?:{} }.
function validIndex(ix) {
  if (!ix || typeof ix !== "object" || Array.isArray(ix)) return false;
  if (!ix.price || typeof ix.price !== "object") return false;
  if (!ix.assets || typeof ix.assets !== "object") return false;
  return true;
}
const KEBAB_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function validRoster(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.teams)) return false;
  const seen = Object.create(null);
  for (const t of r.teams) {
    if (!t || typeof t !== "object") return false;
    if (typeof t.id !== "string" || !KEBAB_RE.test(t.id)) return false;
    if (seen[t.id]) return false; seen[t.id] = 1;
    if (t.members != null && !Array.isArray(t.members)) return false;
  }
  return true;
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    const ident = await resolveIdentity(req);
    if (ident.err) { context.res = ident.err; return; }
    const email = ident.email;
    const action = (req.query && req.query.action) || "";

    const container = await getContainerClient();

    // ── whoami: what team am I resolved to (for the userscript's banner / debugging) ──
    if (action === "whoami") {
      const roster = (await readJsonBlob(container, ROSTER_BLOB)).data;
      const sc = scopeFor(roster, email);
      context.res = json(200, { ok: true, email: email, teamId: sc.teamId, scope: sc.scope, isRosterAdmin: ROSTER_ADMINS.indexOf(email) !== -1 });
      return;
    }

    // ── roster admin (seed / read the roster). Gated to ROSTER_ADMINS (verified emails) ──
    if (action === "roster") {
      if (ROSTER_ADMINS.indexOf(email) === -1) { context.res = json(403, { error: "not a roster admin" }); return; }
      if (req.method === "GET") {
        const r = await readJsonBlob(container, ROSTER_BLOB);
        context.res = json(200, { ok: true, roster: r.data || { v: 1, teams: [] } });
        return;
      }
      const roster = req.body && req.body.roster;
      if (!validRoster(roster)) { context.res = json(400, { error: "invalid roster" }); return; }
      if (Buffer.byteLength(JSON.stringify(roster)) > MAX_ROSTER_BYTES) { context.res = json(400, { error: "roster too large" }); return; }
      await writeJsonBlob(container, ROSTER_BLOB, roster, { updatedby: emailHash(email), teams: String(roster.teams.length) });
      context.res = json(200, { ok: true, teams: roster.teams.length });
      return;
    }

    // ── benchmark index: read / write, scoped to the caller's team (or private fallback) ──
    const roster = (await readJsonBlob(container, ROSTER_BLOB)).data;
    const sc = scopeFor(roster, email);

    if (req.method === "GET") {
      const r = await readJsonBlob(container, sc.key);
      context.res = json(200, { ok: true, scope: sc.scope, teamId: sc.teamId, index: r.data, meta: r.meta || {} });
      return;
    }

    // POST = save the index for my scope (last-write-wins; a manager re-drop replaces it).
    const index = req.body && req.body.index;
    if (!validIndex(index)) { context.res = json(400, { error: "invalid index (need { price, assets })" }); return; }
    if (Buffer.byteLength(JSON.stringify(index)) > MAX_INDEX_BYTES) { context.res = json(400, { error: "index too large" }); return; }
    const meta = index.meta && typeof index.meta === "object" ? index.meta : {};
    await writeJsonBlob(container, sc.key, index, {
      updatedby: emailHash(email),
      sites: String((meta.sites != null) ? meta.sites : Object.keys(index.price).length),
      units: String((meta.units != null) ? meta.units : ""),
    });
    context.res = json(200, { ok: true, scope: sc.scope, teamId: sc.teamId });
  } catch (err) {
    context.log && context.log.error && context.log.error("hvac-benchmark error:", String((err && err.message) || err));
    context.res = json(500, { error: "hvac-benchmark failed" });
  }
};
