const https = require("https");
const { BlobServiceClient } = require("@azure/storage-blob");

// Graph send for the BWN Bid-Out userscript (Phase B - one-click styled RFP email).
//
// The Bid-Out tool runs inside app.umbrava.com (not federated to Broadway AAD), builds the
// branded HTML bid email client-side, shows the coordinator a review modal (recipients +
// rendered body), and only on their explicit Send POSTs here. This function then sends the
// message via Microsoft Graph APP-ONLY (client credentials) from the coordinator's own
// mailbox - it lands in their Sent Items and replies come back to them.
//
//   POST /api/send-bid   header x-bwn-key: <WO_INGEST_KEY>
//        body { from, bcc:[emails], subject, html, tracking? }
//        → { ok:true, sent:N }
//
// Reached ANONYMOUSLY at the SWA route layer and gated by the SAME shared function key as
// wo-ingest/scrape-contacts (x-bwn-key vs WO_INGEST_KEY). Fails CLOSED at every layer:
//   503 - WO_INGEST_KEY unset, or the Graph app registration isn't configured yet
//         (client id/secret absent - from BID_CLIENT_ID/BID_CLIENT_SECRET or, for the
//         reuse-the-existing-app path, the SWA's AAD_CLIENT_ID/AAD_CLIENT_SECRET - or no
//         tenant, or NEITHER BID_FROM_ALLOWED nor BID_FROM_DOMAIN set → endpoint stays dark);
//   403 - wrong key, or `from` not permitted by the allowlist/allowed-domain.
//
// Abuse limits (this endpoint can EMAIL EXTERNAL PARTIES, so it is deliberately narrow):
//   • `from` must match the server-side allowlist - either an exact address in
//     BID_FROM_ALLOWED (comma-separated) OR its domain in BID_FROM_DOMAIN (comma-separated,
//     e.g. "broadwaynational.com" = any mailbox on the domain may send). A leaked key still
//     cannot send as an ARBITRARY external mailbox. IT scopes the app registration to match
//     with an ApplicationAccessPolicy (a dynamic security group of the same domain users).
//   • recipients only in BCC (competitive privacy), capped at MAX_BCC; To/Reply-To = from.
//   • subject/html size caps. `html` is CALLER-SUPPLIED (the userscript builds it from a
//     fixed template and escapes all content, but a leaked key could POST anything), so it
//     is NOT trusted: active markup (<script>/<form>/<iframe>/inline on*= handlers/
//     javascript: URIs/formaction) is rejected. This is defense-in-depth, not a full
//     sanitizer - plain links/images still render (can't block those without breaking the
//     template), so the key gate + from-domain limit + audit log remain the real controls.
//   • a rolling audit log in blob storage + a per-day recipient ceiling (DAILY_RECIPIENTS).
//     The ceiling is RESERVED in the same ETag-guarded write that records the send, BEFORE
//     the send - so concurrent requests can't all read a stale pre-send count and blow past
//     it (a real risk: Functions run requests concurrently and scale out across instances).

const CONTAINER_NAME = "broadway-data";
const AUDIT_BLOB = "bid-sends/log";
const MAX_AUDIT_ENTRIES = 1000;
const MAX_RETRIES = 5;
const MAX_BCC = 60;                 // matches the userscript's cap
const MAX_SUBJECT = 300;
const MAX_HTML = 300000;            // ~300KB - the template is ~15KB filled
const DAILY_RECIPIENTS = 500;       // ceiling across all senders per UTC day
const GRAPH_HOST = "graph.microsoft.com";
const LOGIN_HOST = "login.microsoftonline.com";

const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

let containerClientPromise = null;
function getContainerClient() {
  if (containerClientPromise) return containerClientPromise;
  containerClientPromise = (async () => {
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(CONTAINER_NAME);
    await container.createIfNotExists();
    return container;
  })();
  return containerClientPromise;
}

async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Plain RFC-ish address check - the userscript pre-validates; this is the server backstop.
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[A-Za-z]{2,}$/;

// Fixed-host HTTPS helper (login.microsoftonline.com / graph.microsoft.com only - no
// user-supplied hosts, so no SSRF surface; scrape-contacts' guardedLookup isn't needed).
function httpsJson(host, path, method, headers, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path, method, headers },
      (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d; if (buf.length > 1048576) { req.destroy(); reject(new Error("response too large")); } });
        res.on("end", () => {
          let parsed = null;
          try { parsed = buf ? JSON.parse(buf) : null; } catch (e) { /* Graph sendMail 202 has an empty body */ }
          resolve({ status: res.statusCode, body: parsed, raw: buf });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(); reject(new Error("timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// App-only token via client credentials, cached until ~60s before expiry. Azure Functions
// reuses the process between invocations, so the cache genuinely saves round-trips.
let tokenCache = { token: null, exp: 0 };
async function getGraphToken(tenant, clientId, secret) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const form =
    "client_id=" + encodeURIComponent(clientId) +
    "&client_secret=" + encodeURIComponent(secret) +
    "&scope=" + encodeURIComponent("https://graph.microsoft.com/.default") +
    "&grant_type=client_credentials";
  const r = await httpsJson(LOGIN_HOST, `/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, "POST",
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(form) }, form, 15000);
  if (r.status !== 200 || !r.body || !r.body.access_token) {
    throw new Error("token request failed: " + r.status + " " + (r.body && r.body.error ? r.body.error : ""));
  }
  tokenCache = { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

// Best-effort: mark a reserved audit entry voided so a FAILED send doesn't consume the
// day's budget. Fail-safe by design - if this can't land (contention/error), the entry
// stays and only TIGHTENS the cap; it never throws into the caller's response path.
async function voidReservation(blob, id) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const dl = await blob.download();
      const parsed = JSON.parse(await streamToString(dl.readableStreamBody));
      const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      let changed = false;
      for (const en of entries) { if (en && en.id === id && !en.voided) { en.voided = true; changed = true; } }
      if (!changed) return;
      const out = JSON.stringify({ v: 1, entries });
      await blob.upload(out, Buffer.byteLength(out), { blobHTTPHeaders: { blobContentType: "application/json" }, conditions: { ifMatch: dl.etag } });
      return;
    } catch (err) {
      if (err.statusCode === 412 || err.statusCode === 409) continue;   // raced - re-read + retry
      return;   // give up quietly; over-count is the safe direction
    }
  }
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    // ── Key gate (fail closed; 403 not 401 - see wo-ingest for the redirect trap) ──
    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "ingest not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!key || key !== expected) { context.res = json(403, { error: "unauthorized" }); return; }

    // ── Graph config gate - the endpoint is deploy-dark until IT provides these ──
    // Graph app credentials. Falls back to the SWA's EXISTING Entra sign-in app
    // (AAD_CLIENT_ID / AAD_CLIENT_SECRET, already in app settings) so you can REUSE that
    // registration - just have an admin add the Application `Mail.Send` permission + grant
    // admin consent to it - instead of creating a new app. A dedicated app is cleaner
    // (least privilege / independent secret), but reuse works with no extra secrets: set
    // only BID_TENANT_ID (+ BID_FROM_DOMAIN). BID_* always wins if you DO make a new app.
    const tenant = process.env.BID_TENANT_ID || process.env.AAD_TENANT_ID;
    const clientId = process.env.BID_CLIENT_ID || process.env.AAD_CLIENT_ID;
    const secret = process.env.BID_CLIENT_SECRET || process.env.AAD_CLIENT_SECRET;
    const allowedRaw = process.env.BID_FROM_ALLOWED || "";     // exact addresses (comma-sep)
    const domainRaw = process.env.BID_FROM_DOMAIN || "";       // whole domains (comma-sep), e.g. "broadwaynational.com"
    if (!tenant || !clientId || !secret || (!allowedRaw && !domainRaw)) {
      context.res = json(503, { error: "send-bid not configured (awaiting Graph app registration)" });
      return;
    }
    const allowedFrom = allowedRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const allowedDomains = domainRaw.split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);

    // ── Validate the request ────────────────────────────────────────────────────
    const body = req.body || {};
    const from = String(body.from || "").trim().toLowerCase();
    if (!EMAIL_RE.test(from)) { context.res = json(400, { error: "invalid 'from'" }); return; }
    // EMAIL_RE guarantees exactly one "@", so the domain is everything after the last one.
    const fromDomain = from.slice(from.lastIndexOf("@") + 1);
    if (allowedFrom.indexOf(from) === -1 && allowedDomains.indexOf(fromDomain) === -1) {
      context.res = json(403, { error: "'from' not on the send allowlist" }); return;
    }
    const bccIn = Array.isArray(body.bcc) ? body.bcc : [];
    const seen = Object.create(null);
    const bcc = [];
    for (const e of bccIn) {
      const v = String(e || "").trim().toLowerCase();
      if (EMAIL_RE.test(v) && !seen[v]) { seen[v] = 1; bcc.push(v); }
    }
    if (!bcc.length) { context.res = json(400, { error: "no valid bcc recipients" }); return; }
    if (bcc.length > MAX_BCC) { context.res = json(400, { error: "too many recipients (max " + MAX_BCC + ")" }); return; }
    const subject = String(body.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_SUBJECT);
    if (!subject) { context.res = json(400, { error: "missing 'subject'" }); return; }
    const html = String(body.html || "");
    if (!html.trim()) { context.res = json(400, { error: "missing 'html'" }); return; }
    if (html.length > MAX_HTML) { context.res = json(400, { error: "html too large" }); return; }
    // `html` is untrusted (see header note). Our template contains only tables / div / span /
    // a[mailto|https] / img[https] / hr / br and ESCAPED text, so this never trips a real send;
    // it blocks a leaked-key caller from weaponizing an authenticated-from-a-real-mailbox send.
    if (/<\s*(?:script|form|iframe|object|embed|meta|base|link|style)\b/i.test(html) ||
        /\son[a-z]+\s*=/i.test(html) ||
        /(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i.test(html) ||
        /\bformaction\s*=/i.test(html)) {
      context.res = json(400, { error: "html contains disallowed markup" }); return;
    }
    const tracking = body.tracking ? String(body.tracking).slice(0, 64) : null;

    // ── Reserve the recipient budget BEFORE sending (atomic ETag transaction) ────
    // read → check ceiling → append this send → conditional upload, all in ONE loop, so
    // the value that gates the send is written in the same transaction that records it.
    // Concurrent requests (same instance or scaled-out) serialize on the blob ETag: a
    // loser gets 412, re-reads the now-higher count, and re-checks - so the cap holds.
    // Only AFTER a reservation lands do we send; a failed send voids its reservation.
    const container = await getContainerClient();
    const blob = container.getBlockBlobClient(AUDIT_BLOB);
    const entryId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const today = new Date().toISOString().slice(0, 10);
    let reserved = false;
    for (let attempt = 0; attempt < MAX_RETRIES && !reserved; attempt++) {
      let cur = [], etag = null, exists = false;
      try {
        const dl = await blob.download();
        const parsed = JSON.parse(await streamToString(dl.readableStreamBody));
        cur = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
        etag = dl.etag; exists = true;
      } catch (err) { if (err.statusCode !== 404) throw err; }
      let sentToday = 0;
      for (const en of cur) { if (en && !en.voided && typeof en.ts === "string" && en.ts.slice(0, 10) === today) sentToday += Number(en.bcc) || 0; }
      if (sentToday + bcc.length > DAILY_RECIPIENTS) {
        context.res = json(429, { error: "daily send ceiling reached (" + DAILY_RECIPIENTS + " recipients/day)" });
        return;
      }
      const entry = { id: entryId, ts: new Date().toISOString(), from, bcc: bcc.length, subject: subject.slice(0, 120), tracking };
      let next = cur.concat([entry]);
      if (next.length > MAX_AUDIT_ENTRIES) next = next.slice(-MAX_AUDIT_ENTRIES);
      const outBody = JSON.stringify({ v: 1, entries: next });
      const conditions = exists ? { ifMatch: etag } : { ifNoneMatch: "*" };
      try {
        await blob.upload(outBody, Buffer.byteLength(outBody), { blobHTTPHeaders: { blobContentType: "application/json" }, conditions });
        reserved = true;
      } catch (err) {
        if (err.statusCode === 412 || err.statusCode === 409) continue;   // lost the race - re-read + re-check
        throw err;
      }
    }
    if (!reserved) {
      // Never send without a landed reservation - that is what keeps the ceiling honest.
      context.res = json(503, { error: "send log contended; please retry" });
      return;
    }

    // ── Send via Graph (app-only): from the coordinator's own mailbox ────────────
    const message = {
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        // To = the sender themselves: vendors are BCC-only (they must not see each other),
        // and every mail client renders a To - the coordinator's own address is honest.
        toRecipients: [{ emailAddress: { address: from } }],
        bccRecipients: bcc.map((a) => ({ emailAddress: { address: a } })),
        replyTo: [{ emailAddress: { address: from } }],
      },
      saveToSentItems: true,
    };
    let r;
    try {
      const token = await getGraphToken(tenant, clientId, secret);
      const payload = JSON.stringify(message);
      r = await httpsJson(GRAPH_HOST, `/v1.0/users/${encodeURIComponent(from)}/sendMail`, "POST",
        { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        payload, 30000);
    } catch (err) {
      await voidReservation(blob, entryId);   // release the reserved budget - the send didn't happen
      context.log.error("send-bid send error", err && err.message);
      context.res = json(502, { error: "Graph send failed - " + String((err && err.message) || "request error").slice(0, 200) });
      return;
    }
    if (r.status !== 202) {
      await voidReservation(blob, entryId);
      const detail = r.body && r.body.error ? (r.body.error.code + ": " + r.body.error.message) : ("HTTP " + r.status);
      context.log.error("send-bid Graph send failed", detail);
      // 502, not the raw Graph status - Graph's 401/403 must not be confused with OUR key gate.
      context.res = json(502, { error: "Graph send failed - " + String(detail).slice(0, 300) });
      return;
    }

    context.res = json(200, { ok: true, sent: bcc.length });
  } catch (err) {
    context.log.error("send-bid error", err && err.message);
    context.res = json(500, { error: "internal error" });
  }
};
