const { BlobServiceClient } = require("@azure/storage-blob");

// WO-action ingest for the BWN userscript connector (Phase 2).
//
// The BWN AI userscript runs inside app.umbrava.com - a DIFFERENT origin that is NOT
// federated to Broadway's Entra tenant, so it cannot present the AAD principal the rest
// of /api/* relies on. This endpoint is therefore reachable ANONYMOUSLY at the SWA route
// layer (see staticwebapp.config.json) and gates itself with a shared FUNCTION KEY
// (app setting WO_INGEST_KEY, sent as the `x-bwn-key` header). It appends WO-action events
// to the SAME per-client activity-log blob the dashboard uses, so they show in the Activity
// Log view + rollup - but tagged `source:"userscript"` and carrying the Umbrava-logged-in
// actor (self-declared, NOT cryptographically verified). The dashboard's AAD-stamped
// entries remain the authoritative record; this feed is coordinator-convenience history.
//
//   POST /api/wo-ingest?client=pilot   header x-bwn-key: <WO_INGEST_KEY>
//        body { actor?, events:[{action, target?, detail?}] }  (or a single {action,...})
//        → { ok:true, added:N }
//
// Fails CLOSED: 503 if WO_INGEST_KEY is not configured, 403 on a missing/wrong key
// (NOT 401 - staticwebapp.config.json's responseOverrides rewrite 401s into a login
// redirect, which a client chasing redirects would misread as a 200 success).

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
// needed - but they scope any normal-fetch caller to the Umbrava origin.
const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// Own-property map lookup with a digits-equality fallback (dashboard Job IDs can be
// "WIFI 44832920" while userscript targets are digits-only tracking #s).
function mapLookup(map, key) {
  if (!map || typeof map !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  if (/^\d+$/.test(key)) {
    for (const k of Object.keys(map)) { if (k.replace(/\D+/g, "") === key) return map[k]; }
  }
  return null;
}

// The latest "OVER 30" audit line inside a dashboard WO Audit case file (job-notes
// record). Updates are PREPENDED ("## YYYY-MM-DD - Update" blocks), so the FIRST
// matching line in the text is the newest. Its date = the nearest update heading
// above it (falls back to the record's updatedAt - save time, coarser).
function latestAuditLine(rec) {
  if (!rec || !rec.note) return null;
  const note = String(rec.note);
  const m = note.match(/^[ \t>*-]*((?:\d+[.)]\s*)?OVER\s*30\b[^\n]*)/im);
  if (!m) return null;
  let ts = rec.updatedAt || null;
  const heads = note.slice(0, m.index).match(/##\s*\d{4}-\d{2}-\d{2}\s*-\s*Update/g);
  if (heads && heads.length) {
    const d = heads[heads.length - 1].match(/(\d{4}-\d{2}-\d{2})/);
    if (d) ts = d[1] + "T12:00:00.000Z";   // date-only stamp - noon keeps day-level compares sane
  }
  return { line: m[1].replace(/^\d+[.)]\s*/, "").trim().slice(0, 300), ts, by: rec.updatedBy || null, src: "audit" };
}

// Generic JSON blob read (null when absent) - used by the GET lookup.
async function readJson(container, name) {
  try {
    const dl = await container.getBlockBlobClient(name).download();
    return JSON.parse(await streamToString(dl.readableStreamBody));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function readLog(blob) {
  try {
    const dl = await blob.download();
    const text = await streamToString(dl.readableStreamBody);
    const log = JSON.parse(text);
    // Use the etag from the SAME download response (atomic with the content). A separate
    // getProperties() call opens a TOCTOU: a concurrent write between the two calls pairs
    // stale content with a newer etag, and the conditional upload then silently drops it.
    return { entries: Array.isArray(log.entries) ? log.entries : [], etag: dl.etag, exists: true };
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
    // 403, NOT 401: staticwebapp.config.json's responseOverrides turns 401s into a 302
    // redirect to the AAD login page - a client following it would see 200 HTML and could
    // misread the result. 403 passes through untouched.
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!key || key !== expected) { context.res = json(403, { error: "unauthorized" }); return; }

    const params = req.query || {};
    const body = req.body || {};
    const client = params.client || body.client;
    if (!client || !VALID_CLIENTS.includes(client)) { context.res = json(400, { error: "missing or unknown 'client'" }); return; }

    // ── GET: dashboard record lookup for one job (userscript ← SWA direction) ──
    // Returns the dashboard case file (note text + naHistory + updatedAt) and the
    // exception-queue ack/snooze state for a tracking #, so the Umbrava checklist can
    // merge the dashboard's Next Actions Required. Same key gate as the ingest - the
    // key holder is already trusted to write coordinator activity; job-notes carries no
    // financial data (it sits at the broadway_employee gate on the dashboard side).
    if (req.method === "GET") {
      const container = await getContainerClient();
      // ── Bulk Over-30 line lookup: ?o30=<comma-separated tracking #s> ──────────
      // Returns each requested job's LATEST synced "OVER 30 -" line + when/who, so
      // the batch panel can show supervisors the last audit line per job.
      if (params.o30) {
        const targets = String(params.o30).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
        context.log("wo-ingest GET o30 lines", client, targets.length);
        // TWO sources per job, newest wins: (a) the WO AUDIT case file the coordinator
        // maintains on the dashboard (job-notes - the authoritative audit record the
        // user described), and (b) the panel-synced o30-lines store. The panel shows
        // src so a coordinator knows whether it came from the dashboard audit or a sync.
        const [ol, jn] = await Promise.all([
          readJson(container, `clients/${client}/o30-lines`),
          readJson(container, `clients/${client}/job-notes`),
        ]);
        const outLines = {};
        targets.forEach((t) => {
          const sy = ol && ol.items ? mapLookup(ol.items, t) : null;
          const au = latestAuditLine(jn && jn.notes ? mapLookup(jn.notes, t) : null);
          const tSy = sy ? (Date.parse(sy.ts || "") || 0) : -1;
          const tAu = au ? (Date.parse(au.ts || "") || 0) : -1;
          if (tAu > tSy && au) outLines[t] = au;
          else if (sy) outLines[t] = { line: sy.line || "", ts: sy.ts || null, by: sy.by || null, src: "sync" };
          else if (au) outLines[t] = au;
        });
        context.res = json(200, { ok: true, lines: outLines });
        return;
      }
      const target = params.target ? String(params.target).slice(0, 64) : "";
      if (!target) { context.res = json(400, { error: "missing 'target'" }); return; }
      context.log("wo-ingest GET lookup", client, target);   // reads leave a telemetry trail (POSTs land in the activity log; GETs otherwise wouldn't)
      const out = { ok: true, job: null, eq: null, plan: null };
      // Own-property lookups only (a JSON map still surfaces __proto__/constructor), with
      // a digits-equality fallback: the userscript sends the digits-only tracking #, but
      // dashboard Job IDs can carry prefixes ("WIFI 44832920") - one linear pass, small maps.
      const lookup = (map, key) => {
        if (!map || typeof map !== "object") return null;
        if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
        if (/^\d+$/.test(key)) {
          for (const k of Object.keys(map)) { if (k.replace(/\D+/g, "") === key) return map[k]; }
        }
        return null;
      };
      const jn = await readJson(container, `clients/${client}/job-notes`);
      const rec = lookup(jn && jn.notes, target);
      if (rec) {
        out.job = {
          note: String(rec.note || "").slice(0, 20000),
          // AI bottleneck summary + the working/done action pill live in the SAME job-notes
          // record - surfaced (additive, 2026-07-14) so a ported job modal (the Umbrava-side
          // job view) can render the dashboard's Bottleneck line + action pill, not just the
          // raw case file. Same key gate, no new slot, no financial data.
          summary: rec.summary ? String(rec.summary).slice(0, 4000) : null,
          summaryAt: rec.summaryAt || null,
          action: rec.action || "none",
          naHistory: Array.isArray(rec.naHistory) ? rec.naHistory.slice(0, 5) : [],
          updatedAt: rec.updatedAt || null,
          updatedBy: rec.updatedBy || null,
        };
      }
      // exception-queue ack/snooze state + the job-side pushed Next-Actions plan (job-plans)
      // in parallel. The client mirrors the dashboard rule: the plan is a FALLBACK, rendered
      // only when the case file itself carries no authored Next Actions.
      const [eq, jp] = await Promise.all([
        readJson(container, `clients/${client}/exception-queue`),
        readJson(container, `clients/${client}/job-plans`),
      ]);
      const st = lookup(eq && eq.items, target);
      if (st) out.eq = { state: st.state || null, until: st.until || null, by: st.by || null };
      const pl = lookup(jp && jp.plans, target);
      if (pl && Array.isArray(pl.items) && pl.items.length) {
        out.plan = { items: pl.items.slice(0, 25), src: pl.src || "note", ts: pl.ts || null, by: pl.by || null };
      }
      context.res = json(200, out);
      return;
    }

    const actor = body.actor ? String(body.actor).slice(0, 128) : "unknown";

    // ── Over-30 sync: audit lines + board trend → clients/<client>/o30-lines ────
    // POST { actor, o30lines:[{target,line}] } upserts each job's LATEST line (the
    // prior one shifts into prev[], max 4) - the panel's "last Over-30 note + date".
    // POST { actor, snapshot:{date,over30,open,bad,warn} } records the day's clean
    // full-board scan into trend{} (90-day cap) for team-wide trending.
    if (req.method === "POST" && (Array.isArray(body.o30lines) || body.snapshot)) {
      const stampO = new Date().toISOString();
      // Targets must be digits-only tracking #s (what the client sends). This is also
      // the prototype-pollution guard: bracket-assigning "__proto__" on a JSON-parsed
      // object would set its PROTOTYPE, not an own key.
      const linesIn = (Array.isArray(body.o30lines) ? body.o30lines : []).slice(0, 200)
        .map((l) => ({ target: String((l && l.target) || "").slice(0, 64), line: String((l && l.line) || "").slice(0, 300) }))
        .filter((l) => /^\d+$/.test(l.target) && /^OVER\s*30/i.test(l.line));
      const snapIn = body.snapshot && body.snapshot.date && /^\d{4}-\d{2}-\d{2}$/.test(String(body.snapshot.date)) ? {
        date: String(body.snapshot.date).slice(0, 10),
        over30: +body.snapshot.over30 || 0, open: +body.snapshot.open || 0,
        bad: +body.snapshot.bad || 0, warn: +body.snapshot.warn || 0,
      } : null;
      if (!linesIn.length && !snapIn) { context.res = json(400, { error: "no valid o30 payload" }); return; }
      const container = await getContainerClient();
      const blobO = container.getBlockBlobClient(`clients/${client}/o30-lines`);
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let cur = null, etag = null, exists = false;
        try {
          const dl = await blobO.download();
          cur = JSON.parse(await streamToString(dl.readableStreamBody));
          // etag MUST come from the same download response - a separate getProperties()
          // opens a TOCTOU where another writer lands between the two calls and this
          // upload's ifMatch passes against the NEWER etag while merging STALE content,
          // silently erasing their write (review MAJOR; same rule as readLog above).
          etag = dl.etag; exists = true;
        } catch (err) { if (err.statusCode !== 404) throw err; }
        const data = cur && typeof cur === "object" ? cur : {};
        data.v = 1; data.items = data.items && typeof data.items === "object" ? data.items : {}; data.trend = data.trend && typeof data.trend === "object" ? data.trend : {};
        linesIn.forEach((l) => {
          const prevRec = Object.prototype.hasOwnProperty.call(data.items, l.target) ? data.items[l.target] : null;
          const hist = prevRec ? [{ line: prevRec.line, ts: prevRec.ts, by: prevRec.by }].concat(prevRec.prev || []).slice(0, 4) : [];
          data.items[l.target] = { line: l.line, ts: stampO, by: actor, prev: hist };
        });
        if (snapIn) {
          data.trend[snapIn.date] = { over30: snapIn.over30, open: snapIn.open, bad: snapIn.bad, warn: snapIn.warn, by: actor, ts: stampO };
          const tk = Object.keys(data.trend).sort();
          while (tk.length > 90) delete data.trend[tk.shift()];
        }
        const ik = Object.keys(data.items);
        if (ik.length > 500) { ik.sort((a, b) => String(data.items[a].ts || "").localeCompare(String(data.items[b].ts || ""))); while (ik.length > 500) delete data.items[ik.shift()]; }
        const outBody = JSON.stringify(data);
        const conditions = exists ? { ifMatch: etag } : { ifNoneMatch: "*" };
        try {
          await blobO.upload(outBody, Buffer.byteLength(outBody), { blobHTTPHeaders: { blobContentType: "application/json" }, conditions });
          context.res = json(200, { ok: true, lines: linesIn.length, snapshot: !!snapIn });
          return;
        } catch (err) {
          if (err.statusCode === 412 || err.statusCode === 409) continue;
          throw err;
        }
      }
      context.res = json(503, { error: "o30-lines write contended; please retry" });
      return;
    }

    // ── Job Next-Actions round-trip: job → dashboard  →  clients/<client>/job-plans ──
    // POST { actor, plans:[{target, items:[...], src}] } upserts each job's authored
    // "Next Actions Required" plan (the one the Umbrava checklist is running off) so the
    // dashboard can mirror it. Owned exclusively by this endpoint (like o30-lines) - the
    // dashboard READS it (AAD gate, read-only via data-store) but never writes it, so it
    // never contends with the coordinator's job-notes case file. This is a SEPARATE store
    // from job-notes on purpose: the case file is the coordinator's authoritative audit
    // record and must not be clobbered by a job-side push.
    if (req.method === "POST" && Array.isArray(body.plans)) {
      const stampP = new Date().toISOString();
      // target must be a digits-only tracking # (also the prototype-pollution guard:
      // bracket-assigning "__proto__" sets the prototype, not an own key). Cap items and
      // each item's length so a runaway note can't bloat the blob.
      const plansIn = body.plans.slice(0, 20)
        .map((p) => ({
          target: String((p && p.target) || "").slice(0, 64),
          items: (Array.isArray(p && p.items) ? p.items : []).slice(0, 25).map((x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean),
          src: String((p && p.src) || "note").slice(0, 16),
        }))
        .filter((p) => /^\d+$/.test(p.target) && p.items.length);
      if (!plansIn.length) { context.res = json(400, { error: "no valid plans" }); return; }
      const container = await getContainerClient();
      const blobP = container.getBlockBlobClient(`clients/${client}/job-plans`);
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let cur = null, etag = null, exists = false;
        try {
          const dl = await blobP.download();
          cur = JSON.parse(await streamToString(dl.readableStreamBody));
          etag = dl.etag; exists = true;   // etag from the SAME download - no TOCTOU (see readLog)
        } catch (err) { if (err.statusCode !== 404) throw err; }
        const data = cur && typeof cur === "object" ? cur : {};
        data.v = 1; data.plans = data.plans && typeof data.plans === "object" ? data.plans : {};
        plansIn.forEach((p) => { data.plans[p.target] = { items: p.items, src: p.src, ts: stampP, by: actor }; });
        const pk = Object.keys(data.plans);
        if (pk.length > 500) { pk.sort((a, b) => String(data.plans[a].ts || "").localeCompare(String(data.plans[b].ts || ""))); while (pk.length > 500) delete data.plans[pk.shift()]; }
        const outBody = JSON.stringify(data);
        const conditions = exists ? { ifMatch: etag } : { ifNoneMatch: "*" };
        try {
          await blobP.upload(outBody, Buffer.byteLength(outBody), { blobHTTPHeaders: { blobContentType: "application/json" }, conditions });
          context.res = json(200, { ok: true, plans: plansIn.length });
          return;
        } catch (err) {
          if (err.statusCode === 412 || err.statusCode === 409) continue;
          throw err;
        }
      }
      context.res = json(503, { error: "job-plans write contended; please retry" });
      return;
    }

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
        id: ev.id ? String(ev.id).slice(0, 64) : null,   // client-supplied idempotency id (dedup below)
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
      // Idempotency: drop any event whose id is already in the log - a client teardown
      // between our server write and its client-side clear re-sends the batch, and that
      // must not duplicate. Re-checked each retry against the freshly-read blob.
      const seen = Object.create(null);
      existing.forEach((e) => { if (e && e.id) seen[e.id] = 1; });
      const toAdd = entries.filter((e) => !(e.id && seen[e.id]));
      if (!toAdd.length) { context.res = json(200, { ok: true, added: 0, deduped: entries.length }); return; }
      let next = existing.concat(toAdd);
      if (next.length > MAX_ENTRIES) next = next.slice(-MAX_ENTRIES);
      const out = JSON.stringify({ v: 1, entries: next });
      const conditions = exists ? { ifMatch: etag } : { ifNoneMatch: "*" };
      try {
        await blob.upload(out, Buffer.byteLength(out), {
          blobHTTPHeaders: { blobContentType: "application/json" },
          conditions,
        });
        context.res = json(200, { ok: true, added: toAdd.length });
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
