const crypto = require("crypto");
const https = require("https");

// HTTP via the `https` module (NOT global fetch - the SWA Functions runtime doesn't expose it;
// every other api/ function uses `https` too). Resolves { status, json }.
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

// Verifies the Umbrava Auth0 access token a userscript sends, then resolves the caller's
// Umbrava ROLE - so role-based access levels can be TRULY enforced (the identity is proven by
// the token's signature; a tampered script can't forge it or claim someone else's email).
//
// Reached ANONYMOUSLY at the SWA route layer (Umbrava is a different origin). Auth is layered:
//   1. shared key (x-bwn-key vs WO_INGEST_KEY) - coarse gate, same as the rest of the suite
//   2. the Umbrava access token (Authorization: Bearer <token>) - the REAL identity, verified
//      against Umbrava's JWKS (RS256). Identity claims come straight from the verified token.
//   3. the Umbrava ROLE name (e.g. "National Account Manager") is NOT in the token, so it is
//      fetched from Umbrava's own current-user API using that same token (authoritative + live).
//
// Verified live against a real Umbrava token (2026-07): iss https://login.umbrava.com/, aud is
// an ARRAY that includes https://app.umbrava.com/api, email in the namespaced claim
// https://umbrava.com/email, tenant in https://umbrava.com/tenantid, sub = "waad|...".
//
// Returns { ok, email, sub, tenantId, role, roleSource }. NEVER stores or forwards the token.

const ISS = process.env.UMBRAVA_ISS || "https://login.umbrava.com/";
const API_AUD = process.env.UMBRAVA_AUD || "https://app.umbrava.com/api";
const GRAPHQL_URL = process.env.UMBRAVA_GRAPHQL || "https://app.umbrava.com/api/graphql";
const EMAIL_CLAIM = "https://umbrava.com/email";
const TENANT_CLAIM = "https://umbrava.com/tenantid";
// Broadway's own Umbrava tenants (home + the Maintenance LLC). Users outside these are valid
// Umbrava logins (clients/vendors) but not Broadway staff, so they get no role here.
const ALLOWED_TENANTS = (process.env.UMBRAVA_TENANTS ||
  "42726f61-6477-6179-4e61-74696f6e616c,2fc24a61-4adf-41b0-a0f0-5c50fb9a862b")
  .split(",").map((s) => s.trim()).filter(Boolean);
const CLOCK_SKEW_S = 60;
const ROLE_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 5 * 60 * 1000;

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

// ---- JWKS cache (by kid), with rotation-aware refetch --------------------------
let jwks = { byKid: {}, fetchedAt: 0 };
async function getKey(kid) {
  if (jwks.byKid[kid]) return jwks.byKid[kid];
  if (Date.now() - jwks.fetchedAt < JWKS_MIN_REFETCH_MS && jwks.fetchedAt) return null;   // don't hammer on an unknown kid
  const url = ISS.replace(/\/?$/, "/") + ".well-known/jwks.json";
  const r = await httpsJson("GET", url);
  if (r.status !== 200 || !r.json) throw new Error("jwks-fetch-" + r.status);
  const data = r.json;
  const byKid = {};
  (data.keys || []).forEach((k) => { if (k.kid) byKid[k.kid] = k; });
  jwks = { byKid, fetchedAt: Date.now() };
  return jwks.byKid[kid] || null;
}

// Verify an Umbrava access token: RS256 signature (JWKS) + iss + aud-includes + exp. Returns the
// verified claims, or throws an Error whose message is a stable code.
async function verifyToken(bearer) {
  const parts = String(bearer || "").split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (!header || !claims) throw new Error("malformed");
  if (header.alg !== "RS256") throw new Error("bad-alg");
  if (!header.kid) throw new Error("no-kid");

  const jwk = await getKey(header.kid);
  if (!jwk) throw new Error("unknown-kid");
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), pub, b64urlToBuf(parts[2]));
  if (!ok) throw new Error("bad-signature");

  if (claims.iss !== ISS) throw new Error("bad-iss");
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (auds.indexOf(API_AUD) === -1) throw new Error("bad-aud");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_SKEW_S) throw new Error("expired");
  return claims;
}

// ---- Umbrava role lookup (role is NOT in the token) -----------------------------
// The exact current-user root field isn't publicly documented; self-discover it once (a wrong
// name returns a fast GraphQL error, never a hang, server-side) and cache the winner. Role is
// cached per-sub with a short TTL so we don't call Umbrava on every request.
let ROLE_QUERY = null;
const ROLE_CANDIDATES = [
  ["currentUser", "{ currentUser { id role } }"],
  ["me", "{ me { id role } }"],
  ["viewer", "{ viewer { id role } }"],
  ["currentMember", "{ currentMember { id role } }"],
  ["user", "{ user { id role } }"],
];
const roleCache = {};   // sub -> { role, exp }
async function gql(bearer, query) {
  const r = await httpsJson("POST", GRAPHQL_URL, { "Authorization": "Bearer " + bearer }, { query });
  if (r.status < 200 || r.status >= 300) return null;
  return r.json;
}
async function fetchRole(bearer, sub, log) {
  const c = roleCache[sub];
  if (c && Date.now() < c.exp) return c.role;
  let role = null;
  const tries = ROLE_QUERY ? [ROLE_QUERY] : ROLE_CANDIDATES;
  for (const [name, q] of tries) {
    let j = null;
    try { j = await gql(bearer, q); } catch (e) { continue; }
    if (j && j.data && j.data[name] && "role" in j.data[name]) {
      ROLE_QUERY = [name, q];
      role = j.data[name].role || null;
      break;
    }
  }
  if (ROLE_QUERY && log) log("user-role: resolved via '" + ROLE_QUERY[0] + "'");
  roleCache[sub] = { role, exp: Date.now() + ROLE_TTL_MS };
  return role;
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    // Coarse gate (same shared key as the rest of the suite; NOT the identity boundary).
    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!key || key !== expected) { context.res = json(403, { error: "unauthorized" }); return; }

    // The real identity: the Umbrava access token.
    const authz = req.headers && (req.headers["authorization"] || req.headers["Authorization"] || "");
    const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
    const token = m ? m[1] : ((req.body && req.body.token) || "");
    if (!token) { context.res = json(401, { error: "no token", code: "NO_TOKEN" }); return; }

    // TEMP diagnostic (key-gated): echo what the server actually received - alg/kid only, NEVER
    // the signature. Reveals whether the Authorization token is altered in transit.
    if (req.query && req.query.debug === "1") {
      const dp = String(token).split(".");
      const dh = dp.length >= 1 ? b64urlJson(dp[0]) : null;
      context.res = json(200, {
        debug: true, authPrefix: String(authz).slice(0, 14), tokenParts: dp.length,
        recvAlg: dh && dh.alg, recvKid: dh && dh.kid, recvTyp: dh && dh.typ,
        headerNames: Object.keys(req.headers || {}),
      });
      return;
    }

    let claims;
    try { claims = await verifyToken(token); }
    catch (e) {
      const code = String((e && e.message) || "invalid");
      if (code.indexOf("jwks-fetch") === 0) { context.res = json(503, { error: "identity provider unavailable", code: "JWKS_UNAVAILABLE" }); return; }
      context.res = json(401, { error: "invalid token", code: code });
      return;
    }

    const email = claims[EMAIL_CLAIM] || claims.email || "";
    const sub = claims.sub || "";
    const tenantId = claims[TENANT_CLAIM] || "";
    if (ALLOWED_TENANTS.length && ALLOWED_TENANTS.indexOf(tenantId) === -1) {
      context.res = json(403, { error: "not a Broadway tenant", code: "WRONG_TENANT", tenantId });
      return;
    }

    let role = null, roleSource = "none";
    try { role = await fetchRole(token, sub, context.log); if (role) roleSource = "umbrava"; }
    catch (e) { /* identity still valid; role stays null */ }

    context.res = json(200, { ok: true, email: email, sub: sub, tenantId: tenantId, role: role, roleSource: roleSource, roleQuery: ROLE_QUERY ? ROLE_QUERY[0] : null });
  } catch (err) {
    context.log && context.log.error && context.log.error("user-role error:", String((err && err.message) || err));
    context.res = json(500, { error: "user-role failed" });
  }
};
