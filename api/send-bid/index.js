const https = require("https");
const { BlobServiceClient } = require("@azure/storage-blob");

// Graph send for the BWN Bid-Out userscript (Phase B — one-click styled RFP email).
//
// The Bid-Out tool runs inside app.umbrava.com (not federated to Broadway AAD), builds the
// branded HTML bid email client-side, shows the coordinator a review modal (recipients +
// rendered body), and only on their explicit Send POSTs here. This function then sends the
// message via Microsoft Graph APP-ONLY (client credentials) from the coordinator's own
// mailbox — it lands in their Sent Items and replies come back to them.
//
//   POST /api/send-bid   header x-bwn-key: <WO_INGEST_KEY>
//        body { from, bcc:[emails], subject, html, tracking? }
//        → { ok:true, sent:N }
//
// Reached ANONYMOUSLY at the SWA route layer and gated by the SAME shared function key as
// wo-ingest/scrape-contacts (x-bwn-key vs WO_INGEST_KEY). Fails CLOSED at every layer:
//   503 — WO_INGEST_KEY unset, or the Graph app registration isn't configured yet
//         (BID_TENANT_ID / BID_CLIENT_ID / BID_CLIENT_SECRET / BID_FROM_ALLOWED app
//         settings absent → the endpoint stays dark until IT hands those over);
//   403 — wrong key, or `from` not in the BID_FROM_ALLOWED list.
//
// Abuse limits (this endpoint can EMAIL EXTERNAL PARTIES, so it is deliberately narrow):
//   • `from` must be on the server-side allowlist (BID_FROM_ALLOWED, comma-separated) —
//     a leaked key cannot send as arbitrary mailboxes. IT additionally scopes the app
//     registration with an ApplicationAccessPolicy to the same people.
//   • recipients only in BCC (competitive privacy), capped at MAX_BCC; To/Reply-To = from.
//   • subject/html size caps; html must not carry remote form targets (it's our template).
//   • a rolling audit log in blob storage + a per-day recipient ceiling (DAILY_RECIPIENTS)
//     across all senders — a runaway loop or key abuse throttles at 429.

const CONTAINER_NAME = "broadway-data";
const AUDIT_BLOB = "bid-sends/log";
const MAX_AUDIT_ENTRIES = 1000;
const MAX_RETRIES = 5;
const MAX_BCC = 60;                 // matches the userscript's cap
const MAX_SUBJECT = 300;
const MAX_HTML = 300000;            // ~300KB — the template is ~15KB filled
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

// Plain RFC-ish address check — the userscript pre-validates; this is the server backstop.
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[A-Za-z]{2,}$/;

// Fixed-host HTTPS helper (login.microsoftonline.com / graph.microsoft.com only — no
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

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    // ── Key gate (fail closed; 403 not 401 — see wo-ingest for the redirect trap) ──
    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "ingest not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!key || key !== expected) { context.res = json(403, { error: "unauthorized" }); return; }

    // ── Graph config gate — the endpoint is deploy-dark until IT provides these ──
    const tenant = process.env.BID_TENANT_ID, clientId = process.env.BID_CLIENT_ID,
          secret = process.env.BID_CLIENT_SECRET, allowedRaw = process.env.BID_FROM_ALLOWED;
    if (!tenant || !clientId || !secret || !allowedRaw) {
      context.res = json(503, { error: "send-bid not configured (awaiting Graph app registration)" });
      return;
    }
    const allowedFrom = allowedRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    // ── Validate the request ────────────────────────────────────────────────────
    const body = req.body || {};
    const from = String(body.from || "").trim().toLowerCase();
    if (!EMAIL_RE.test(from)) { context.res = json(400, { error: "invalid 'from'" }); return; }
    if (allowedFrom.indexOf(from) === -1) { context.res = json(403, { error: "'from' not on the send allowlist" }); return; }
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
    const tracking = body.tracking ? String(body.tracking).slice(0, 64) : null;

    // ── Daily recipient ceiling (read-only pass over today's audit entries) ──────
    const container = await getContainerClient();
    const blob = container.getBlockBlobClient(AUDIT_BLOB);
    let auditEntries = [], auditEtag = null, auditExists = false;
    try {
      const dl = await blob.download();
      const parsed = JSON.parse(await streamToString(dl.readableStreamBody));
      auditEntries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      auditEtag = dl.etag; auditExists = true;
    } catch (err) { if (err.statusCode !== 404) throw err; }
    const today = new Date().toISOString().slice(0, 10);
    let sentToday = 0;
    for (const en of auditEntries) { if (en && typeof en.ts === "string" && en.ts.slice(0, 10) === today) sentToday += Number(en.bcc) || 0; }
    if (sentToday + bcc.length > DAILY_RECIPIENTS) {
      context.res = json(429, { error: "daily send ceiling reached (" + DAILY_RECIPIENTS + " recipients/day)" });
      return;
    }

    // ── Send via Graph (app-only): from the coordinator's own mailbox ────────────
    const token = await getGraphToken(tenant, clientId, secret);
    const message = {
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        // To = the sender themselves: vendors are BCC-only (they must not see each other),
        // and every mail client renders a To — the coordinator's own address is honest.
        toRecipients: [{ emailAddress: { address: from } }],
        bccRecipients: bcc.map((a) => ({ emailAddress: { address: a } })),
        replyTo: [{ emailAddress: { address: from } }],
      },
      saveToSentItems: true,
    };
    const payload = JSON.stringify(message);
    const r = await httpsJson(GRAPH_HOST, `/v1.0/users/${encodeURIComponent(from)}/sendMail`, "POST",
      { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      payload, 30000);
    if (r.status !== 202) {
      const detail = r.body && r.body.error ? (r.body.error.code + ": " + r.body.error.message) : ("HTTP " + r.status);
      context.log.error("send-bid Graph send failed", detail);
      // 502, not the raw Graph status — Graph's 401/403 must not be confused with OUR key gate.
      context.res = json(502, { error: "Graph send failed — " + String(detail).slice(0, 300) });
      return;
    }

    // ── Audit append (ETag-safe; same optimistic pattern as wo-ingest) ────────────
    const entry = { ts: new Date().toISOString(), from, bcc: bcc.length, subject: subject.slice(0, 120), tracking };
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let cur = auditEntries, etag = auditEtag, exists = auditExists;
      if (attempt > 0) {
        cur = []; etag = null; exists = false;
        try {
          const dl = await blob.download();
          const parsed = JSON.parse(await streamToString(dl.readableStreamBody));
          cur = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
          etag = dl.etag; exists = true;
        } catch (err) { if (err.statusCode !== 404) throw err; }
      }
      let next = cur.concat([entry]);
      if (next.length > MAX_AUDIT_ENTRIES) next = next.slice(-MAX_AUDIT_ENTRIES);
      const out = JSON.stringify({ v: 1, entries: next });
      const conditions = exists ? { ifMatch: etag } : { ifNoneMatch: "*" };
      try {
        await blob.upload(out, Buffer.byteLength(out), { blobHTTPHeaders: { blobContentType: "application/json" }, conditions });
        break;
      } catch (err) {
        if (err.statusCode === 412 || err.statusCode === 409) continue;
        // The mail already went out — an audit-write failure must NOT report a send failure.
        context.log.error("send-bid audit write failed", err.message);
        break;
      }
    }

    context.res = json(200, { ok: true, sent: bcc.length });
  } catch (err) {
    context.log.error("send-bid error", err && err.message);
    context.res = json(500, { error: "internal error" });
  }
};
