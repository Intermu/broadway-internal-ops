const https = require("https");
const AUTH = require("../shared/umbrava-auth.js");

// CC Receipt upload for the BWN CC-Purchase modal (forms-to-userscripts pilot, v2 receipt).
//
// The modal (app.umbrava.com, a non-Entra origin) sends the chosen receipt as base64 JSON
// with the shared connector key (x-bwn-key = WO_INGEST_KEY), exactly like the other
// connector endpoints. This Function uploads it to a fixed OneDrive/SharePoint folder via
// Microsoft Graph APP-ONLY (client credentials - the same token flow as api/send-bid) and
// returns an organization-scoped view link. The modal then puts that link in the CC-purchase
// POST as `ReceiptLink`, and the flow writes the Receipt HYPERLINK cell.
//
//   POST /api/cc-receipt   header x-bwn-key: <WO_INGEST_KEY>
//        body { userToken, actor?, filename, contentType, dataB64, woNumber? }
//        -> { ok:true, link, name }
//
// ROLE ENFORCEMENT (2026-07-21): same supervisor+ gate as api/cc-purchase (this endpoint is
// step 1 of the same Log-CC-Purchase action, and it writes into the shared SharePoint
// receipts folder). Umbrava token in the BODY as `userToken` (the SWA edge overwrites the
// Authorization header), vouched via ../shared/umbrava-auth.js; 403 ROLE_REQUIRED below
// supervisor rank. The verified email is the logged actor.
//
// Fails CLOSED: 503 if the key, the Graph app registration, or CC_RECEIPT_FOLDER_URL is not
// configured (or Umbrava is unreachable for the vouch); 403 on a missing/wrong key or an
// insufficient role; 401 (stable `code`) on token faults; 400 on an invalid/oversized/
// unsupported file; 502 if Graph rejects the upload.
//
// REQUIRES a Graph APPLICATION permission the send-bid app does NOT already have:
//   Files.ReadWrite.All (Application) + admin consent on the AAD app registration named by
//   AAD_CLIENT_ID (or BID_CLIENT_ID). Until that's granted, Graph returns 401/403 and this
//   endpoint surfaces 502. send-bid only needs Mail.Send, so this is a NEW consent step.

const GRAPH_HOST = "graph.microsoft.com";
const LOGIN_HOST = "login.microsoftonline.com";
const MAX_BYTES = 10 * 1024 * 1024;   // 10 MB - phone photos / PDFs; simple Graph upload handles it
const OK_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/gif", "application/pdf"];
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };

const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

// Fixed-host HTTPS helper (login.microsoftonline.com / graph.microsoft.com only - no
// user-supplied hosts, so no SSRF surface). Body may be a string or a Buffer (binary upload).
function httpsReq(host, path, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method, headers }, (res) => {
      let buf = "";
      res.on("data", (d) => { buf += d; if (buf.length > 2097152) { req.destroy(); reject(new Error("response too large")); } });
      res.on("end", () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch (e) { /* some 2xx have empty/non-JSON bodies */ }
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 30000, () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// App-only token via client credentials, cached until ~60s before expiry (the process is
// reused between invocations). Mirrors api/send-bid.getGraphToken.
let tokenCache = { token: null, exp: 0 };
async function getGraphToken(tenant, clientId, secret) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const form =
    "client_id=" + encodeURIComponent(clientId) +
    "&client_secret=" + encodeURIComponent(secret) +
    "&scope=" + encodeURIComponent("https://graph.microsoft.com/.default") +
    "&grant_type=client_credentials";
  const r = await httpsReq(LOGIN_HOST, `/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, "POST",
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(form) }, form, 15000);
  if (r.status !== 200 || !r.body || !r.body.access_token) {
    throw new Error("token request failed: " + r.status + " " + (r.body && r.body.error ? r.body.error : ""));
  }
  tokenCache = { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

// Resolve the target folder (a sharing URL) to {driveId, itemId} ONCE, then cache - the
// folder is fixed, so this saves a Graph round-trip on every upload. Graph shares API:
// shareId = "u!" + base64url(url).  GET /shares/{id}/driveItem -> the folder driveItem.
let folderCache = { url: null, driveId: null, itemId: null };
async function resolveFolder(token, folderUrl) {
  if (folderCache.url === folderUrl && folderCache.driveId) return folderCache;
  const shareId = "u!" + Buffer.from(folderUrl, "utf8").toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  const r = await httpsReq(GRAPH_HOST, `/v1.0/shares/${shareId}/driveItem?$select=id,parentReference`, "GET",
    { "Authorization": "Bearer " + token, "Accept": "application/json" }, null, 20000);
  if (r.status !== 200 || !r.body || !r.body.id || !r.body.parentReference || !r.body.parentReference.driveId) {
    throw new Error("folder resolve failed: " + r.status);
  }
  folderCache = { url: folderUrl, driveId: r.body.parentReference.driveId, itemId: r.body.id };
  return folderCache;
}

function safeName(name, contentType, woNumber) {
  let base = String(name || "").replace(/[^\w.\-]+/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  if (!base) base = "receipt";
  if (!/\.[A-Za-z0-9]{2,5}$/.test(base) && EXT[contentType]) base += "." + EXT[contentType];   // ensure an extension
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");            // 2026-07-21-14-30-05
  const wo = String(woNumber || "").replace(/\D+/g, "");
  return (wo ? "W-" + wo + "_" : "") + stamp + "_" + base;
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    // -- Key gate (fail closed; 403 not 401 - see cc-purchase) -------------------
    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "connector not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!AUTH.safeStrEqual(key, expected)) { context.res = json(403, { error: "unauthorized" }); return; }

    // -- Identity + role gate (supervisor+, same boundary as cc-purchase) --------
    const auth = await AUTH.resolveUmbravaUser(req);
    if (!auth.ok) { context.res = json(auth.status, auth.body); return; }
    if (auth.user.rank < AUTH.RANK.SUPERVISOR) {
      context.log.warn("cc-receipt role denied", auth.user.email, auth.user.role);
      context.res = json(403, AUTH.roleDeniedBody(auth.user, AUTH.RANK.SUPERVISOR));
      return;
    }

    // -- Graph app + target folder must be configured (fail closed) --------------
    const tenant = process.env.BID_TENANT_ID || process.env.AAD_TENANT_ID;
    const clientId = process.env.BID_CLIENT_ID || process.env.AAD_CLIENT_ID;
    const secret = process.env.BID_CLIENT_SECRET || process.env.AAD_CLIENT_SECRET;
    const folderUrl = process.env.CC_RECEIPT_FOLDER_URL;
    if (!tenant || !clientId || !secret) { context.res = json(503, { error: "graph app not configured" }); return; }
    if (!folderUrl) { context.res = json(503, { error: "receipt folder not configured" }); return; }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    // The VERIFIED identity is the actor. Never the client-supplied `actor` (spoofable) -
    // a vouched token without an email claim logs as its sub instead.
    const actor = auth.user.email || auth.user.sub || "verified-unknown";
    const contentType = String(body.contentType || "").toLowerCase().trim();
    if (OK_TYPES.indexOf(contentType) === -1) { context.res = json(400, { error: "unsupported file type (allowed: images or PDF)" }); return; }
    let bytes;
    try { bytes = Buffer.from(String(body.dataB64 || ""), "base64"); } catch (e) { bytes = null; }
    if (!bytes || !bytes.length) { context.res = json(400, { error: "no file data" }); return; }
    if (bytes.length > MAX_BYTES) { context.res = json(400, { error: "file too large (max 10 MB)" }); return; }

    const name = safeName(body.filename, contentType, body.woNumber);
    const token = await getGraphToken(tenant, clientId, secret);
    const folder = await resolveFolder(token, folderUrl);

    // Simple upload (PUT .../content) - Graph handles this size in one request. Encode the
    // filename into the item path.
    const up = await httpsReq(
      GRAPH_HOST,
      `/v1.0/drives/${folder.driveId}/items/${folder.itemId}:/${encodeURIComponent(name)}:/content`,
      "PUT",
      { "Authorization": "Bearer " + token, "Content-Type": contentType, "Content-Length": bytes.length },
      bytes,
      45000
    );
    if (up.status !== 200 && up.status !== 201) {
      context.log.warn("cc-receipt upload rejected", up.status);
      context.res = json(502, { ok: false, error: "receipt upload failed (" + up.status + ")" });
      return;
    }
    const itemId = up.body && up.body.id;
    let link = (up.body && up.body.webUrl) || "";

    // Prefer an organization-scoped VIEW link so the Excel HYPERLINK opens for anyone in the
    // tenant (webUrl also works but can prompt). Best-effort: fall back to webUrl on failure.
    if (itemId) {
      try {
        const linkBody = JSON.stringify({ type: "view", scope: "organization" });
        const lk = await httpsReq(GRAPH_HOST, `/v1.0/drives/${folder.driveId}/items/${itemId}/createLink`, "POST",
          { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(linkBody) }, linkBody, 20000);
        if ((lk.status === 200 || lk.status === 201) && lk.body && lk.body.link && lk.body.link.webUrl) link = lk.body.link.webUrl;
      } catch (e) { /* keep webUrl */ }
    }

    context.log("cc-receipt uploaded", actor, name, bytes.length);
    context.res = json(200, { ok: true, link: link, name: name });
  } catch (err) {
    context.log.error("cc-receipt error:", err && err.message ? err.message : err);
    context.res = json(500, { error: "cc-receipt error" });
  }
};
