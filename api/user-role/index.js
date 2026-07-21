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
// Umbrava ROTATES its token signing: HS256 (symmetric, no kid) observed early 2026-07, RS256
// (kid present) observed 2026-07-21. We never verify the signature locally (no JWKS, no shared
// secret - Hard Rule 2), which also makes this function alg-rotation-proof. Instead the token is
// PROVEN by asking Umbrava's OWN API to identify the caller: we POST the token to Umbrava's
// GraphQL current-user query. If Umbrava returns the caller's user, the token is valid (Umbrava
// verified the signature it owns); a forged / tampered / expired token is rejected by Umbrava
// and returns no user. Identity (email, sub, tenant) then comes from the token's own claims,
// which are authentic once Umbrava has vouched for the token (the signature Umbrava validated
// covers them) - a tampered claim would have broken the signature Umbrava just checked.
//
// Reached ANONYMOUSLY at the SWA route layer (Umbrava is a different origin). Auth is layered:
//   1. shared key (x-bwn-key vs WO_INGEST_KEY) - coarse gate, same as the rest of the suite
//   2. the Umbrava access token (Authorization: Bearer <token>) - the REAL identity, vouched by
//      Umbrava's current-user API using that same token.
//
// Verified live against a real Umbrava token (2026-07-21): iss https://login.umbrava.com/, aud is
// an ARRAY that includes https://app.umbrava.com/api, email in the namespaced claim
// https://umbrava.com/email, tenant in https://umbrava.com/tenantid, sub = "waad|...", alg RS256.
// The current-user query shape was schema-verified live 2026-07-21 (see VOUCH_QUERY below):
// there is NO top-level currentUser/viewer/currentMember field, `user` requires an id argument,
// and the role is an OBJECT at me.profile.role { id name } (free-text names, e.g.
// "National Account Manager").
//
// Returns { ok, email, sub, tenantId, role, roleSource }. NEVER stores or forwards the token.

// iss/aud are cheap pre-checks only - the vouch below is the real boundary - so both compare
// trimmed and with trailing slashes stripped (an app-setting near-miss like a missing "/" must
// not 401), and the CSV app settings EXTEND the baked-in defaults rather than replace them
// (a stale single-value UMBRAVA_ISS left in Azure must not silently disable a known issuer).
function normUrl(s) { return String(s || "").trim().replace(/\/+$/, ""); }
function unionCsv(defaults, envVal) {
  return defaults.concat(String(envVal || "").split(",")).map(normUrl).filter(Boolean)
    .filter(function (v, i, a) { return a.indexOf(v) === i; });
}
// Umbrava's Auth0 issuers: custom domain + raw tenant domain (both observed live 2026-07).
const ISSUERS = unionCsv(["https://login.umbrava.com/", "https://umbrava.us.auth0.com/"], process.env.UMBRAVA_ISS);
const AUDS = unionCsv(["https://app.umbrava.com/api"], process.env.UMBRAVA_AUD);
const GRAPHQL_URL = process.env.UMBRAVA_GRAPHQL || "https://app.umbrava.com/api/graphql";
const EMAIL_CLAIM = "https://umbrava.com/email";
const TENANT_CLAIM = "https://umbrava.com/tenantid";
// Broadway's own Umbrava tenants (home + the Maintenance LLC). Users outside these are valid
// Umbrava logins (clients/vendors) but not Broadway staff, so they get no role here.
// Compared case-insensitively (GUID casing must not matter).
const ALLOWED_TENANTS = (process.env.UMBRAVA_TENANTS ||
  "42726f61-6477-6179-4e61-74696f6e616c,2fc24a61-4adf-41b0-a0f0-5c50fb9a862b")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
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
  if (ISSUERS.indexOf(normUrl(claims.iss)) === -1) {
    const e = new Error("bad-iss"); e.detail = { iss: claims.iss || null, expected: ISSUERS }; throw e;
  }
  const auds = (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).map(normUrl);
  if (!auds.some(function (a) { return AUDS.indexOf(a) !== -1; })) {
    const e = new Error("bad-aud"); e.detail = { aud: claims.aud || null, expected: AUDS }; throw e;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_SKEW_S) throw new Error("expired");
  return claims;
}

// ---- Umbrava vouch: Umbrava owns the token signature (whatever alg it rotates to), so Umbrava
// is the verifier. The query is the live-verified current-user shape (schema-introspected
// 2026-07-21): the ONLY no-arg current-user root is `me` (CurrentUserProfile), and the role is
// an object at me.profile.role. The old guessed candidates (currentUser/viewer/currentMember/
// bare user) all 400 against the real schema. A returned me with a truthy id is the proof the
// token is valid AND identifies the caller.
const VOUCH_QUERY = "{ me { id tenantId profile { id role { id name } } } }";
// { ok:true, user:{ id, role, tenantId } } if Umbrava accepts the token; { ok:false } if Umbrava
// rejects it (401/403 or an anonymous 200). Throws "upstream" on network/5xx and "vouch-query"
// on a GraphQL validation 400 (schema drift - not the caller's fault) so the handler can 503
// rather than falsely 401.
async function umbravaVouch(bearer) {
  let r;
  try { r = await httpsJson("POST", GRAPHQL_URL, { "Authorization": "Bearer " + bearer }, { query: VOUCH_QUERY }); }
  catch (e) { throw new Error("upstream"); }
  const me = r.json && r.json.data && r.json.data.me;
  if (me && me.id) {
    const role = (me.profile && me.profile.role && me.profile.role.name) || null;
    return { ok: true, user: { id: me.id, role: role, tenantId: me.tenantId || "" } };
  }
  // No user. Classify by GraphQL error CONTENT first, HTTP status second: Umbrava wraps auth
  // failures as HTTP 500 + errors[].extensions.code "UNAUTHENTICATED" (verified live 2026-07-21
  // with a garbage token), so status alone would misread an invalid token as an outage.
  const errs = (r.json && r.json.errors) || [];
  const codes = errs.map(function (e) { return String((e && e.extensions && e.extensions.code) || "").toUpperCase(); });
  if (codes.indexOf("UNAUTHENTICATED") !== -1 || codes.indexOf("FORBIDDEN") !== -1 ||
      r.status === 401 || r.status === 403) return { ok: false };            // token rejected
  if (errs.length || r.status === 400) throw new Error("vouch-query");       // schema/validation drift
  if (r.status >= 200 && r.status < 300) return { ok: false };               // anonymous 2xx: invalid token
  throw new Error("upstream");                                               // 5xx / gateway, no signal
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

    // TEMP diagnostic (key-gated): echo header alg/kid/typ + the CLAIMS the pre-checks test
    // (iss/aud/exp, plus what this deployment expects), NEVER the signature. Claims are the
    // caller's own token contents, so echoing them back to the key-holding caller leaks nothing.
    if (req.query && req.query.debug === "1") {
      const dp = String(token).split(".");
      const dh = dp.length >= 1 ? b64urlJson(dp[0]) : null;
      const dc = dp.length >= 2 ? b64urlJson(dp[1]) : null;
      const dAuds = dc ? (Array.isArray(dc.aud) ? dc.aud : [dc.aud]).map(normUrl) : [];
      let dExp = null;   // guarded: a crafted out-of-range exp must not 500 the debug echo
      try { if (dc && typeof dc.exp === "number" && isFinite(dc.exp)) dExp = new Date(dc.exp * 1000).toISOString(); } catch (e) { }
      context.res = json(200, {
        debug: true, authPrefix: String(authz).slice(0, 14), tokenParts: dp.length,
        recvAlg: dh && dh.alg, recvKid: dh && dh.kid, recvTyp: dh && dh.typ,
        recvIss: (dc && dc.iss) || null, recvAud: (dc && dc.aud) || null, recvExp: dExp,
        expectedIss: ISSUERS, expectedAud: AUDS,
        issMatch: !!dc && ISSUERS.indexOf(normUrl(dc.iss)) !== -1,
        audMatch: dAuds.some(function (a) { return AUDS.indexOf(a) !== -1; }),
      });
      return;
    }

    let claims;
    try { claims = decodeClaims(token); }
    catch (e) {
      const body = { error: "invalid token", code: String((e && e.message) || "invalid") };
      if (e && e.detail) body.detail = e.detail;   // e.g. bad-iss: { iss: <received>, expected: [...] }
      context.res = json(401, body); return;
    }

    // Prove the token with Umbrava (it owns the signing secret/key). This is the identity boundary.
    let vouch;
    try { vouch = await umbravaVouch(token); }
    catch (e) {
      const drift = String((e && e.message) || "") === "vouch-query";
      context.res = json(503, { error: "identity provider unavailable", code: drift ? "VOUCH_QUERY_DRIFT" : "UMBRAVA_UNAVAILABLE" });
      return;
    }
    if (!vouch.ok) { context.res = json(401, { error: "token not accepted by Umbrava", code: "not-vouched" }); return; }

    // Identity from the token claims - authentic now that Umbrava has vouched for the signature.
    // Tenant: prefer what Umbrava itself just returned (me.tenantId); claim is the fallback.
    // Both are authentic (one vouched, one signature-covered), so EITHER matching the allow-list
    // passes; compared case-insensitively.
    const email = claims[EMAIL_CLAIM] || claims.email || "";
    const sub = claims.sub || (vouch.user && vouch.user.id) || "";
    const vouchTenant = String((vouch.user && vouch.user.tenantId) || "");
    const claimTenant = String(claims[TENANT_CLAIM] || "");
    const tenantId = vouchTenant || claimTenant;
    // Fail CLOSED: a mis-set UMBRAVA_TENANTS (empty) denies everyone rather than admitting all tenants.
    const tenantOk = ALLOWED_TENANTS.length && [vouchTenant, claimTenant].some(function (t) {
      return t && ALLOWED_TENANTS.indexOf(t.toLowerCase()) !== -1;
    });
    if (!tenantOk) {
      context.res = json(403, { error: "not a Broadway tenant", code: "WRONG_TENANT", tenantId });
      return;
    }

    const role = (vouch.user && vouch.user.role) || null;
    context.res = json(200, { ok: true, email: email, sub: sub, tenantId: tenantId, role: role, roleSource: role ? "umbrava" : "none", roleQuery: "me" });
  } catch (err) {
    context.log && context.log.error && context.log.error("user-role error:", String((err && err.message) || err));
    context.res = json(500, { error: "user-role failed" });
  }
};
