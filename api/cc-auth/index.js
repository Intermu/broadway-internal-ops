const https = require("https");
const { URL } = require("url");
const AUTH = require("../shared/umbrava-auth.js");

// CC Authorization proxy for the BWN userscript connector (forms-to-userscripts pilot).
//
// This is the COORDINATOR REQUEST half of the two-form CC split (sibling of /api/cc-purchase):
//   - CC Authorization (this) = a coordinator asks management to make a card purchase for them.
//     Request -> Power Automate `Start and wait for an approval` (mnajarro@, GKohlmann@,
//     LPorzelt@) -> on approve, a reply email to the requester (BCC mnajarro@, High).
//   - Log CC Purchase (/api/cc-purchase) = a SUPERVISOR+ logs a purchase actually made.
//
// The BWN CC-Authorization modal runs inside app.umbrava.com - a DIFFERENT origin that is NOT
// federated to Broadway's Entra tenant, so (exactly like /api/cc-purchase and /api/wo-ingest)
// it cannot present the AAD principal the rest of /api/* relies on. This endpoint is therefore
// reachable ANONYMOUSLY at the SWA route layer (see staticwebapp.config.json) and gates itself
// with the shared connector FUNCTION KEY (app setting WO_INGEST_KEY, sent as `x-bwn-key`) - the
// SAME key the rest of the connector already uses.
//
// It holds the SAS-signed Power Automate trigger URL server-side (app setting CC_AUTH_FLOW_URL)
// and forwards a validated, whitelisted body to it. That URL is a secret (Who-can-trigger =
// Anyone; the sig is the only gate) and MUST NEVER ship in the GitHub-synced userscript -
// proxying here is the whole point. The flow ("CC Authorization (HTTP)") then runs the approval
// and, on approve, emails the requester - identically to the old Forms flow.
//
//   POST /api/cc-auth   header x-bwn-key: <WO_INGEST_KEY>
//        body { userToken, Date, Tracking, SupplierName, PurchaseLink, LineItemDescription,
//               TotalCost, ShippingAddress }
//        -> { ok:true } on a 2xx from the flow
//
// ROLE ENFORCEMENT (2026-07-21): requesting an authorization is a COORDINATOR action - any
// vouched Broadway Umbrava user (staff and up). So unlike /api/cc-purchase there is NO minimum
// rank beyond a successful vouch. The caller sends their Umbrava access token as `userToken` in
// the BODY (the SWA edge overwrites the Authorization header - repo CLAUDE.md); the shared
// module proves it with Umbrava's own current-user API and applies the Broadway tenant gate.
// The VERIFIED email (never a client-supplied field) becomes RequesterEmail - the flow uses it
// as the approval Requestor, the reply-email To, and in the approval/email titles, so it MUST
// be the authenticated identity, not spoofable input.
//
// Fails CLOSED: 503 if the key or the flow URL is not configured (or Umbrava is unreachable
// for the vouch), 403 on a missing/wrong key (NOT 401 for the key - staticwebapp.config.json's
// responseOverrides rewrite 401s into a login redirect a client would misread as 200 success;
// token faults do return 401 with a stable `code`), 400 on invalid input, 502 if the flow
// itself rejects the forward.

// CORS is belt-and-suspenders: Tampermonkey's GM_xmlhttpRequest bypasses same-origin (that's
// what @connect authorizes), so these aren't strictly needed - but they scope any normal-fetch
// caller to the Umbrava origin. Mirrors cc-purchase / wo-ingest.
const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

// The flow's HTTP trigger expects a FLAT JSON body with exactly these 8 string props (schema
// captured 2026-07-21: Date, Tracking, SupplierName, PurchaseLink, LineItemDescription,
// TotalCost, ShippingAddress, RequesterEmail). The 7 below come from the request body; the 8th,
// RequesterEmail, is injected server-side from the VERIFIED identity (see header). Anything else
// in the request body is ignored. `required` = the minimum for a meaningful authorization
// request; the modal does the real UX validation, this is the server backstop. `money` values
// are normalised to a bare numeric string so the approval/email render like the Forms flow did.
const FIELDS = [
  { key: "Date", max: 40, required: true },
  { key: "Tracking", max: 64, required: true },
  { key: "SupplierName", max: 300, required: true },
  { key: "PurchaseLink", max: 2000, url: true },
  { key: "LineItemDescription", max: 4000, required: true },
  { key: "TotalCost", max: 40, money: true, required: true },
  { key: "ShippingAddress", max: 1000 },
];

// Best-effort in-memory throttle. Azure Functions reuses the process between invocations, so
// this genuinely slows a runaway/looping client - but instances recycle and scale out, so it's
// a courtesy cap, NOT a security control (the x-bwn-key gate is that). Keyed by verified actor;
// 20 requests / 60s.
const RL_WINDOW_MS = 60000;
const RL_MAX = 20;
const rlHits = new Map();
function rateLimited(actor) {
  const now = Date.now();
  const arr = (rlHits.get(actor) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) { rlHits.set(actor, arr); return true; }
  arr.push(now);
  rlHits.set(actor, arr);
  if (rlHits.size > 500) {   // opportunistic GC so the map can't grow unbounded
    for (const k of Array.from(rlHits.keys())) {
      if (!(rlHits.get(k) || []).some((t) => now - t < RL_WINDOW_MS)) rlHits.delete(k);
      if (rlHits.size <= 500) break;
    }
  }
  return false;
}

// Forward to the (fixed, server-held) flow URL. The host/path come from CC_AUTH_FLOW_URL,
// NOT from the caller, so there is no SSRF surface. Mirrors cc-purchase.
function postToFlow(flowUrl, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(flowUrl); } catch (e) { reject(new Error("bad flow url")); return; }
    if (u.protocol !== "https:") { reject(new Error("flow url must be https")); return; }
    const req = https.request(
      {
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d; if (buf.length > 262144) { req.destroy(); reject(new Error("flow response too large")); } });
        res.on("end", () => resolve({ status: res.statusCode, raw: buf }));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs || 20000, () => { req.destroy(); reject(new Error("flow timeout")); });
    req.write(bodyStr);
    req.end();
  });
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    // -- Key gate (fail closed) -------------------------------------------------
    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "connector not configured" }); return; }
    // 403, NOT 401: responseOverrides turns 401s into a 302 to the AAD login page, which a
    // redirect-following client would read as 200 HTML success. 403 passes through untouched.
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!AUTH.safeStrEqual(key, expected)) { context.res = json(403, { error: "unauthorized" }); return; }

    // -- Identity gate (the REAL boundary; the key above is coarse) --------------
    // Vouched with Umbrava via the shared module. ANY vouched Broadway user may request an
    // authorization (coordinator action) - no minimum rank beyond a successful vouch.
    const auth = await AUTH.resolveUmbravaUser(req);
    if (!auth.ok) { context.res = json(auth.status, auth.body); return; }

    // -- Flow URL must be present (fail closed) ---------------------------------
    const flowUrl = process.env.CC_AUTH_FLOW_URL;
    if (!flowUrl) { context.res = json(503, { error: "flow endpoint not configured" }); return; }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    // The VERIFIED identity is the requester. Never a client-supplied field (spoofable) - the
    // approval reply email is sent To this address, so it MUST be the authenticated user.
    const actor = auth.user.email || auth.user.sub || "verified-unknown";
    if (rateLimited(actor)) { context.res = json(429, { error: "rate limited; slow down" }); return; }

    // -- Validate + whitelist the 7 body fields ---------------------------------
    const out = {};
    const missing = [];
    for (const f of FIELDS) {
      let v = body[f.key];
      v = (v == null) ? "" : String(v).trim();
      if (f.money && v) v = v.replace(/[^0-9.\-]/g, "");        // "$1,234.50" -> "1234.50"
      if (v.length > f.max) v = v.slice(0, f.max);
      if (f.url && v) {
        if (!/^https?:\/\//i.test(v)) { context.res = json(400, { error: "PurchaseLink must be an http(s) URL" }); return; }
      }
      if (f.required && !v) missing.push(f.key);
      out[f.key] = v;                                           // always send all props (blank if absent), matching the flow schema
    }
    if (missing.length) { context.res = json(400, { error: "missing required field(s): " + missing.join(", ") }); return; }

    // The 8th prop - server-injected from the vouched identity, not from the body.
    if (!auth.user.email) context.log.warn("cc-auth: vouched user has no email claim; RequesterEmail falls back to sub");
    out.RequesterEmail = actor;

    const outBody = JSON.stringify(out);
    // Log actor + a few non-sensitive facts for the App Insights trail. NEVER log flowUrl,
    // the key, or the full body.
    context.log("cc-auth forward", actor, out.SupplierName, out.TotalCost, out.Tracking);

    const flowRes = await postToFlow(flowUrl, outBody, 20000);
    // The Power Automate HTTP trigger returns 202 Accepted on a successful queue. Treat any
    // 2xx as success. Don't leak the flow's raw body upward (it can carry run metadata).
    if (flowRes.status >= 200 && flowRes.status < 300) {
      context.res = json(200, { ok: true });
      return;
    }
    context.log.warn("cc-auth flow rejected", flowRes.status);
    context.res = json(502, { ok: false, error: "flow rejected the request (" + flowRes.status + ")" });
  } catch (err) {
    context.log.error("cc-auth error:", err && err.message ? err.message : err);
    context.res = json(500, { error: "cc-auth error" });
  }
};
