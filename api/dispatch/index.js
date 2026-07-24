const https = require("https");
const { URL } = require("url");
const AUTH = require("../shared/umbrava-auth.js");

// WO Dispatch proxy for the BWN userscript connector (forms-to-userscripts pilot).
//
// The BWN Dispatch modal runs inside app.umbrava.com - a DIFFERENT origin that is NOT
// federated to Broadway's Entra tenant, so (exactly like /api/wo-ingest and /api/cc-purchase)
// it cannot present the AAD principal the rest of /api/* relies on. This endpoint is therefore
// reachable ANONYMOUSLY at the SWA route layer (see staticwebapp.config.json) and gates itself
// with the shared connector FUNCTION KEY (app setting WO_INGEST_KEY, sent as `x-bwn-key`) - the
// SAME key the rest of the connector already uses, so coordinators who set their Tampermonkey
// "ingest key" once need no new secret.
//
// It holds the SAS-signed Power Automate trigger URL server-side (app setting DISPATCH_FLOW_URL)
// and forwards a validated, whitelisted 5-field JSON body to it. That URL is a secret
// (Who-can-trigger = Anyone; the sig is the only gate) and MUST NEVER ship in the GitHub-synced
// userscript - proxying here is the whole point. The Dispatch HTTP flow then Adds a row to
// Dispatch_Notifications.xlsx (tblDispatch) AND dispatches it: posts a Teams adaptive card to the
// coordinator and waits for their response.
//
//   POST /api/dispatch   header x-bwn-key: <WO_INGEST_KEY>
//        body { actor?, AssignedToName, AssigneeEmail, Tracking, Location, Priority }
//        -> { ok:true } on a 2xx from the flow (the HTTP trigger returns 202 immediately;
//           the hours-long card wait runs async after that)
//
// NO role gate (unlike cc-purchase): dispatching a WO is a COORDINATOR action, not a
// Supervisor+ one - the x-bwn-key IS the boundary. The self-declared `actor` (NOT verified,
// like wo-ingest) is used only for the App Insights trail + the courtesy rate-limit.
//
// Fails CLOSED: 503 if the key or the flow URL is not configured, 403 on a missing/wrong key
// (NOT 401 for the key - staticwebapp.config.json's responseOverrides rewrite 401s into a login
// redirect, which a client chasing redirects would misread as a 200 success), 400 on invalid
// input, 429 when rate-limited, 502 if the flow itself rejects the forward.

// CORS is belt-and-suspenders: Tampermonkey's GM_xmlhttpRequest bypasses same-origin (that's
// what @connect authorizes), so these aren't strictly needed - but they scope any normal-fetch
// caller to the Umbrava origin. Mirrors wo-ingest / cc-purchase.
const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

// The Dispatch HTTP trigger expects a FLAT JSON body with exactly these 5 string props (schema
// captured 2026-07-21, re-verified 2026-07-23). Anything else in the request body is ignored -
// only this whitelist is forwarded. `required` = what the flow cannot function without or degrades
// on: AssigneeEmail feeds Get-user-profile (V2), which REJECTS a blank UPN; Tracking is the key
// the Condition matches the newest queued row on; AssignedToName + Location feed the card @mention
// and site lookup. Priority is optional - the card's else-branch color-codes a blank as warning.
// The modal does the real UX validation; this is the server backstop.
const FIELDS = [
  { key: "AssignedToName", max: 200, required: true },
  { key: "AssigneeEmail", max: 320, required: true, email: true },
  { key: "Tracking", max: 64, required: true },
  { key: "Location", max: 300, required: true },
  { key: "Priority", max: 40 },
];

// Best-effort in-memory throttle. Azure Functions reuses the process between invocations, so
// this genuinely slows a runaway/looping client - but instances recycle and scale out, so it's
// a courtesy cap, NOT a security control (the x-bwn-key gate is that). Keyed by self-declared
// actor; 20 requests / 60s.
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

// Forward to the (fixed, server-held) flow URL. The host/path come from DISPATCH_FLOW_URL,
// NOT from the caller, so there is no SSRF surface. Mirrors cc-purchase's postToFlow.
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

    // -- Flow URL must be present (fail closed) ---------------------------------
    const flowUrl = process.env.DISPATCH_FLOW_URL;
    if (!flowUrl) { context.res = json(503, { error: "flow endpoint not configured" }); return; }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    // Self-declared actor (NOT verified - the key is the boundary). Used only for the telemetry
    // trail + the courtesy rate-limit. Mirrors wo-ingest.
    const actor = body.actor ? String(body.actor).slice(0, 128) : "unknown";
    if (rateLimited(actor)) { context.res = json(429, { error: "rate limited; slow down" }); return; }

    // -- Validate + whitelist the 5 fields --------------------------------------
    const out = {};
    const missing = [];
    for (const f of FIELDS) {
      let v = body[f.key];
      v = (v == null) ? "" : String(v).trim();
      if (v.length > f.max) v = v.slice(0, f.max);
      if (f.email && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        context.res = json(400, { error: "AssigneeEmail must be a valid email address" });
        return;
      }
      if (f.required && !v) missing.push(f.key);
      out[f.key] = v;                                           // always send all 5 props (blank if absent), matching the flow schema
    }
    if (missing.length) { context.res = json(400, { error: "missing required field(s): " + missing.join(", ") }); return; }

    const outBody = JSON.stringify(out);
    // Log actor + a few non-sensitive facts for the App Insights trail. NEVER log flowUrl,
    // the key, or the full body.
    context.log("dispatch forward", actor, out.Tracking, out.AssignedToName, out.Priority);

    const flowRes = await postToFlow(flowUrl, outBody, 20000);
    // The Power Automate HTTP trigger returns 202 Accepted on a successful queue (the flow's
    // hours-long card wait runs async after that). Treat any 2xx as success. Don't leak the
    // flow's raw body upward (it can carry run metadata).
    if (flowRes.status >= 200 && flowRes.status < 300) {
      context.res = json(200, { ok: true });
      return;
    }
    context.log.warn("dispatch flow rejected", flowRes.status);
    context.res = json(502, { ok: false, error: "flow rejected the request (" + flowRes.status + ")" });
  } catch (err) {
    context.log.error("dispatch error:", err && err.message ? err.message : err);
    context.res = json(500, { error: "dispatch error" });
  }
};
