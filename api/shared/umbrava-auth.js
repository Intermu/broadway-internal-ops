const https = require("https");
const crypto = require("crypto");

// Constant-time string compare for shared-secret checks (the x-bwn-key gate). Both sides
// are hashed to a fixed 32 bytes first, so this is length-agnostic and does not leak length
// via early return the way `a !== b` (or a raw timingSafeEqual with a length pre-check) can.
// Returns false for any non-string input. Use for `key === expected` style secret checks.
function safeStrEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Shared Umbrava identity + role enforcement for the connector Functions.
//
// This is the ONE implementation of the proven user-role vouch chain (2026-07-21 saga,
// see api/user-role and the repo CLAUDE.md), factored out so any endpoint can TRULY
// enforce a caller's Umbrava role server-side instead of trusting the shared x-bwn-key
// alone. api/user-role, api/cc-purchase, api/cc-receipt, api/hvac-benchmark and
// api/send-bid all consume it.
//
// Non-negotiables baked in (do not "fix" these without re-reading the post-mortem):
//   - The SWA edge OVERWRITES the Authorization header on every proxied /api/* request
//     with its own platform token (iss *.scm.azurewebsites.net). Caller tokens therefore
//     ride in the JSON BODY ({ token } or { userToken }); the header parse is only a
//     fallback for non-proxied contexts.
//   - The token signature is NEVER verified locally (no JWKS, no shared secret). It is
//     PROVEN by POSTing it to Umbrava's own GraphQL current-user query - if Umbrava
//     answers with the caller's user, the token is valid. Rotation-proof by design.
//   - The vouch query is the schema-verified `me` shape. currentUser/viewer/currentMember
//     do NOT exist; bare `user` requires an id argument; the role is an OBJECT at
//     me.profile.role { id name } with free-text names.
//   - Umbrava wraps GraphQL auth failures as HTTP 500 + errors[].extensions.code
//     UNAUTHENTICATED. Classify vouch responses by error CONTENT first, status second,
//     or an invalid token reads as an outage.
//   - iss/aud are cheap PRE-checks only; the CSV app settings UMBRAVA_ISS / UMBRAVA_AUD
//     EXTEND the baked-in defaults (union), never replace them.
//   - Tenant gate fails CLOSED and compares case-insensitively; the Umbrava-returned
//     me.tenantId is preferred, the signed claim is an accepted fallback.
//
// ROLE LADDER. Umbrava roles are free text. The ladder below was built from the LIVE
// member directory (broad sweep via the Umbrava read API, 2026-07-21, ~140 members) -
// these are real role names, not guesses:
//   staff(1):      Operations Coordinator, On Call Coordinator, Vendor Management
//                  Coordinator, Account Executive, Construction PM, Construction +
//                  Service, Projects Signage, New Account Team, Sales, Billing,
//                  Analytics, Reception, Marketing, Vendor Compliance, Vendor
//                  Management MGMT, Admin (+ any unrecognized role - a vouched
//                  Broadway user is at least staff, never more)
//   lead(2):       Lead Operations Coordinator
//   supervisor(3): National Account Supervisor, On Call Supervisor
//   manager(4):    National Account Manager, Billing Manager
//   director(5):   Director
// Unlisted names fall back to keyword inference (director/VP > manager > supervisor >
// lead) so a new title like "Regional Operations Supervisor" ranks sensibly without a
// deploy. Inference was CHECKED against the full live directory: no current title
// over-ranks ("Construction PM" and "Vendor Management MGMT" match no keyword -> staff,
// which fails CLOSED; raise them via the app setting if that's ever wrong). The app
// setting UMBRAVA_ROLE_RANKS ("Some Role=3,Other Role=4") extends or overrides the
// exact map for anything the keywords get wrong.
// Names are normalized (trim, collapse spaces, lowercase) - the live directory contains
// roles with trailing spaces ("Vendor Management Coordinator ", "Vendor Management MGMT ").

// ---- HTTP via `https` (the SWA Functions runtime does not expose global fetch) --------
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

// ---- Config (union-extended by app settings, never replaced) ---------------------------
function normUrl(s) { return String(s || "").trim().replace(/\/+$/, ""); }
function unionCsv(defaults, envVal) {
  return defaults.concat(String(envVal || "").split(",")).map(normUrl).filter(Boolean)
    .filter(function (v, i, a) { return a.indexOf(v) === i; });
}
const ISSUERS = unionCsv(["https://login.umbrava.com/", "https://umbrava.us.auth0.com/"], process.env.UMBRAVA_ISS);
const AUDS = unionCsv(["https://app.umbrava.com/api"], process.env.UMBRAVA_AUD);
const GRAPHQL_URL = process.env.UMBRAVA_GRAPHQL || "https://app.umbrava.com/api/graphql";
const EMAIL_CLAIM = "https://umbrava.com/email";
const TENANT_CLAIM = "https://umbrava.com/tenantid";
const ALLOWED_TENANTS = (process.env.UMBRAVA_TENANTS ||
  "42726f61-6477-6179-4e61-74696f6e616c,2fc24a61-4adf-41b0-a0f0-5c50fb9a862b")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const CLOCK_SKEW_S = 60;

// ---- Role ladder ------------------------------------------------------------------------
const RANK = { STAFF: 1, LEAD: 2, SUPERVISOR: 3, MANAGER: 4, DIRECTOR: 5 };
const TIER_NAME = { 1: "staff", 2: "lead", 3: "supervisor", 4: "manager", 5: "director" };
const ROLE_RANKS = {
  "operations coordinator": RANK.STAFF,
  "on call coordinator": RANK.STAFF,
  "vendor management coordinator": RANK.STAFF,
  "account executive": RANK.STAFF,
  "construction pm": RANK.STAFF,
  "construction + service": RANK.STAFF,
  "projects signage": RANK.STAFF,
  "new account team": RANK.STAFF,
  "sales": RANK.STAFF,
  "billing": RANK.STAFF,
  "analytics": RANK.STAFF,
  "reception": RANK.STAFF,
  "marketing": RANK.STAFF,
  "vendor compliance": RANK.STAFF,
  "vendor management mgmt": RANK.STAFF,
  "admin": RANK.STAFF,
  "lead operations coordinator": RANK.LEAD,
  "national account supervisor": RANK.SUPERVISOR,
  "on call supervisor": RANK.SUPERVISOR,
  "billing manager": RANK.MANAGER,
  "national account manager": RANK.MANAGER,
  "director": RANK.DIRECTOR,
};
// UMBRAVA_ROLE_RANKS = "Some New Role=3,Another Role=4" - extends/overrides the exact map.
(function () {
  String(process.env.UMBRAVA_ROLE_RANKS || "").split(",").forEach(function (pair) {
    const i = pair.indexOf("=");
    if (i < 1) return;
    const name = normRole(pair.slice(0, i));
    const rank = parseInt(pair.slice(i + 1), 10);
    if (name && rank >= RANK.STAFF && rank <= RANK.DIRECTOR) ROLE_RANKS[name] = rank;
  });
})();
function normRole(name) { return String(name || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function rankOfRole(roleName) {
  const n = normRole(roleName);
  if (!n) return RANK.STAFF;                       // vouched Broadway user, no role name: still staff
  if (ROLE_RANKS[n] != null) return ROLE_RANKS[n];
  // Keyword inference for unlisted titles - highest tier the title claims wins.
  if (/\b(director|vp|vice president|president|owner)\b/.test(n)) return RANK.DIRECTOR;
  if (/\bmanager\b/.test(n)) return RANK.MANAGER;
  if (/\bsupervisor\b/.test(n)) return RANK.SUPERVISOR;
  if (/\blead\b/.test(n)) return RANK.LEAD;
  return RANK.STAFF;
}
function tierOfRank(rank) { return TIER_NAME[rank] || "staff"; }

// ---- Token pre-checks (cheap REJECTS only; never grant) ---------------------------------
function b64urlToBuf(s) { return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"); }
function b64urlJson(s) { try { return JSON.parse(b64urlToBuf(s).toString("utf-8")); } catch (e) { return null; } }
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

// ---- Umbrava vouch (the real identity boundary) ------------------------------------------
const VOUCH_QUERY = "{ me { id tenantId profile { id role { id name } } } }";
async function umbravaVouch(bearer) {
  let r;
  try { r = await httpsJson("POST", GRAPHQL_URL, { "Authorization": "Bearer " + bearer }, { query: VOUCH_QUERY }); }
  catch (e) {
    throw new Error(String((e && e.message) || "") === "bad-url" ? "config" : "upstream");
  }
  const me = r.json && r.json.data && r.json.data.me;
  if (me && me.id) {
    const role = (me.profile && me.profile.role && me.profile.role.name) || null;
    return { ok: true, user: { id: me.id, role: role, tenantId: me.tenantId || "" } };
  }
  const errs = (r.json && r.json.errors) || [];
  const codes = errs.map(function (e) { return String((e && e.extensions && e.extensions.code) || "").toUpperCase(); });
  if (codes.indexOf("UNAUTHENTICATED") !== -1 || codes.indexOf("FORBIDDEN") !== -1 ||
      r.status === 401 || r.status === 403) return { ok: false };            // token rejected
  if (errs.length || r.status === 400) throw new Error("vouch-query");       // schema/validation drift
  if (r.status >= 200 && r.status < 300) return { ok: false };               // anonymous 2xx: invalid token
  throw new Error("upstream");                                               // 5xx / gateway, no signal
}

// ---- The one entry point endpoints use ---------------------------------------------------
// Extracts the caller token (body.userToken || body.token first, Authorization fallback),
// pre-checks it, vouches it with Umbrava, applies the tenant gate, and resolves the role
// rank. Does NOT do the x-bwn-key gate (each endpoint keeps its own) and does NOT build
// the HTTP response (each endpoint wraps status/body in its own CORS json()).
//
// Returns { ok:true, user:{ email, sub, tenantId, role, rank, tier }, tokenSource }
//      or { ok:false, status, body } - body always carries a stable `code`:
//        401 NO_TOKEN | malformed | bad-iss | bad-aud | expired | not-vouched
//        403 WRONG_TENANT
//        503 UMBRAVA_UNAVAILABLE | VOUCH_QUERY_DRIFT | BAD_UMBRAVA_GRAPHQL_URL
async function resolveUmbravaUser(req) {
  const authz = (req && req.headers && (req.headers["authorization"] || req.headers["Authorization"])) || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
  const body = (req && req.body && typeof req.body === "object") ? req.body : {};
  const bodyTok = String(body.userToken || body.token || "");
  const token = bodyTok || (m ? m[1] : "");
  const tokenSource = bodyTok ? "body" : (m ? "auth-header" : "none");
  if (!token) return { ok: false, status: 401, body: { error: "no token", code: "NO_TOKEN" } };

  // A JWT is dot-separated base64url. Anything else is malformed AND unsafe to forward in
  // an outbound Authorization header (an embedded newline makes https.request throw
  // ERR_INVALID_CHAR and misreads a client fault as an Umbrava outage).
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) {
    return { ok: false, status: 401, body: { error: "invalid token", code: "malformed" } };
  }

  let claims;
  try { claims = decodeClaims(token); }
  catch (e) {
    const b = { error: "invalid token", code: String((e && e.message) || "invalid") };
    if (e && e.detail) b.detail = e.detail;
    return { ok: false, status: 401, body: b };
  }

  let vouch;
  try { vouch = await umbravaVouch(token); }
  catch (e) {
    const why = String((e && e.message) || "");
    return {
      ok: false, status: 503, body: {
        error: "identity provider unavailable",
        code: why === "vouch-query" ? "VOUCH_QUERY_DRIFT" : why === "config" ? "BAD_UMBRAVA_GRAPHQL_URL" : "UMBRAVA_UNAVAILABLE",
      },
    };
  }
  if (!vouch.ok) return { ok: false, status: 401, body: { error: "token not accepted by Umbrava", code: "not-vouched" } };

  // Identity from the claims - authentic now that Umbrava vouched for the signature.
  const email = String(claims[EMAIL_CLAIM] || claims.email || "").trim().toLowerCase();
  const sub = claims.sub || (vouch.user && vouch.user.id) || "";
  const vouchTenant = String((vouch.user && vouch.user.tenantId) || "");
  const claimTenant = String(claims[TENANT_CLAIM] || "");
  const tenantId = vouchTenant || claimTenant;
  // Fail CLOSED: an empty UMBRAVA_TENANTS denies everyone rather than admitting all tenants.
  const tenantOk = ALLOWED_TENANTS.length && [vouchTenant, claimTenant].some(function (t) {
    return t && ALLOWED_TENANTS.indexOf(t.toLowerCase()) !== -1;
  });
  if (!tenantOk) {
    return { ok: false, status: 403, body: { error: "not a Broadway tenant", code: "WRONG_TENANT", tenantId: tenantId } };
  }

  const role = (vouch.user && vouch.user.role) || null;
  const rank = rankOfRole(role);
  return {
    ok: true, tokenSource: tokenSource,
    user: { email: email, sub: sub, tenantId: tenantId, role: role, rank: rank, tier: tierOfRank(rank) },
  };
}

// Standard 403 body for an insufficient rank - one shape everywhere so clients can key on
// code ROLE_REQUIRED. `required` names the minimum tier, `role`/`tier` echo the caller's.
function roleDeniedBody(user, minRank) {
  return {
    error: "requires " + tierOfRank(minRank) + " level or above",
    code: "ROLE_REQUIRED",
    role: (user && user.role) || null,
    tier: (user && user.tier) || null,
    required: tierOfRank(minRank),
  };
}

module.exports = {
  RANK: RANK,
  safeStrEqual: safeStrEqual,
  ISSUERS: ISSUERS,
  AUDS: AUDS,
  normUrl: normUrl,
  b64urlJson: b64urlJson,
  normRole: normRole,
  rankOfRole: rankOfRole,
  tierOfRank: tierOfRank,
  decodeClaims: decodeClaims,
  umbravaVouch: umbravaVouch,
  resolveUmbravaUser: resolveUmbravaUser,
  roleDeniedBody: roleDeniedBody,
};
