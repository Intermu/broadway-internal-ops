const { BlobServiceClient } = require("@azure/storage-blob");

// Open-tracking pixel for BWN Bid-Out per-vendor RFP sends (Stage 3 read-receipts).
//
// send-bid (per-vendor mode) injects, into each vendor's individual email, a 1x1 image:
//   GET /api/track-open?s=<sendId>&v=<opaqueToken>
// When the vendor's mail client loads it, this records an "opened" event against that
// vendor in the send's opens blob (bid-opens/<sendId>). The pixel URL carries only OPAQUE
// server-generated ids - never the vendor email - so no personal data rides the query string.
//
// Reached ANONYMOUSLY (email clients cannot send our x-bwn-key). It therefore does the
// minimum: match sendId+token to a known record and flip its flag. It NEVER reveals whether
// a match was found - it always returns the same 1x1 GIF, 200, no-cache - so the endpoint
// leaks nothing to a prober and can't be used to enumerate ids.
//
// HONESTY: this is a SOFT signal. Apple Mail Privacy Protection pre-fetches all images
// (records a false "open"); Gmail proxies/caches them. Treat "opened" as "likely delivered
// and surfaced", never as proof a human read it. It is a follow-up prioritization hint.

const CONTAINER_NAME = "broadway-data";
const OPENS_PREFIX = "bid-opens/";
const MAX_RETRIES = 5;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

// Canonical 1x1 transparent GIF (43 bytes).
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function pixelRes() {
  return {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma": "no-cache",
      "Expires": "0",
    },
    body: PIXEL,
    isRaw: true,
  };
}

let containerClientPromise = null;
function getContainerClient() {
  if (containerClientPromise) return containerClientPromise;
  containerClientPromise = (async () => {
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(CONTAINER_NAME);
    return container;   // send-bid already createIfNotExists; a pixel never creates the container
  })().catch((err) => { containerClientPromise = null; throw err; });   // never cache a rejection
  return containerClientPromise;
}

async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Best-effort record of an open. Never throws into the response path - a tracking failure
// must not stop the pixel from rendering (a broken image in a vendor's inbox looks alarming).
async function recordOpen(sendId, token, whenIso) {
  const container = await getContainerClient();
  const blob = container.getBlockBlobClient(OPENS_PREFIX + sendId);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let dl;
    try {
      dl = await blob.download();
    } catch (err) {
      return;   // 404 (no such send) or transient - nothing to record; stay silent
    }
    let parsed;
    try { parsed = JSON.parse(await streamToString(dl.readableStreamBody)); } catch (e) { return; }
    const vendors = parsed && Array.isArray(parsed.vendors) ? parsed.vendors : [];
    const v = vendors.find((x) => x && x.token === token);
    if (!v) return;                         // unknown token for this send - ignore
    v.openCount = (Number(v.openCount) || 0) + 1;
    if (!v.opened) { v.opened = true; v.firstOpenTs = whenIso; }
    v.lastOpenTs = whenIso;
    const out = JSON.stringify(parsed);
    try {
      await blob.upload(out, Buffer.byteLength(out), {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: { ifMatch: dl.etag },
      });
      return;
    } catch (err) {
      if (err.statusCode === 412 || err.statusCode === 409) continue;   // raced - re-read + retry
      return;   // give up quietly
    }
  }
}

module.exports = async function (context, req) {
  // Whatever happens, return the pixel. Tracking is a side effect, never a gate.
  try {
    const q = req.query || {};
    const sendId = String(q.s || "").trim();
    const token = String(q.v || "").trim();
    if (req.method !== "HEAD" && ID_RE.test(sendId) && ID_RE.test(token)) {
      await recordOpen(sendId, token, new Date().toISOString());
    }
  } catch (err) {
    context.log.error("track-open error", err && err.message);
  }
  context.res = pixelRes();
};
