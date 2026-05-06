const { BlobServiceClient } = require("@azure/storage-blob");

const CONTAINER_NAME = "broadway-data";
const VALID_KEYS = ["pilot-revenue", "wo-snapshot-today", "wo-snapshot-previous", "workbook"];

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
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readBlob(container, key) {
  const blob = container.getBlockBlobClient(key);
  try {
    const dl = await blob.download();
    const text = await streamToString(dl.readableStreamBody);
    const data = JSON.parse(text);
    const props = await blob.getProperties();
    // Azure stores metadata as string-only key/values; we tucked saved metadata into a sidecar key inside the blob itself
    const metadata = props.metadata || {};
    return { data, metadata, exists: true };
  } catch (err) {
    if (err.statusCode === 404) return { exists: false, data: null, metadata: null };
    throw err;
  }
}

async function writeBlob(container, key, data, metadata) {
  const blob = container.getBlockBlobClient(key);
  const body = JSON.stringify(data);
  // Azure metadata values must be ASCII strings, no nesting. Stringify any non-string values.
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

async function deleteBlob(container, key) {
  const blob = container.getBlockBlobClient(key);
  await blob.deleteIfExists();
}

module.exports = async function (context, req) {
  try {
    const container = await getContainerClient();
    const params = req.query || {};
    const key = params.key;
    const action = params.action;

    if (action === "list") {
      const out = {};
      await Promise.all(
        VALID_KEYS.map(async (k) => {
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
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: out,
      };
      return;
    }

    if (!key || !VALID_KEYS.includes(key)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Invalid or missing 'key' query param" },
      };
      return;
    }

    if (req.method === "GET") {
      const result = await readBlob(container, key);
      if (!result.exists) {
        context.res = {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { exists: false, data: null, metadata: null },
        };
        return;
      }
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { exists: true, data: result.data, metadata: result.metadata },
      };
      return;
    }

    if (req.method === "POST") {
      const incoming = req.body || {};
      const { data, metadata } = incoming;
      if (data === undefined || data === null) {
        context.res = {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: { error: "Missing 'data' field in body" },
        };
        return;
      }
      const meta = { ...(metadata || {}), savedAt: new Date().toISOString() };

      // Snapshot rotation: if today's snapshot is being replaced with a new date, archive the old one as "previous"
      if (key === "wo-snapshot-today") {
        const existing = await readBlob(container, "wo-snapshot-today");
        if (existing.exists && existing.data && existing.data.dateStr && data.dateStr && existing.data.dateStr !== data.dateStr) {
          await writeBlob(container, "wo-snapshot-previous", existing.data, existing.metadata || {});
        }
      }

      await writeBlob(container, key, data, meta);

      let extra = {};
      if (key === "wo-snapshot-today") {
        const prev = await readBlob(container, "wo-snapshot-previous");
        extra.previous = prev.exists ? prev.data : null;
      }
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { ok: true, key, metadata: meta, ...extra },
      };
      return;
    }

    if (req.method === "DELETE") {
      await deleteBlob(container, key);
      if (key === "wo-snapshot-today") {
        await deleteBlob(container, "wo-snapshot-previous");
      }
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { ok: true },
      };
      return;
    }

    context.res = { status: 405, body: "Method Not Allowed" };
  } catch (err) {
    context.log.error("data-store error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err.message || "data-store error" },
    };
  }
};
