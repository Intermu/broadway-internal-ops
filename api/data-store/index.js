const { BlobServiceClient } = require("@azure/storage-blob");

const CONTAINER_NAME = "broadway-data";

// SLOTS are types of data. Same set for every client.
// Adding a slot = ship code. Adding a client = edit VALID_CLIENTS below.
const VALID_SLOTS = ["revenue", "wo-snapshot-today", "wo-snapshot-previous", "workbook", "over30-history", "job-notes", "config", "checkin", "om-bonus", "wo-audit", "exception-queue", "o30-lines", "job-plans", "live-jobs"];
// "o30-lines": per-client Over-30 audit lines + board trend, WRITTEN by the userscript
// connector via /api/wo-ingest (key-gated); the dashboard READS it here (AAD gate):
//   { v:1, items:{ "<tracking>": { line, ts, by, prev:[{line,ts,by}×≤4] } },
//     trend:{ "YYYY-MM-DD": { over30, open, bad, warn, by, ts } } }.
// "job-plans": per-client authored "Next Actions Required" plans the Umbrava checklist
// is running off, pushed job→dashboard by the connector (key-gated /api/wo-ingest);
// the dashboard READS it here (AAD gate) to mirror a plan typed in an Umbrava note:
//   { v:1, plans:{ "<tracking>": { items:[...], src, ts, by } } }. Read-only here.
// "exception-queue": one blob per client holding the ack/snooze state for the
// Dashboard Exception Queue, keyed by Job ID:
//   { v:1, items: { "<jobId>": { state:"ack"|"snooze", until?:"YYYY-MM-DD", by, ts, note? } } }.
// Written with optimistic concurrency (If-Match) so two coordinators acking at
// once can't silently clobber each other. Not financial -> broadway_employee gate.
// "wo-audit": one blob per client holding a tracking-keyed map of AI case files
// { v:1, items: { "<tracking>": { tracking, wo, title, sub, base:{text,ts}|null, updates:[{text,ts,win}] } } }.
// WO Audit notes set .base (full case file); Recent Update notes append to .updates[].
// Not financial -> stays at the broadway_employee gate (coordinators can read/write).

// Each onboarded client gets one string here. Onboarding Wendy's = add "wendys".
const VALID_CLIENTS = ["pilot"];

// ── Role gating ──────────────────────────────────────────────────────────
// Slots holding financial data (GP / revenue) require Operations Manager (L4)
// or above to READ. Everything else stays at the broadway_employee gate that
// the SWA route config already enforces. Server-side because the front-end /
// route checks are convenience only - this is the real boundary.
// NOTE: "revenue" is intentionally NOT in this list -- coordinators are meant
// to read the monthly revenue numbers (approved by Mike, 2026-06), so it stays
// at the broadway_employee gate. The "revenue-gp" GP lookup remains Operations
// Manager (L4)+ only.
const FINANCIAL_SLOTS = ["revenue-gp"];
const ROLE_LEVELS = ["ops_coordinator", "lead_ops_coordinator", "ops_supervisor", "ops_manager", "dir_ops", "vp_ops"];
const MIN_FINANCIAL_LEVEL = 4; // ops_manager

function principalFromReq(req) {
  try {
    const h = req.headers && (req.headers["x-ms-client-principal"] || req.headers["X-MS-CLIENT-PRINCIPAL"]);
    if (!h) return null;
    return JSON.parse(Buffer.from(h, "base64").toString("utf-8"));
  } catch (e) {
    return null;
  }
}

function roleLevelFromReq(req) {
  const p = principalFromReq(req);
  const roles = (p && p.userRoles) || [];
  let max = 0;
  ROLE_LEVELS.forEach((slug, i) => { if (roles.indexOf(slug) !== -1) max = Math.max(max, i + 1); });
  return max;
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
    return { data, metadata, etag: props.etag, exists: true };
  } catch (err) {
    if (err.statusCode === 404) return { exists: false, data: null, metadata: null, etag: null };
    throw err;
  }
}

// Returns { etag } of the written blob. `opts.ifMatch` enables optimistic
// concurrency: the upload only succeeds if the blob's current etag matches,
// otherwise Azure throws a 412 (ConditionNotMet) which the POST handler turns
// into a 412 response so the client can re-read, merge, and retry. Callers that
// pass no opts keep the prior last-write-wins behavior (backward compatible).
async function writeBlob(container, name, data, metadata, opts) {
  const blob = container.getBlockBlobClient(name);
  const body = JSON.stringify(data);
  const flatMeta = {};
  for (const [k, v] of Object.entries(metadata || {})) {
    if (v === null || v === undefined) continue;
    // Blob metadata is sent as HTTP headers and must be ASCII - non-ASCII
    // chars (e.g. the en-dash in "Jan–May 2026") make the upload throw.
    // Replace anything outside printable ASCII with a plain hyphen.
    const s = typeof v === "string" ? v : String(v);
    flatMeta[k] = s.replace(/[^\x20-\x7E]/g, "-");
  }
  const uploadOpts = {
    blobHTTPHeaders: { blobContentType: "application/json" },
    metadata: flatMeta,
  };
  if (opts && opts.ifMatch) uploadOpts.conditions = { ifMatch: opts.ifMatch };
  else if (opts && opts.ifNoneMatch) uploadOpts.conditions = { ifNoneMatch: opts.ifNoneMatch };
  const res = await blob.upload(body, Buffer.byteLength(body), uploadOpts);
  return { etag: res.etag };
}

async function deleteBlob(container, name) {
  const blob = container.getBlockBlobClient(name);
  await blob.deleteIfExists();
}

// Resolve incoming request params into a validated { client, slot, blobName }
// triple, or return an error response object to send back.
function resolveTarget(params) {
  const slot = params.key;
  const client = params.client;

  // Both params required, and both must be allowlisted.
  if (client) {
    if (!VALID_CLIENTS.includes(client)) {
      return { error: { status: 400, body: { error: `Unknown client '${client}'` } } };
    }
    if (!VALID_SLOTS.includes(slot)) {
      return { error: { status: 400, body: { error: `Invalid slot '${slot}'. Valid: ${VALID_SLOTS.join(", ")}` } } };
    }
    return { client, slot, name: blobName(client, slot) };
  }

  return {
    error: {
      status: 400,
      body: { error: "Missing 'client' query param" },
    },
  };
}

module.exports = async function (context, req) {
  try {
    const container = await getContainerClient();
    const params = req.query || {};
    const action = params.action;

    // ── list action ─────────────────────────────────────────────────────
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

      context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Missing 'client' query param" } };
      return;
    }

    // ── get / post / delete a single blob ───────────────────────────────
    const resolved = resolveTarget(params);
    if (resolved.error) {
      context.res = { status: resolved.error.status, headers: { "Content-Type": "application/json" }, body: resolved.error.body };
      return;
    }
    const { client, slot, name: targetName } = resolved;

    // Financial slots: require Operations Manager (L4)+ to READ. Fail closed.
    if (req.method === "GET" && FINANCIAL_SLOTS.includes(slot)) {
      if (roleLevelFromReq(req) < MIN_FINANCIAL_LEVEL) {
        context.res = { status: 403, headers: { "Content-Type": "application/json" }, body: { error: "Insufficient role for financial data" } };
        return;
      }
    }

    if (req.method === "GET") {
      const result = await readBlob(container, targetName);
      if (!result.exists) {
        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { exists: false, data: null, metadata: null } };
        return;
      }
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { exists: true, data: result.data, metadata: result.metadata, etag: result.etag } };
      return;
    }

    // Slots owned by the wo-ingest writer: the dashboard (and any employee) reads them
    // here, but writes/deletes must go through /api/wo-ingest's merge logic - an
    // unconditional data-store POST would last-write-wins clobber concurrent upserts.
    if ((req.method === "POST" || req.method === "DELETE") && (slot === "o30-lines" || slot === "job-plans")) {
      context.res = { status: 405, headers: { "Content-Type": "application/json" }, body: { error: slot + " is written via /api/wo-ingest - read-only here" } };
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

      // Optimistic concurrency: an If-Match etag (HTTP header or body.ifMatch)
      // makes this write conditional. SWA/Functions lowercases header names.
      const ifMatch = (req.headers && (req.headers["if-match"] || req.headers["If-Match"])) || incoming.ifMatch || null;

      // Snapshot rotation: when today's snapshot is replaced with a different
      // date, archive the existing one as "previous" first. Per-client because
      // both blobs are scoped under the same client prefix.
      if (slot === "wo-snapshot-today") {
        const todayName = blobName(client, "wo-snapshot-today");
        const previousName = blobName(client, "wo-snapshot-previous");
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

      let writeRes;
      try {
        writeRes = await writeBlob(container, targetName, data, meta, ifMatch ? { ifMatch } : undefined);
      } catch (err) {
        // 412 = the blob changed since the client read it. Hand back the
        // current etag so the caller can re-read, merge, and retry.
        if (err.statusCode === 412) {
          const cur = await readBlob(container, targetName);
          context.res = { status: 412, headers: { "Content-Type": "application/json" }, body: { error: "etag mismatch - blob changed since read", etag: cur.etag || null } };
          return;
        }
        throw err;
      }

      let extra = {};
      if (slot === "wo-snapshot-today") {
        const previousName = blobName(client, "wo-snapshot-previous");
        const prev = await readBlob(container, previousName);
        extra.previous = prev.exists ? prev.data : null;
      }
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true, client, slot, metadata: meta, etag: writeRes.etag, ...extra } };
      return;
    }

    if (req.method === "DELETE") {
      await deleteBlob(container, targetName);
      // Deleting today's snapshot also clears the rotated "previous" copy,
      // since "previous" without "today" is a confusing partial state.
      if (slot === "wo-snapshot-today") {
        const previousName = blobName(client, "wo-snapshot-previous");
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
