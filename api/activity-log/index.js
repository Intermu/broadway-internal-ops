const { BlobServiceClient } = require("@azure/storage-blob");

// Append-only activity / change log. One blob per client at
// clients/<client>/activity-log holding { v:1, entries:[ ... ] }, newest last.
// Each entry is server-stamped (who + ts) so the audit trail can't be forged by
// the browser. Mirrors data-store conventions (same container, same client
// allowlist) but is deliberately a SEPARATE function with its own blob path -
// data-store's VALID_SLOTS does not include "activity-log", so a stray
// data-store POST can never overwrite the trail.
//
// Writes use optimistic concurrency (If-Match / If-None-Match) with a small
// retry loop, so two coordinators logging at the same moment can't clobber each
// other's entries - the loser re-reads and re-appends.
//
//   GET  /api/activity-log?client=pilot[&limit=N][&target=<jobId>]
//        → { entries: [...] }  (most recent N, default 100; optional target filter)
//   POST /api/activity-log?client=pilot   body { action, slot?, target?, detail? }
//        → { ok:true, entry }

const CONTAINER_NAME = "broadway-data";
const VALID_CLIENTS = ["pilot"];

// Bound the trail so the blob can't grow without limit. This is "append-only"
// in spirit - the oldest entries beyond the cap roll off (a separate archive
// job can be added later if full retention is ever required).
const MAX_ENTRIES = 2000;
const MAX_RETRIES = 5;

// Allowlist the verbs the UI may record, so a stray/abusive client can't inject
// arbitrary text into the audit trail. Add new verbs here as features log them.
const VALID_ACTIONS = [
  "ack", "unack", "snooze", "unsnooze", "note",
  "snapshot-save", "vendor-override", "config-change", "review-ack",
];

function principalFromReq(req) {
  try {
    const h = req.headers && (req.headers["x-ms-client-principal"] || req.headers["X-MS-CLIENT-PRINCIPAL"]);
    if (!h) return null;
    return JSON.parse(Buffer.from(h, "base64").toString("utf-8"));
  } catch (e) {
    return null;
  }
}

function whoFromReq(req) {
  const p = principalFromReq(req);
  if (!p) return { name: "unknown", id: null };
  return { name: p.userDetails || "unknown", id: p.userId || null };
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

function blobName(client) {
  return `clients/${client}/activity-log`;
}

async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Read entries + current etag. Returns { entries, etag, exists }.
async function readLog(blob) {
  try {
    const dl = await blob.download();
    const text = await streamToString(dl.readableStreamBody);
    const log = JSON.parse(text);
    // Etag from the SAME download response (atomic with content) - a separate
    // getProperties() opens a TOCTOU now that wo-ingest is a second concurrent writer.
    return { entries: Array.isArray(log.entries) ? log.entries : [], etag: dl.etag, exists: true };
  } catch (err) {
    if (err.statusCode === 404) return { entries: [], etag: null, exists: false };
    throw err;
  }
}

module.exports = async function (context, req) {
  try {
    const params = req.query || {};
    const client = params.client;
    if (!client || !VALID_CLIENTS.includes(client)) {
      context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Missing or unknown 'client' query param" } };
      return;
    }

    const container = await getContainerClient();
    const blob = container.getBlockBlobClient(blobName(client));

    if (req.method === "GET") {
      const limit = Math.min(Math.max(parseInt(params.limit, 10) || 100, 1), MAX_ENTRIES);
      const target = params.target ? String(params.target) : null;
      const { entries } = await readLog(blob);
      const filtered = target ? entries.filter((e) => e && e.target === target) : entries;
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { entries: filtered.slice(-limit) } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const action = String(body.action || "").trim();
      if (!VALID_ACTIONS.includes(action)) {
        context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: `Invalid action '${action}'. Valid: ${VALID_ACTIONS.join(", ")}` } };
        return;
      }
      const who = whoFromReq(req);
      const entry = {
        ts: new Date().toISOString(), // SERVER time - never trust a client clock
        who: who.name,
        whoId: who.id,
        action,
        slot: body.slot ? String(body.slot).slice(0, 64) : null,
        target: body.target ? String(body.target).slice(0, 128) : null, // e.g. Job ID
        detail: body.detail ? String(body.detail).slice(0, 500) : null,
      };

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const { entries, etag, exists } = await readLog(blob);
        let next = entries.concat([entry]);
        if (next.length > MAX_ENTRIES) next = next.slice(-MAX_ENTRIES);
        const out = JSON.stringify({ v: 1, entries: next });
        // exists → only write if unchanged; new → only write if still absent.
        const conditions = exists ? { ifMatch: etag } : { ifNoneMatch: "*" };
        try {
          await blob.upload(out, Buffer.byteLength(out), {
            blobHTTPHeaders: { blobContentType: "application/json" },
            conditions,
          });
          context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true, entry } };
          return;
        } catch (err) {
          // 412 (etag moved) or 409 (someone created it first) → re-read & retry.
          if (err.statusCode === 412 || err.statusCode === 409) continue;
          throw err;
        }
      }
      context.res = { status: 503, headers: { "Content-Type": "application/json" }, body: { error: "activity-log write contended; please retry" } };
      return;
    }

    context.res = { status: 405, body: "Method Not Allowed" };
  } catch (err) {
    context.log.error("activity-log error:", err);
    context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { error: err.message || "activity-log error" } };
  }
};
