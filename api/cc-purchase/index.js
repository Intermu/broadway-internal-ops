const https = require("https");
const { URL } = require("url");

// CC Purchase proxy for the BWN userscript connector (forms-to-userscripts pilot).
//
// The BWN CC-Purchase modal runs inside app.umbrava.com - a DIFFERENT origin that is NOT
// federated to Broadway's Entra tenant, so (exactly like /api/wo-ingest) it cannot present
// the AAD principal the rest of /api/* relies on. This endpoint is therefore reachable
// ANONYMOUSLY at the SWA route layer (see staticwebapp.config.json) and gates itself with
// the shared connector FUNCTION KEY (app setting WO_INGEST_KEY, sent as `x-bwn-key`) - the
// SAME key the rest of the connector already uses, so coordinators who set their Tampermonkey
// "ingest key" once need no new secret.
//
// It holds the SAS-signed Power Automate trigger URL server-side (app setting
// CC_PURCHASE_FLOW_URL) and forwards a validated, whitelisted 10-field JSON body to it. That
// URL is a secret (Who-can-trigger = Anyone; the sig is the only gate) and MUST NEVER ship in
// the GitHub-synced userscript - proxying here is the whole point. The flow then logs a row to
// Credit Card Tracker.xlsx (tbl_Card_Log) + emails Mike, identically to the old Forms flow.
//
//   POST /api/cc-purchase   header x-bwn-key: <WO_INGEST_KEY>
//        body { actor?, Date, CardUser, CardUsed, SupplierName, Subtotal, TaxAmount,
//               TotalAmount, LineItemDescription, PurchaseLink, WorkOrderNumber }
//        -> { ok:true } on a 2xx from the flow
//
// Fails CLOSED: 503 if the key or the flow URL is not configured, 403 on a missing/wrong key
// (NOT 401 - staticwebapp.config.json's responseOverrides rewrite 401s into a login redirect,
// which a client chasing redirects would misread as a 200 success), 400 on invalid input,
// 502 if the flow itself rejects the forward.

// CORS is belt-and-suspenders: Tampermonkey's GM_xmlhttpRequest bypasses same-origin (that's
// what @connect authorizes), so these aren't strictly needed - but they scope any normal-fetch
// caller to the Umbrava origin. Mirrors wo-ingest.
const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

// The flow's HTTP trigger expects a FLAT JSON body with exactly these 10 string props (schema
// captured 2026-07-21). Anything else in the request body is ignored - only this whitelist is
// forwarded. `required` = the minimum for a meaningful card-spend row; the modal does the real
// UX validation, this is the server backstop. `money` values are normalised to a bare numeric
// string (strip $ , and spaces) so the Excel cell lands as a number like the Forms flow did.
const FIELDS = [
  { key: "Date", max: 40, required: true },
  { key: "CardUser", max: 200, required: true },
  { key: "CardUsed", max: 200 },
  { key: "SupplierName", max: 300, required: true },
  { key: "Subtotal", max: 40, money: true },
  { key: "TaxAmount", max: 40, money: true },
  { key: "TotalAmount", max: 40, money: true, required: true },
  { key: "LineItemDescription", max: 4000 },
  { key: "PurchaseLink", max: 2000, url: true },
  { key: "WorkOrderNumber", max: 64 },
  // v2 receipt: the modal uploads the file via /api/cc-receipt and passes back the resulting
  // link here. Forwarded to the flow, which writes the Receipt HYPERLINK cell. Optional -
  // harmless to the flow until that cell mapping is added (unknown body props are ignored).
  { key: "ReceiptLink", max: 2000, url: true },
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

// Forward to the (fixed, server-held) flow URL. The host/path come from CC_PURCHASE_FLOW_URL,
// NOT from the caller, so there is no SSRF surface (scrape-contacts' guardedLookup isn't needed).
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
    if (!key || key !== expected) { context.res = json(403, { error: "unauthorized" }); return; }

    // -- Flow URL must be present (fail closed) ---------------------------------
    const flowUrl = process.env.CC_PURCHASE_FLOW_URL;
    if (!flowUrl) { context.res = json(503, { error: "flow endpoint not configured" }); return; }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const actor = body.actor ? String(body.actor).slice(0, 128) : "unknown";
    if (rateLimited(actor)) { context.res = json(429, { error: "rate limited; slow down" }); return; }

    // -- Validate + whitelist the 10 fields -------------------------------------
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
      out[f.key] = v;                                           // always send all 10 props (blank if absent), matching the flow schema
    }
    if (missing.length) { context.res = json(400, { error: "missing required field(s): " + missing.join(", ") }); return; }

    const outBody = JSON.stringify(out);
    // Log actor + a few non-sensitive facts for the App Insights trail. NEVER log flowUrl,
    // the key, or the full body.
    context.log("cc-purchase forward", actor, out.SupplierName, out.TotalAmount, out.WorkOrderNumber);

    const flowRes = await postToFlow(flowUrl, outBody, 20000);
    // The Power Automate HTTP trigger returns 202 Accepted on a successful queue. Treat any
    // 2xx as success. Don't leak the flow's raw body upward (it can carry run metadata).
    if (flowRes.status >= 200 && flowRes.status < 300) {
      context.res = json(200, { ok: true });
      return;
    }
    context.log.warn("cc-purchase flow rejected", flowRes.status);
    context.res = json(502, { ok: false, error: "flow rejected the request (" + flowRes.status + ")" });
  } catch (err) {
    context.log.error("cc-purchase error:", err && err.message ? err.message : err);
    context.res = json(500, { error: "cc-purchase error" });
  }
};
