const { BlobServiceClient } = require("@azure/storage-blob");

const CONTAINER_NAME = "broadway-data";

// SLOTS are types of data. Same set for every client.
// Adding a slot = ship code. Adding a client = edit VALID_CLIENTS below.
const VALID_SLOTS = ["revenue", "wo-snapshot-today", "wo-snapshot-previous", "workbook"];

// Each onboarded client gets one string here. Onboarding Wendy's = add "wendys".
const VALID_CLIENTS = ["pilot"];

// Legacy flat-key support: requests without a 'client' param fall through to
// the old top-level blob names so the frontends keep working during rollout.
// Remove this block after every HTML is updated and you've verified traffic
// has fully cut over (check App Insights for any GET /api/data-store calls
// without a 'client' param; once that count hits zero for ~24h, delete).
const LEGACY_KEYS = ["pilot-revenue", "wo-snapshot-today", "wo-snapshot-previous", "workbook"];

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

function blobName(client, slot) {
  // Defense in depth: both pieces have been allowlisted above before we get
  // here, so this can't produce a traversal path, but the explicit shape makes
  // intent obvious for anyone reading the blob browser later.
  return `clients/${client}/${slot}`;
}

async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readBlob(container, name) {
  const blob = container.getBlockBlobClient(name);
  try {
    const dl = await blob.download();
    const text = await streamToString(dl.readableStreamBody);
    const data = JSON.parse(text);
    const props = await blob.getProperties();
    const metadata = props.metadata || {};
    return { data, metadata, exists: true };
  } catch (err) {
    if (err.statusCode === 404) return { exists: false, data: null, metadata: null };
    throw err;
  }
}

async function writeBlob(container, name, data, metadata) {
  const blob = container.getBlockBlobClient(name);
  const body = JSON.stringify(data);
  const flatMeta = {};
  for (const [k, v] of Object.entries(metadata || {})) {
    if (v === null || v === undefined) continue;
    flatMeta[k] = typeof v === "string" ? v : String(v);
  }
  await blob.upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    metadata: flatMeta,
  });
}

async function deleteBlob(container, name) {
  const blob = container.getBlockBlobClient(name);
  await blob.deleteIfExists();
}

// Resolve incoming request params into a validated { client, slot, blobName }
// triple, or return an error response object to send back. Centralized so the
// legacy and modern paths share validation behavior.
function resolveTarget(params) {
  const slot = params.key;
  const client = params.client;

  // Modern path: both params present and both allowlisted.
  if (client) {
    if (!VALID_CLIENTS.includes(client)) {
      return { error: { status: 400, body: { error: `Unknown client '${client}'` } } };
    }
    if (!VALID_SLOTS.includes(slot)) {
      return { error: { status: 400, body: { error: `Invalid slot '${slot}'. Valid: ${VALID_SLOTS.join(", ")}` } } };
    }
    return { client, slot, name: blobName(client, slot) };
  }

  // Legacy path: only the old flat keys, no client namespace.
  // Resolves to the same blob name as before, preserving existing behavior.
  if (LEGACY_KEYS.includes(slot)) {
    return { client: null, slot, name: slot, legacy: true };
  }

  return {
    error: {
      status: 400,
      body: { error: "Missing 'client' query param, or 'key' is not a valid legacy key" },
    },
  };
}

module.exports = async function (context, req) {
  try {
    const container = await getContainerClient();
    const params = req.query || {};
    const action = params.action;

    // ── list action ─────────────────────────────────────────────────────
    // /api/data-store?action=list                  → legacy: lists flat keys
    // /api/data-store?action=list&client=pilot     → lists this client's slots
    if (action === "list") {
      if (params.client) {
        if (!VALID_CLIENTS.includes(params.client)) {
          context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: `Unknown client '${params.client}'` } };
          return;
        }
        const out = {};
        await Promise.all(
          VALID_SLOTS.map(async (slot) => {
            const blob = container.getBlockBlobClient(blobName(params.client, slot));
            try {
              const props = await blob.getProperties();
              out[slot] = { exists: true, ...(props.metadata || {}) };
            } catch (err) {
              if (err.statusCode === 404) out[slot] = { exists: false };
              else throw err;
            }
          })
        );
        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: out };
        return;
      }

      // Legacy list — pre-rollout frontends call this with no client param.
      const out = {};
      await Promise.all(
        LEGACY_KEYS.map(async (k) => {
          const blob = container.getBlockBlobClient(k);
          try {
            const props = await blob.getProperties();
            out[k] = { exists: true, ...(props.metadata || {}) };
          } catch (err) {
            if (err.statusCode === 404) out[k] = { exists: false };
            else throw err;
          }
        })
      );
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: out };
      return;
    }

    // ── get / post / delete a single blob ───────────────────────────────
    const resolved = resolveTarget(params);
    if (resolved.error) {
      context.res = { status: resolved.error.status, headers: { "Content-Type": "application/json" }, body: resolved.error.body };
      return;
    }
    const { client, slot, name: targetName } = resolved;

    if (req.method === "GET") {
      const result = await readBlob(container, targetName);
      if (!result.exists) {
        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { exists: false, data: null, metadata: null } };
        return;
      }
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { exists: true, data: result.data, metadata: result.metadata } };
      return;
    }

    if (req.method === "POST") {
      const incoming = req.body || {};
      const { data, metadata } = incoming;
      if (data === undefined || data === null) {
        context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Missing 'data' field in body" } };
        return;
      }
      const meta = { ...(metadata || {}), savedAt: new Date().toISOString() };

      // Snapshot rotation: when today's snapshot is replaced with a different
      // date, archive the existing one as "previous" first. Per-client because
      // both blobs are scoped under the same client prefix.
      if (slot === "wo-snapshot-today") {
        const todayName = client ? blobName(client, "wo-snapshot-today") : "wo-snapshot-today";
        const previousName = client ? blobName(client, "wo-snapshot-previous") : "wo-snapshot-previous";
        const existing = await readBlob(container, todayName);
        if (
          existing.exists &&
          existing.data &&
          existing.data.dateStr &&
          data.dateStr &&
          existing.data.dateStr !== data.dateStr
        ) {
          await writeBlob(container, previousName, existing.data, existing.metadata || {});
        }
      }

      await writeBlob(container, targetName, data, meta);

      let extra = {};
      if (slot === "wo-snapshot-today") {
        const previousName = client ? blobName(client, "wo-snapshot-previous") : "wo-snapshot-previous";
        const prev = await readBlob(container, previousName);
        extra.previous = prev.exists ? prev.data : null;
      }
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true, client, slot, metadata: meta, ...extra } };
      return;
    }

    if (req.method === "DELETE") {
      await deleteBlob(container, targetName);
      // Deleting today's snapshot also clears the rotated "previous" copy,
      // since "previous" without "today" is a confusing partial state.
      if (slot === "wo-snapshot-today") {
        const previousName = client ? blobName(client, "wo-snapshot-previous") : "wo-snapshot-previous";
        await deleteBlob(container, previousName);
      }
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true } };
      return;
    }

    context.res = { status: 405, body: "Method Not Allowed" };
  } catch (err) {
    context.log.error("data-store error:", err);
    context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { error: err.message || "data-store error" } };
  }
};
