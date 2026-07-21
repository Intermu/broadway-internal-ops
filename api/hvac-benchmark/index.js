const crypto = require("crypto");
const { BlobServiceClient } = require("@azure/storage-blob");
const AUTH = require("../shared/umbrava-auth.js");

// Team-scoped store for the HVAC PM price-benchmark index (Bid-Out).
//
// PHASE A of team isolation (see docs/team-isolation-plan.md). The Bid-Out userscript parses an
// "HVAC PM Price Benchmarking" workbook client-side into an index (hvacBuildIndex output) and,
// until now, kept it GM-local per user. This endpoint stores that index server-side scoped to the
// caller's TEAM, so a manager drops the workbook once and their whole team reuses it - and no
// other team can see or overwrite it (the target prices are competitive).
//
//   POST /api/hvac-benchmark                  body { token, index }  -> save my team's index
//   POST /api/hvac-benchmark?action=read      body { token }         -> read my team's index
//   POST /api/hvac-benchmark?action=whoami    body { token }         -> { email, teamId, scope }
//   POST /api/hvac-benchmark?action=roster    (admin) { token, roster? } -> replace (or, with
//                                             no roster in the body, read) the roster doc
//   (GET variants remain for non-proxied contexts, but a GET cannot carry the body token,
//    and the SWA edge overwrites the Authorization header - so through the SWA everything
//    is a POST with the token in the body.)
//
// Identity boundary (NEVER trust a client-supplied team): two layers, same as user-role -
//   1. shared key (x-bwn-key vs WO_INGEST_KEY) - coarse gate
//   2. the Umbrava access token in the JSON BODY ({ token }) - the REAL identity, vouched
//      via ../shared/umbrava-auth.js (Umbrava's own current-user query verifies the token;
//      we never verify the signature locally). Team is then resolved from the VERIFIED
//      email against the roster - never from anything the client sends.
//
// REWORKED 2026-07-21: this endpoint originally carried its own copy of the identity code,
// written before the saga findings - it read the token Authorization-header-FIRST (the SWA
// edge replaces that header on every proxied request, so it always saw the platform token),
// and its vouch used five guessed current-user queries that all 400 against the real schema.
// Team resolution could therefore never actually work through the SWA. It now uses the
// shared module (body-first token, schema-verified vouch, union issuer/aud lists,
// case-insensitive tenant gate).
//
// Fail CLOSED: an unrostered caller gets a PRIVATE per-user scope (never another team's data);
// a missing roster => everyone is private (no accidental sharing before the roster is seeded).

const CONTAINER_NAME = "broadway-data";
const ROSTER_BLOB = "teams/roster";
const MAX_INDEX_BYTES = 4000000;    // ~4MB JSON - a 50-site index is ~100KB; generous headroom
const MAX_ROSTER_BYTES = 500000;

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
// Resolve + PROVE the caller (key gate + the shared body-first token vouch).
// Returns { ok, email, tenantId, role, rank, tier } or { err:{status,body} }.
async function resolveIdentity(req) {
  const expected = process.env.WO_INGEST_KEY;
  if (!expected) return { err: json(503, { error: "not configured" }) };
  const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
  if (!key || key !== expected) return { err: json(403, { error: "unauthorized" }) };
  const auth = await AUTH.resolveUmbravaUser(req);
  if (!auth.ok) return { err: json(auth.status, auth.body) };
  const u = auth.user;
  if (!u.email) return { err: json(403, { error: "no email claim", code: "NO_EMAIL" }) };
  return { ok: true, email: u.email, tenantId: u.tenantId, role: u.role, rank: u.rank, tier: u.tier };
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
      // Read = GET, or a POST that carries no roster (a POST is how the token travels through
      // the SWA, so the admin read is a body-token POST without a `roster` prop).
      if (req.method === "GET" || !(req.body && req.body.roster != null)) {
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

    // Read = GET (non-proxied contexts) or POST ?action=read (the SWA path - the token has
    // to ride in a body, and GETs through the edge cannot carry one).
    if (req.method === "GET" || action === "read") {
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
