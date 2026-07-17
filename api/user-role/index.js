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

// Resolves the caller's Umbrava ROLE from the Umbrava access token a userscript sends, so
// role-based access can be TRULY enforced.
//
// Umbrava signs its access tokens with HS256 (symmetric) - verified live 2026-07 via the token
// header (alg:HS256). A symmetric token CANNOT be verified by a third party without Umbrava's
// signing secret (which we must never hold), so we do NOT verify the signature locally. Instead
// the token is PROVEN by asking Umbrava's OWN API to identify the caller: we POST the token to
// Umbrava's GraphQL current-user query. If Umbrava returns the caller's user, the token is valid
// (Umbrava verified the signature it owns); a forged / tampered / expired token is rejected by
// Umbrava and returns no user. Identity (email, sub, tenant) then comes from the token's own
// claims, which are authentic once Umbrava has vouched for the token (the HS256 signature Umbrava
// validated covers them) - a tampered claim would have broken the signature Umbrava just checked.
//
// Reached ANONYMOUSLY at the SWA route layer (Umbrava is a different origin). Auth is layered:
//   1. shared key (x-bwn-key vs WO_INGEST_KEY) - coarse gate, same as the rest of the suite
//   2. the Umbrava access token (Authorization: Bearer <token>) - the REAL identity, vouched by
//      Umbrava's current-user API using that same token.
//
// Verified live against a real Umbrava token (2026-07): iss https://login.umbrava.com/, aud is an
// ARRAY that includes https://app.umbrava.com/api, email in the namespaced claim
// https://umbrava.com/email, tenant in https://umbrava.com/tenantid, sub = "waad|...", alg HS256.
// Umbrava's currentUser exposes { id, role, tenantId, email } (confirmed via the read API).
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

// Decode (NOT verify) the token claims + cheap pre-checks. These only ever REJECT obviously-bad
// tokens cheaply (a forged token that fakes these still fails the Umbrava vouch below); they never
// grant access. Throws an Error whose message is a stable code.
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

// ---- Umbrava vouch: the token's signature is HS256 (Umbrava-only), so Umbrava is the verifier.
// The current-user root field isn't publicly documented; self-discover it once (a wrong name
// returns a fast GraphQL error/null, never a hang) and cache the winner. A returned user with a
// truthy id is the proof the token is valid AND identifies the caller.
let ROLE_QUERY = null;
const ROLE_CANDIDATES = [
  ["currentUser", "{ currentUser { id role } }"],
  ["me", "{ me { id role } }"],
  ["viewer", "{ viewer { id role } }"],
  ["currentMember", "{ currentMember { id role } }"],
  ["user", "{ user { id role } }"],
];
// { ok:true, user } if Umbrava accepts the token; { ok:false } if Umbrava rejects it (invalid
// token); throws "upstream" on network/5xx so the caller can 503 rather than falsely 401.
async function umbravaVouch(bearer) {
  const tries = ROLE_QUERY ? [ROLE_QUERY] : ROLE_CANDIDATES;
  let sawAuthFail = false, sawNet = false, saw200 = false;
  for (const [name, q] of tries) {
    let r;
    try { r = await httpsJson("POST", GRAPHQL_URL, { "Authorization": "Bearer " + bearer }, { query: q }); }
    catch (e) { sawNet = true; continue; }
    if (r.status === 401 || r.status === 403) { sawAuthFail = true; continue; }   // token rejected
    if (r.status < 200 || r.status >= 300) { sawNet = true; continue; }           // 5xx / gateway
    saw200 = true;
    const u = r.json && r.json.data && r.json.data[name];
    if (u && u.id) { ROLE_QUERY = [name, q]; return { ok: true, user: u }; }
    // 200 but no user: with the discovered root cached this means an invalid/anonymous token;
    // during first-time discovery it may just be a wrong root, so keep trying the others.
  }
  if (sawNet && !saw200 && !sawAuthFail) throw new Error("upstream");   // never reached Umbrava cleanly
  return { ok: false };
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

    // TEMP diagnostic (key-gated): echo header alg/kid/typ only, NEVER the signature.
    if (req.query && req.query.debug === "1") {
      const dp = String(token).split(".");
      const dh = dp.length >= 1 ? b64urlJson(dp[0]) : null;
      context.res = json(200, {
        debug: true, authPrefix: String(authz).slice(0, 14), tokenParts: dp.length,
        recvAlg: dh && dh.alg, recvKid: dh && dh.kid, recvTyp: dh && dh.typ,
      });
      return;
    }

    let claims;
    try { claims = decodeClaims(token); }
    catch (e) { context.res = json(401, { error: "invalid token", code: String((e && e.message) || "invalid") }); return; }

    // Prove the token with Umbrava (it owns the HS256 secret). This is the identity boundary.
    let vouch;
    try { vouch = await umbravaVouch(token); }
    catch (e) { context.res = json(503, { error: "identity provider unavailable", code: "UMBRAVA_UNAVAILABLE" }); return; }
    if (!vouch.ok) { context.res = json(401, { error: "token not accepted by Umbrava", code: "not-vouched" }); return; }

    // Identity from the token claims - authentic now that Umbrava has vouched for the signature.
    const email = claims[EMAIL_CLAIM] || claims.email || "";
    const sub = claims.sub || (vouch.user && vouch.user.id) || "";
    const tenantId = claims[TENANT_CLAIM] || "";
    // Fail CLOSED: a mis-set UMBRAVA_TENANTS (empty) denies everyone rather than admitting all tenants.
    if (!ALLOWED_TENANTS.length || ALLOWED_TENANTS.indexOf(tenantId) === -1) {
      context.res = json(403, { error: "not a Broadway tenant", code: "WRONG_TENANT", tenantId });
      return;
    }

    const role = (vouch.user && vouch.user.role) || null;
    context.res = json(200, { ok: true, email: email, sub: sub, tenantId: tenantId, role: role, roleSource: role ? "umbrava" : "none", roleQuery: ROLE_QUERY ? ROLE_QUERY[0] : null });
  } catch (err) {
    context.log && context.log.error && context.log.error("user-role error:", String((err && err.message) || err));
    context.res = json(500, { error: "user-role failed" });
  }
};
