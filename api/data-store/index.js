const { BlobServiceClient } = require("@azure/storage-blob");

const CONTAINER_NAME = "broadway-data";

// SLOTS are types of data. Same set for every client.
// Adding a slot = ship code. Adding a client = edit VALID_CLIENTS below.
const VALID_SLOTS = ["revenue", "revenue-gp", "wo-snapshot-today", "wo-snapshot-previous", "workbook", "wo-dataset", "wo-snapshot-history", "over30-history", "job-notes", "config", "checkin", "om-bonus", "wo-audit", "exception-queue", "o30-lines", "job-plans", "live-jobs", "job-divisions", "knowledge"];
// "knowledge": the team-authored knowledge doc the BWN Ask copilot (bwn-ask.user.js /
// api/ask) injects as grounding context - SOPs, per-client rules, escalation contacts.
//   { v:1, md:"...markdown...", sections?:[{title,body}] }  (a bare string is also accepted).
// Edited here (broadway_employee gate); READ server-side by api/ask. Not financial.
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
// "wo-dataset": the canonical normalized WO dataset the Ops Agent produces each upload
// { schemaVersion, generatedAt, dateStr, dateKey, filename, client, aggregates, coords,
//   rows:[...normalized WO rows] }. Overwrite-in-place (today only). Additive: the
// Dashboard still reads "workbook" until its reader is cut over to this slot. Not financial.
// "wo-snapshot-history": rolling date-keyed trend store, one blob per client
// { v:1, days: { "YYYY-MM-DD": <daily snapshot incl. per-coordinator rollup> } }, pruned
// to the most recent ~60 days, written with If-Match merge. Not financial.

// Each onboarded client gets one string here. Onboarding Wendy's = add "wendys".
const VALID_CLIENTS = ["pilot"];

// ── Role gating ──────────────────────────────────────────────────────────
// Slots holding GP data require Operations Manager (L4) or above for ALL access
// (read, write, delete). Everything else stays at the broadway_employee gate the
// SWA route config already enforces. Server-side because the front-end / route
// checks are convenience only - this is the real boundary.
// NOTE: "revenue" is intentionally NOT in this list -- coordinators are meant to
// read the monthly revenue numbers (approved by Mike, 2026-06), so it stays at
// the broadway_employee gate. "revenue-gp" (GP lookup) is L4+ only and IS in
// VALID_SLOTS so this gate is reachable (previously it named a slot resolveTarget
// rejected with 400 first, making the boundary dead code).
// "om-bonus" holds Operations-Manager COMPENSATION inputs (bonus target, max payout,
// GP/headcount, MBO/SSS, company multiplier) - financial, so it is L4+ for ALL access
// like revenue-gp. Before 2026-07-23 it was missing from this list, so any
// broadway_employee (L1 coordinator) could read/write/delete comp data via a direct
// API call (the checkin page's client-side email check was bypassable). Security fix.
const FINANCIAL_SLOTS = ["revenue-gp", "om-bonus"];
const ROLE_LEVELS = ["ops_coordinator", "lead_ops_coordinator", "ops_supervisor", "ops_manager", "dir_ops", "vp_ops"];
const MIN_FINANCIAL_LEVEL = 4; // ops_manager

// Slots whose WRITE/DELETE require ops_supervisor (L3)+ (reads stay at the
// broadway_employee gate). "knowledge" is injected verbatim into every AI copilot's
// grounding context, so a low-rank author is a stored prompt-injection channel into
// higher-rank staff; "config" drives the shared dashboard for everyone. Before
// 2026-07-23 any broadway_employee could overwrite or delete both. Tunable via
// DATA_STORE_WRITE_MIN_LEVEL (set 1 to restore the old any-employee behavior).
const ELEVATED_WRITE_SLOTS = ["knowledge", "config"];
const MIN_ELEVATED_WRITE_LEVEL = (function () {
  const n = parseInt(process.env.DATA_STORE_WRITE_MIN_LEVEL, 10);
  return (n >= 1 && n <= ROLE_LEVELS.length) ? n : 3; // default ops_supervisor
})();

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
  })().catch((err) => { containerClientPromise = null; throw err; });   // never cache a rejection - a cold-start blip would brick the process
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
    // Take content, metadata, and etag from the SAME download response. A separate
    // getProperties() is a TOCTOU: a concurrent write landing between the two calls
    // pairs the bytes we just read with a NEWER etag, and the caller's next If-Match
    // write then passes against content it never saw and silently clobbers that write.
    // job-notes has two concurrent writers (dashboard POST here + userscript via
    // wo-ingest), so this is reachable. Mirrors wo-ingest / activity-log readLog.
    return { data, metadata: dl.metadata || {}, etag: dl.etag, exists: true };
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
        const lvl = roleLevelFromReq(req);   // financial slots stay L4+ even for existence/metadata
        await Promise.all(
          VALID_SLOTS.map(async (slot) => {
            if (FINANCIAL_SLOTS.includes(slot) && lvl < MIN_FINANCIAL_LEVEL) { out[slot] = { exists: false }; return; }
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

    // Financial slots: require Operations Manager (L4)+ for ALL access (read,
    // write, and delete). Fail closed.
    if (FINANCIAL_SLOTS.includes(slot) && roleLevelFromReq(req) < MIN_FINANCIAL_LEVEL) {
      context.res = { status: 403, headers: { "Content-Type": "application/json" }, body: { error: "Insufficient role for financial data" } };
      return;
    }

    // Elevated-write slots: destructive / injection-sensitive WRITES (POST/DELETE) need
    // ops_supervisor (L3)+; reads stay at the broadway_employee gate. Fail closed.
    if ((req.method === "POST" || req.method === "DELETE") &&
        ELEVATED_WRITE_SLOTS.includes(slot) && roleLevelFromReq(req) < MIN_ELEVATED_WRITE_LEVEL) {
      context.res = { status: 403, headers: { "Content-Type": "application/json" }, body: { error: "Insufficient role to modify '" + slot + "'" } };
      return;
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
    context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { error: "data-store error" } };
  }
};
