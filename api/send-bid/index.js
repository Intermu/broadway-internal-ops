const https = require("https");
const crypto = require("crypto");
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
const OPENS_PREFIX = "bid-opens/";                 // per-send opens record: bid-opens/<sendId>
const TRACK_INDEX_PREFIX = "bid-opens/by-tracking/"; // tracking# -> [sendIds] for bid-status lookup
const MAX_AUDIT_ENTRIES = 1000;
const MAX_TRACK_IDS = 100;                         // cap sendIds retained per tracking # index
const MAX_RETRIES = 5;
const MAX_BCC = 60;                 // matches the userscript's cap
const MAX_SUBJECT = 300;
const MAX_HTML = 300000;            // ~300KB - the template is ~15KB filled
const MAX_ATTACH = 6;               // files per send (HVAC schedule + a few coordinator-curated files)
const MAX_ATTACH_BYTES = 12000000;  // ~12MB total (base64-decoded) - photos/PDFs run larger than the tiny schedule
const MAX_ATTACH_B64 = Math.ceil(MAX_ATTACH_BYTES / 3) * 4 + 8;   // base64 length ceiling per file - bound the decode BEFORE Buffer.from allocates
const ATTACH_NAME_RE = /^[A-Za-z0-9 ._\-()]+\.[A-Za-z0-9]{1,8}$/;   // no path separators / control chars
// Extension -> allowed MIME(s). Two sources: the HVAC PM equipment schedule (.xlsx / .csv), and
// coordinator-curated files a user manually picks (spec sheets / site photos: .pdf .jpg .png
// .heic). Allowlisted so a leaked-key caller cannot relay anything executable (.exe/.js/.hta/...)
// from a real Broadway mailbox - content is never inspected, so the extension+MIME gate is the control.
const ATTACH_ALLOW = {
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".csv": ["text/csv"],
  ".pdf": ["application/pdf"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".heic": ["image/heic"],
};
const DAILY_RECIPIENTS = 500;       // ceiling across all senders per UTC day
const PER_SEND_TIMEOUT = 25000;     // per-vendor Graph send ceiling; CONCURRENCY*ceil(MAX_BCC/C) must stay < functionTimeout
const CONCURRENCY = 4;              // parallel per-vendor Graph sends (Graph tolerates this per mailbox; keeps the batch well inside functionTimeout)
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
  })().catch((err) => { containerClientPromise = null; throw err; });   // never cache a rejection - a cold-start blip would brick the process
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

// Mark a landed reservation DONE and set its recipient count to the number ACTUALLY sent.
// The done flag is what makes idempotency safe: a retry carrying the same idem key sees the
// completed entry and returns the prior result instead of re-sending. Setting the count to
// the actual successes also means a partial per-vendor batch consumes only its successes
// against the daily ceiling. Best-effort; on contention it leaves the (higher) reserved
// count + not-done, which only tightens the cap and, at worst, makes a fast retry wait.
async function markSent(blob, id, actualCount) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const dl = await blob.download();
      const parsed = JSON.parse(await streamToString(dl.readableStreamBody));
      const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      let changed = false;
      for (const en of entries) {
        if (en && en.id === id) {
          if (en.bcc !== actualCount) { en.bcc = actualCount; changed = true; }
          if (!en.done) { en.done = true; changed = true; }
        }
      }
      if (!changed) return;
      const out = JSON.stringify({ v: 1, entries });
      await blob.upload(out, Buffer.byteLength(out), { blobHTTPHeaders: { blobContentType: "application/json" }, conditions: { ifMatch: dl.etag } });
      return;
    } catch (err) {
      // Retry on ANY error (not just 412) - the done flag drives idempotency, so persisting
      // it matters; a transient blob error shouldn't silently leave the send un-flagged.
      if (attempt < MAX_RETRIES - 1) continue;
      return;
    }
  }
}

// Append a 1x1 tracking pixel to a vendor's copy of the email (per-vendor mode only). The
// URL carries only opaque server-generated ids - never the vendor email - so no personal
// data rides the query string. Inserted just before the final </table> when present, else
// appended; either way mail clients render it.
function injectPixel(html, url) {
  const img = '<img src="' + url + '" width="1" height="1" alt="" style="border:0;width:1px;height:1px;">';
  const i = html.lastIndexOf("</table>");
  return i === -1 ? (html + img) : (html.slice(0, i + 8) + img + html.slice(i + 8));
}

// Write the per-send opens record (bid-opens/<sendId>). Best-effort: a failure here does
// not fail the send, it only means those opens won't be trackable. sendId is unique so we
// never clobber (ifNoneMatch).
async function writeOpens(container, rec) {
  try {
    const out = JSON.stringify(rec);
    await container.getBlockBlobClient(OPENS_PREFIX + rec.sendId).upload(out, Buffer.byteLength(out), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err) { /* best-effort */ }
}

// Add this sendId to the tracking# -> [sendIds] index so bid-status can resolve opens by WO
// tracking number. Best-effort, ETag-guarded, bounded length.
async function appendTrackingIndex(container, tracking, sendId) {
  const safe = String(tracking || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return;
  const blob = container.getBlockBlobClient(TRACK_INDEX_PREFIX + safe);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let cur = [], etag = null, exists = false;
    try {
      const dl = await blob.download();
      const parsed = JSON.parse(await streamToString(dl.readableStreamBody));
      cur = parsed && Array.isArray(parsed.sendIds) ? parsed.sendIds : [];
      etag = dl.etag; exists = true;
    } catch (err) { if (err.statusCode !== 404) return; }
    let next = cur.concat([sendId]);
    if (next.length > MAX_TRACK_IDS) next = next.slice(-MAX_TRACK_IDS);
    const out = JSON.stringify({ v: 1, sendIds: next });
    try {
      await blob.upload(out, Buffer.byteLength(out), {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: exists ? { ifMatch: etag } : { ifNoneMatch: "*" },
      });
      return;
    } catch (err) {
      if (err.statusCode === 412 || err.statusCode === 409) continue;
      return;
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
    // Per-vendor tracked send mode is DARK until IT sets TRACK_BASE_URL (the public SWA
    // origin, e.g. https://ops.broadwaynational.com). Unset => the existing single-BCC send
    // path runs exactly as before, so this whole feature is opt-in at deploy time.
    const TRACK_BASE = (process.env.TRACK_BASE_URL || "").trim().replace(/\/+$/, "");
    // Only enable per-vendor tracking for an https base - an http pixel is mixed-content and
    // gets blocked by most mail clients, so a misconfigured http value falls back to the safe
    // single-BCC send rather than emitting a dead/blocked pixel.
    const perVendor = /^https:\/\//i.test(TRACK_BASE);

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
    // Optional file attachments (the HVAC PM equipment schedule: .xlsx, or a .csv fallback).
    // Validated to Graph fileAttachment shape; count + string-length + decoded-size capped;
    // extension/MIME allowlisted so a leaked-key caller cannot relay anything a mailbox would
    // execute. Same trust posture as `html`.
    var graphAttachments = [];
    if (body.attachments != null) {
      if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ATTACH) {
        context.res = json(400, { error: "attachments must be an array of at most " + MAX_ATTACH }); return;
      }
      var attachTotal = 0;
      for (var ai = 0; ai < body.attachments.length; ai++) {
        var at = body.attachments[ai] || {};
        var an = String(at.name || "").trim(), act = String(at.contentType || "").trim(), ab = String(at.contentBase64 || "");
        if (!ATTACH_NAME_RE.test(an)) { context.res = json(400, { error: "invalid attachment name" }); return; }
        var dot = an.lastIndexOf("."), ext = dot === -1 ? "" : an.slice(dot).toLowerCase();
        var allowedTypes = ATTACH_ALLOW[ext];
        if (!allowedTypes) { context.res = json(400, { error: "attachment type not allowed (allowed: " + Object.keys(ATTACH_ALLOW).join(" ") + ")" }); return; }
        if (allowedTypes.indexOf(act) === -1) { context.res = json(400, { error: "attachment contentType does not match its extension" }); return; }
        if (!ab || ab.length > MAX_ATTACH_B64) { context.res = json(400, { error: "attachment too large or empty" }); return; }   // bound the decode BEFORE allocating
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(ab)) { context.res = json(400, { error: "invalid attachment contentBase64" }); return; }
        var decoded = Buffer.from(ab, "base64");
        attachTotal += decoded.length;
        if (attachTotal > MAX_ATTACH_BYTES) { context.res = json(400, { error: "attachments too large (max " + MAX_ATTACH_BYTES + " bytes)" }); return; }
        graphAttachments.push({ "@odata.type": "#microsoft.graph.fileAttachment", name: an, contentType: act, contentBytes: decoded.toString("base64") });
      }
    }
    const tracking = body.tracking ? String(body.tracking).slice(0, 64) : null;
    // Idempotency key: the client sends a STABLE key per prepared bid and re-sends the SAME
    // key on any retry. It is what stops a client timeout (the sequential per-vendor loop can
    // outlast the client's socket) from turning a retry into DUPLICATE external bid emails.
    const idem = body.idem ? String(body.idem).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) : null;

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
      // ── Idempotency short-circuit (before reserving/sending) ──────────────────
      // ANY existing non-voided entry for this key stops a resend - this is what makes
      // "never double-send" airtight even when the client retries after a timeout. We do
      // NOT time-expire it: a completed send whose done-flag write failed must never later
      // look "stale" and get re-sent. The client key is a pure content hash (no nonce), so an
      // identical re-bid keeps returning here until the entry is date-pruned (~a day) - that
      // window IS the dedup guarantee. Tradeoff (accepted, safe-direction): a reservation that
      // is hard-killed AFTER landing but BEFORE voidReservation runs (e.g. instance recycle in
      // the tiny pre-send window) stays non-voided/non-done and will 409 an identical bid for
      // the rest of the UTC day; recovery is to edit the bid (new hash) or wait for the prune.
      // We do not auto-recover it because a killed-MID-batch send is indistinguishable from a
      // killed-PRE-send one, and resending the former would duplicate.
      if (idem) {
        let dup = null;
        for (const en of cur) { if (en && !en.voided && en.idem === idem) dup = en; }
        if (dup) {
          if (dup.done) {   // completed - return the prior outcome, DO NOT re-send
            context.res = json(200, { ok: true, duplicate: true, sent: Number(dup.bcc) || 0, sendId: dup.id, tracked: !!dup.tracked });
          } else {          // reserved + (in flight OR done-flag write failed) - never re-send under this key
            context.res = json(409, { error: "a send with this key is already in progress", inProgress: true });
          }
          return;
        }
      }
      let sentToday = 0;
      for (const en of cur) { if (en && !en.voided && typeof en.ts === "string" && en.ts.slice(0, 10) === today) sentToday += Number(en.bcc) || 0; }
      if (sentToday + bcc.length > DAILY_RECIPIENTS) {
        context.res = json(429, { error: "daily send ceiling reached (" + DAILY_RECIPIENTS + " recipients/day)" });
        return;
      }
      const entry = { id: entryId, ts: new Date().toISOString(), from, bcc: bcc.length, subject: subject.slice(0, 120), tracking, idem: idem, done: false, tracked: perVendor };
      // Retention by DATE, then a count backstop. Pruning by date first guarantees TODAY's
      // entries are never evicted, so sentToday can't under-count and let the ceiling be
      // bypassed (a pure count cap could drop today's sends behind a wall of old/voided ones).
      const cutoff = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);   // keep ~today + yesterday (UTC)
      let next = cur.concat([entry]).filter((e) => e && typeof e.ts === "string" && e.ts.slice(0, 10) >= cutoff);
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

    // Guard the whole send section: the known Graph-failure paths void their own reservation
    // and return, so this catch only fires on an UNEXPECTED throw (before/around sending, when
    // little or nothing was sent) - void so a counted reservation isn't left behind for a
    // request that errored out. (markSent/writeOpens/appendTrackingIndex swallow their own
    // errors, so a post-send throw here is not a concern.)
    try {
    // ── Send via Graph (app-only): from the coordinator's own mailbox ────────────
    // Token first - both send modes need it. A token failure voids the reservation.
    let token;
    try {
      token = await getGraphToken(tenant, clientId, secret);
    } catch (err) {
      await voidReservation(blob, entryId);
      context.log.error("send-bid token error", err && err.message);
      context.res = json(502, { error: "Graph auth failed - " + String((err && err.message) || "request error").slice(0, 200) });
      return;
    }

    if (!perVendor) {
      // ── DEFAULT single-BCC send (unchanged) - vendors BCC-only, To = sender ──────
      const message = {
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          toRecipients: [{ emailAddress: { address: from } }],
          bccRecipients: bcc.map((a) => ({ emailAddress: { address: a } })),
          replyTo: [{ emailAddress: { address: from } }],
          attachments: graphAttachments,
        },
        saveToSentItems: true,
      };
      let r;
      try {
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
      await markSent(blob, entryId, bcc.length);   // set done BEFORE responding so an idem retry sees it
      context.res = json(200, { ok: true, sent: bcc.length });
      return;
    }

    // ── PER-VENDOR tracked send (TRACK_BASE_URL set) ─────────────────────────────
    // Each vendor gets their OWN message (To: them, no shared BCC - so no vendor sees any
    // other, and each copy carries a unique open-tracking pixel). Sends run with bounded
    // CONCURRENCY (Graph-throttle-safe) so even a full MAX_BCC batch finishes well inside
    // functionTimeout; a per-send failure is logged and skipped, not fatal.
    const sendId = entryId;   // tie the opens record to the audit entry
    const vendors = bcc.map((email) => ({ token: crypto.randomBytes(9).toString("hex"), email: email, sendOk: false }));
    async function sendOne(v) {
      // Everything (incl. pixel injection + payload build) sits INSIDE the try so a throw
      // here can never reject the worker and detach the pool from its accounting.
      try {
        const pixelUrl = TRACK_BASE + "/api/track-open?s=" + sendId + "&v=" + v.token;
        const message = {
          message: {
            subject,
            body: { contentType: "HTML", content: injectPixel(html, pixelUrl) },
            toRecipients: [{ emailAddress: { address: v.email } }],
            replyTo: [{ emailAddress: { address: from } }],
            attachments: graphAttachments,
          },
          saveToSentItems: true,
        };
        const payload = JSON.stringify(message);
        const rr = await httpsJson(GRAPH_HOST, `/v1.0/users/${encodeURIComponent(from)}/sendMail`, "POST",
          { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          payload, PER_SEND_TIMEOUT);
        if (rr.status === 202) { v.sendOk = true; }
        else {
          const detail = rr.body && rr.body.error ? (rr.body.error.code + ": " + rr.body.error.message) : ("HTTP " + rr.status);
          context.log.error("send-bid per-vendor send failed", detail);
        }
      } catch (err) {
        context.log.error("send-bid per-vendor send error", err && err.message);
      }
    }
    // Bounded worker pool: CONCURRENCY workers pull from a shared cursor until the list is
    // drained. Each vendor is independent, so order doesn't matter and there is no shared
    // mutable state beyond the cursor + each vendor's own sendOk.
    let cursor = 0;
    async function worker() { while (cursor < vendors.length) { const idx = cursor++; await sendOne(vendors[idx]); } }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, vendors.length) }, worker));
    const sentCount = vendors.filter((v) => v.sendOk).length;
    if (sentCount === 0) {
      await voidReservation(blob, entryId);
      context.res = json(502, { error: "Graph send failed - no messages were sent" });
      return;
    }
    await markSent(blob, entryId, sentCount);   // set done + trim ceiling to actual successes
    // Opens record covers every vendor (sendOk flags which were actually reached); only the
    // reached ones can ever fire a pixel. Best-effort - tracking never blocks the response.
    const rec = {
      v: 1, sendId, ts: new Date().toISOString(), from, subject: subject.slice(0, 120), tracking,
      vendors: vendors.map((v) => ({
        token: v.token, email: v.email, opened: false, openCount: 0,
        firstOpenTs: null, lastOpenTs: null, sendOk: v.sendOk,
      })),
    };
    await writeOpens(container, rec);
    if (tracking) await appendTrackingIndex(container, tracking, sendId);
    context.res = json(200, { ok: true, sent: sentCount, failed: vendors.length - sentCount, sendId, tracked: true });
    } catch (sendErr) {
      await voidReservation(blob, entryId);   // unexpected throw with a landed reservation - release the budget
      throw sendErr;                           // let the module-level catch produce the 500
    }
  } catch (err) {
    context.log.error("send-bid error", err && err.message);
    context.res = json(500, { error: "internal error" });
  }
};
