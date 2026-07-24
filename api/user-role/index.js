// Resolves the caller's Umbrava ROLE from the Umbrava access token a userscript sends, so
// role-based access can be TRULY enforced.
//
// The identity chain (token extraction -> pre-checks -> Umbrava GraphQL vouch -> tenant
// gate -> role rank) lives in ../shared/umbrava-auth.js since 2026-07-21 - it is shared
// with every role-enforcing endpoint (cc-purchase, cc-receipt, hvac-benchmark, send-bid).
// The full design rationale + the SWA-edge Authorization-overwrite post-mortem are in that
// module's header and the repo CLAUDE.md. This endpoint is the thin "what am I?" wrapper:
//
//   POST /api/user-role     header x-bwn-key: <WO_INGEST_KEY>
//        body { token }     (BODY, not Authorization - the SWA edge overwrites that header)
//        -> { ok, email, sub, tenantId, role, rank, tier, roleSource, roleQuery }
//
// `rank` (1 staff .. 5 director) + `tier` are the server-computed ladder position clients
// use for UX show/hide; the same numbers are what the enforcing endpoints check, so the
// client and server can never disagree about what a role name means.
//
// Reached ANONYMOUSLY at the SWA route layer (Umbrava is a different origin). Auth is
// layered: 1. shared key (x-bwn-key vs WO_INGEST_KEY) - coarse gate; 2. the Umbrava access
// token - the REAL identity, vouched by Umbrava's current-user API. NEVER stores or
// forwards the token.

const AUTH = require("../shared/umbrava-auth.js");

const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key, Authorization",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    // Coarse gate (same shared key as the rest of the suite; NOT the identity boundary).
    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    const keyed = AUTH.safeStrEqual(key, expected);

    // The Umbrava access token - BODY FIRST (the SWA edge overwrites Authorization with its
    // own platform token when proxying /api/*; proven 2026-07-21). Header parse remains only
    // as a fallback for non-proxied contexts. Extracted here (not just inside the shared
    // resolver) because the debug echo below reports on whatever the caller sent.
    const authz = req.headers && (req.headers["authorization"] || req.headers["Authorization"] || "");
    const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
    const bodyTok = String((req.body && (req.body.userToken || req.body.token)) || "");
    const token = bodyTok || (m ? m[1] : "");
    const tokenSource = bodyTok ? "body" : (m ? "auth-header" : "none");

    // Diagnostic echo (permanent - this is what exposed the SWA edge Authorization overwrite):
    // echoes header alg/kid/typ + the CLAIMS the pre-checks test (iss/aud/exp), NEVER the
    // signature. Runs BEFORE the key gate so an in-flight header rewrite can be detected from
    // any context: without the key it echoes ONLY what the caller itself sent (its own token's
    // header/claims) - nothing secret. Expected values + match verdicts stay key-gated.
    if (req.query && req.query.debug === "1") {
      const dp = String(token).split(".");
      const dh = dp.length >= 1 ? AUTH.b64urlJson(dp[0]) : null;
      const dc = dp.length >= 2 ? AUTH.b64urlJson(dp[1]) : null;
      const dAuds = dc ? (Array.isArray(dc.aud) ? dc.aud : [dc.aud]).map(AUTH.normUrl) : [];
      let dExp = null;   // guarded: a crafted out-of-range exp must not 500 the debug echo
      try { if (dc && typeof dc.exp === "number" && isFinite(dc.exp)) dExp = new Date(dc.exp * 1000).toISOString(); } catch (e) { }
      const echo = {
        debug: true, keyed: keyed, tokenSource: tokenSource,
        authPrefix: String(authz).slice(0, 14), tokenParts: dp.length,
        recvAlg: dh && dh.alg, recvKid: dh && dh.kid, recvTyp: dh && dh.typ,
        recvIss: (dc && dc.iss) || null, recvAud: (dc && dc.aud) || null, recvExp: dExp,
      };
      if (keyed) {
        echo.expectedIss = AUTH.ISSUERS; echo.expectedAud = AUTH.AUDS;
        echo.issMatch = !!dc && AUTH.ISSUERS.indexOf(AUTH.normUrl(dc.iss)) !== -1;
        echo.audMatch = dAuds.some(function (a) { return AUTH.AUDS.indexOf(a) !== -1; });
      }
      context.res = json(200, echo);
      return;
    }

    if (!keyed) { context.res = json(403, { error: "unauthorized" }); return; }

    // The full identity chain: token presence/shape, iss/aud/exp pre-checks, Umbrava vouch,
    // tenant gate, role rank. Error bodies carry the same stable codes as before
    // (NO_TOKEN / malformed / bad-iss / bad-aud / expired / not-vouched / WRONG_TENANT /
    // UMBRAVA_UNAVAILABLE / VOUCH_QUERY_DRIFT / BAD_UMBRAVA_GRAPHQL_URL).
    const auth = await AUTH.resolveUmbravaUser(req);
    if (!auth.ok) { context.res = json(auth.status, auth.body); return; }

    const u = auth.user;
    context.res = json(200, {
      ok: true, email: u.email, sub: u.sub, tenantId: u.tenantId,
      role: u.role, rank: u.rank, tier: u.tier,
      roleSource: u.role ? "umbrava" : "none", roleQuery: "me",
    });
  } catch (err) {
    context.log && context.log.error && context.log.error("user-role error:", String((err && err.message) || err));
    context.res = json(500, { error: "user-role failed" });
  }
};
