const { BlobServiceClient } = require("@azure/storage-blob");

// Read side of Bid-Out per-vendor read-receipts (Stage 3). The userscript runs on
// app.umbrava.com (NOT federated to Broadway AAD), so - like wo-ingest/send-bid - this is
// reached ANONYMOUSLY at the SWA route layer and gated by the shared x-bwn-key. It only
// READS opens that track-open recorded; it never writes and never sends.
//
//   GET /api/bid-status?sendId=<id>       header x-bwn-key: <WO_INGEST_KEY>
//     -> { ok, send: { sendId, ts, subject, tracking, vendors:[{ email, opened, openCount,
//                        firstOpenTs, lastOpenTs, sendOk }] } }
//   GET /api/bid-status?tracking=<woTracking>   (resolves via the by-tracking index)
//     -> { ok, sends: [ <send>, ... ] }   (most recent first)
//
// Fails closed: 503 if the key is unset, 403 on a wrong/absent key.

const CONTAINER_NAME = "broadway-data";
const OPENS_PREFIX = "bid-opens/";
const TRACK_INDEX_PREFIX = "bid-opens/by-tracking/";
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_SENDS = 25;   // cap fan-out when resolving a busy tracking #

const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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
    return service.getContainerClient(CONTAINER_NAME);
  })().catch((err) => { containerClientPromise = null; throw err; });   // never cache a rejection
  return containerClientPromise;
}

async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(container, name) {
  let text;
  try {
    const dl = await container.getBlockBlobClient(name).download();
    text = await streamToString(dl.readableStreamBody);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
  // A single corrupt blob must not 500 the whole lookup - treat unparseable as absent.
  try { return JSON.parse(text); } catch (e) { return null; }
}

// Project the stored record down to what the UI needs (no internal fields like token).
function publicSend(rec) {
  if (!rec) return null;
  const vendors = (Array.isArray(rec.vendors) ? rec.vendors : []).map((v) => ({
    email: v.email || "",
    name: v.name || "",
    opened: !!v.opened,
    openCount: Number(v.openCount) || 0,
    firstOpenTs: v.firstOpenTs || null,
    lastOpenTs: v.lastOpenTs || null,
    sendOk: v.sendOk !== false,
  }));
  return { sendId: rec.sendId || "", ts: rec.ts || "", subject: rec.subject || "", tracking: rec.tracking || "", vendors };
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!key || key !== expected) { context.res = json(403, { error: "unauthorized" }); return; }

    const q = req.query || {};
    const sendId = String(q.sendId || "").trim();
    const tracking = String(q.tracking || "").trim();
    const container = await getContainerClient();

    if (sendId) {
      if (!ID_RE.test(sendId)) { context.res = json(400, { error: "bad sendId" }); return; }
      const rec = await readJson(container, OPENS_PREFIX + sendId);
      if (!rec) { context.res = json(404, { error: "unknown sendId" }); return; }
      context.res = json(200, { ok: true, send: publicSend(rec) });
      return;
    }

    if (tracking) {
      // Tracking # is caller-supplied free text; only alnum is used to name the index blob.
      const safe = tracking.replace(/[^A-Za-z0-9_-]/g, "");
      if (!safe) { context.res = json(400, { error: "bad tracking" }); return; }
      const idx = await readJson(container, TRACK_INDEX_PREFIX + safe);
      const ids = (idx && Array.isArray(idx.sendIds) ? idx.sendIds : []).filter((s) => ID_RE.test(s)).slice(-MAX_SENDS).reverse();
      const sends = [];
      for (const id of ids) {
        const rec = await readJson(container, OPENS_PREFIX + id);
        if (rec) sends.push(publicSend(rec));
      }
      context.res = json(200, { ok: true, sends });
      return;
    }

    context.res = json(400, { error: "provide sendId or tracking" });
  } catch (err) {
    context.log.error("bid-status error", err && err.message);
    context.res = json(500, { error: "internal error" });
  }
};
