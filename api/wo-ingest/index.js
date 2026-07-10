const { BlobServiceClient } = require("@azure/storage-blob");

// WO-action ingest for the BWN userscript connector (Phase 2).
//
// The BWN AI userscript runs inside app.umbrava.com — a DIFFERENT origin that is NOT
// federated to Broadway's Entra tenant, so it cannot present the AAD principal the rest
// of /api/* relies on. This endpoint is therefore reachable ANONYMOUSLY at the SWA route
// layer (see staticwebapp.config.json) and gates itself with a shared FUNCTION KEY
// (app setting WO_INGEST_KEY, sent as the `x-bwn-key` header). It appends WO-action events
// to the SAME per-client activity-log blob the dashboard uses, so they show in the Activity
// Log view + rollup — but tagged `source:"userscript"` and carrying the Umbrava-logged-in
// actor (self-declared, NOT cryptographically verified). The dashboard's AAD-stamped
// entries remain the authoritative record; this feed is coordinator-convenience history.
//
//   POST /api/wo-ingest?client=pilot   header x-bwn-key: <WO_INGEST_KEY>
//        body { actor?, events:[{action, target?, detail?}] }  (or a single {action,...})
//        → { ok:true, added:N }
//
// Fails CLOSED: 503 if WO_INGEST_KEY is not configured, 401 on a missing/wrong key.

const CONTAINER_NAME = "broadway-data";
const VALID_CLIENTS = ["pilot"];
const MAX_ENTRIES = 2000;   // matches activity-log; oldest roll off
const MAX_RETRIES = 5;
const MAX_BATCH = 50;

// Userscript-sourced verbs. Distinct from the dashboard's activity-log allowlist so a
// leaked key can't inject dashboard-authority verbs (ack/config-change/etc.).
const VALID_ACTIONS = ["na-done", "na-undone", "escalate", "ecd-set", "chase", "po-cost-confirm", "note"];

// CORS is belt-and-suspenders: Tampermonkey's GM_xmlhttpRequest bypasses the browser's
// same-origin policy (that's what @connect authorizes), so these headers aren't strictly
// needed — but they scope any normal-fetch caller to the Umbrava origin.
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

async function readLog(blob) {
  try {
    const dl = await blob.download();
    const text = await streamToString(dl.readableStreamBody);
    const log = JSON.parse(text);
    const props = await blob.getProperties();
    return { entries: Array.isArray(log.entries) ? log.entries : [], etag: props.etag, exists: true };
  } catch (err) {
    if (err.statusCode === 404) return { entries: [], etag: null, exists: false };
    throw err;
  }
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    // ── Key gate (fail closed) ────────────────────────────────────────────
    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "ingest not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!key || key !== expected) { context.res = json(401, { error: "unauthorized" }); return; }

    const params = req.query || {};
    const body = req.body || {};
    const client = params.client || body.client;
    if (!client || !VALID_CLIENTS.includes(client)) { context.res = json(400, { error: "missing or unknown 'client'" }); return; }

    const actor = body.actor ? String(body.actor).slice(0, 128) : "unknown";
    const rawEvents = Array.isArray(body.events) ? body.events : (body.action ? [body] : []);
    if (!rawEvents.length) { context.res = json(400, { error: "no events" }); return; }

    // Server-stamped time; validated + capped. Unknown verbs are skipped (a stray one
    // must not fail the whole batch), so a batch of all-unknown verbs yields 400.
    const stamp = new Date().toISOString();
    const entries = [];
    for (const ev of rawEvents.slice(0, MAX_BATCH)) {
      const action = String((ev && ev.action) || "").trim();
      if (VALID_ACTIONS.indexOf(action) === -1) continue;
      entries.push({
        ts: stamp,
        who: actor,
        whoId: null,
        source: "userscript",
        action,
        target: ev.target ? String(ev.target).slice(0, 128) : null,
        detail: ev.detail ? String(ev.detail).slice(0, 500) : null,
      });
    }
    if (!entries.length) { context.res = json(400, { error: "no valid events" }); return; }

    const container = await getContainerClient();
    const blob = container.getBlockBlobClient(blobName(client));

    // Append with optimistic concurrency + retry, exactly like the activity-log Function,
    // so the two writers (dashboard AAD + this key-gated ingest) never clobber the trail.
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { entries: existing, etag, exists } = await readLog(blob);
      let next = existing.concat(entries);
      if (next.length > MAX_ENTRIES) next = next.slice(-MAX_ENTRIES);
      const out = JSON.stringify({ v: 1, entries: next });
      const conditions = exists ? { ifMatch: etag } : { ifNoneMatch: "*" };
      try {
        await blob.upload(out, Buffer.byteLength(out), {
          blobHTTPHeaders: { blobContentType: "application/json" },
          conditions,
        });
        context.res = json(200, { ok: true, added: entries.length });
        return;
      } catch (err) {
        if (err.statusCode === 412 || err.statusCode === 409) continue;
        throw err;
      }
    }
    context.res = json(503, { error: "activity-log write contended; please retry" });
  } catch (err) {
    context.log.error("wo-ingest error:", err);
    context.res = json(500, { error: err.message || "wo-ingest error" });
  }
};
