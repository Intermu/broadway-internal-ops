const { BlobServiceClient } = require("@azure/storage-blob");

// Shared vendor-prospect PIPELINE for the BWN discovery tools (Bid-Out net-new, Find Techs,
// Find Suppliers). Every paid discovery (Google Places search, website scrape, ZoomInfo
// enrichment) UPSERTS what it found here, and every tool READS here first - so a prospect
// found once is never paid for twice, and outcome history ("declined 6/12 - too far",
// "do-not-contact") follows the prospect into every future search near that area.
//
// Reached ANONYMOUSLY at the SWA route layer (Umbrava is a different origin). TWO authorized
// callers: (a) a userscript presenting the shared key (x-bwn-key vs WO_INGEST_KEY), or (b) an
// AAD-authenticated Broadway employee on a same-origin SWA page (the Projects Tracker Prospects
// view), recognized by the SWA-injected x-ms-client-principal. Fails CLOSED.
//
// API:
//   GET  ?all=1                                              (whole pipeline, newest first; the browser view)
//   GET  ?near=<lat>,<lng>&mi=<radius>[&kind=contractor|supplier][&q=<name substring>]
//   GET  ?city=<city>&state=<ST>[&kind=...][&q=...]          (free text match - no geocode cost)
//   POST { upsert: [ {name, website, phone, email, contactName, contactTitle, emailSrc,
//                     addr, city, state, lat, lng, rating, ratingCount, kind, trades[], source} ] }
//   POST { outcome: { key, status, wo, note, by } }           status from OUTCOME_STATUSES
//
// Storage: one JSON blob (vendor-prospects/db) - a few thousand small records; ETag-conditional
// writes with a re-read + re-apply retry (the mutation is re-applied to the FRESH state, so a
// 412 conflict never drops a concurrent writer's records).

const CONTAINER_NAME = "broadway-data";
const DB_BLOB = "vendor-prospects/db";
const MAX_UPSERT = 40;
const MAX_ITEMS = 3000;          // evict oldest lastSeen beyond this
const MAX_OUTCOMES = 20;         // per prospect, keep newest
const MAX_RESULTS = 200;
const ALL_CAP = 1000;            // scope=all (the Prospects browser) - full pipeline, newest first
const OUTCOME_STATUSES = ["contacted", "bid-sent", "declined", "no-response", "joined", "do-not-contact", "note"];

const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

// Same-origin SWA pages (the Projects Tracker) authenticate with AAD, not the shared key.
// Azure SWA STRIPS any client-supplied x-ms-client-principal and injects its own for a signed-in
// session, so trusting it here is safe (the cross-origin userscript has no session -> no header ->
// falls back to the key). Mirrors api/data-store.
function principalFromReq(req) {
  try {
    const h = req.headers && (req.headers["x-ms-client-principal"] || req.headers["X-MS-CLIENT-PRINCIPAL"]);
    if (!h) return null;
    return JSON.parse(Buffer.from(h, "base64").toString("utf-8"));
  } catch (e) { return null; }
}
function isEmployee(req) {
  const p = principalFromReq(req);
  return !!(p && Array.isArray(p.userRoles) && p.userRoles.indexOf("broadway_employee") !== -1);
}

// ---- key derivation: MUST mirror the Bid-Out userscript (ziKey) ----------------
function normName(s) {
  return String(s || "").toLowerCase().replace(/&/g, " and ")
    .replace(/\b(inc|llc|corp|co|company|ltd|the|and|of)\b/g, " ").replace(/[^a-z0-9]+/g, "");
}
function domainOf(url) {
  try { return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; }
}
function keyOf(c) { return domainOf(c.website) || normName(c.name) || String(c.name || "").toLowerCase().replace(/\s+/g, " ").trim(); }

const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[A-Za-z]{2,}$/;
function s(v, max) { return typeof v === "string" ? v.trim().slice(0, max || 300) : ""; }
function num(v) { const n = +v; return isFinite(n) ? n : null; }
function milesBetween(aLat, aLng, bLat, bLng) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// "123 Main St, Tallapoosa, GA 30176, USA" -> {city, state}
function cityStateFromAddr(addr) {
  const m = String(addr || "").match(/,\s*([^,]+?),\s*([A-Z]{2})\b[^,]*(?:,\s*(?:USA|United States))?\s*$/);
  return m ? { city: m[1].trim(), state: m[2] } : { city: "", state: "" };
}

// ---- blob ----------------------------------------------------------------------
let _containerP = null;
async function dbBlobClient() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
  if (!_containerP) {
    const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER_NAME);
    _containerP = container.createIfNotExists().then(() => container).catch((e) => { _containerP = null; throw e; });
  }
  const c = await _containerP;
  return c.getBlockBlobClient(DB_BLOB);
}
function streamToString(readable) {
  return new Promise((resolve, reject) => {
    let out = ""; readable.on("data", (d) => { out += d; }); readable.on("end", () => resolve(out)); readable.on("error", reject);
  });
}
async function readDb(blob) {
  try {
    const dl = await blob.download();
    const data = JSON.parse(await streamToString(dl.readableStreamBody));
    return { items: (data && typeof data.items === "object" && data.items) || {}, etag: dl.etag, exists: true };
  } catch (err) {
    if (err.statusCode === 404) return { items: {}, etag: null, exists: false };
    throw err;
  }
}
async function writeDb(blob, db) {
  const keys = Object.keys(db.items);
  if (keys.length > MAX_ITEMS) {
    // Eviction is by oldest lastSeen, but do-not-contact history is EXEMPT - dropping it would
    // let an aged DNC vendor be re-discovered clean and bid again.
    const isDnc = (k) => { const o = db.items[k].outcomes; return !!(o && o.length && o[o.length - 1].status === "do-not-contact"); };
    const dncKeys = keys.filter(isDnc);
    const rest = keys.filter((k) => !isDnc(k));
    rest.sort((a, b) => (db.items[b].lastSeen || 0) - (db.items[a].lastSeen || 0));
    const trimmed = {};
    dncKeys.forEach((k) => { trimmed[k] = db.items[k]; });
    rest.slice(0, Math.max(0, MAX_ITEMS - dncKeys.length)).forEach((k) => { trimmed[k] = db.items[k]; });
    db.items = trimmed;
  }
  const body = JSON.stringify({ v: 1, items: db.items });
  const conditions = db.exists ? { ifMatch: db.etag } : { ifNoneMatch: "*" };
  await blob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, conditions });
}
// Read -> mutate(freshState) -> conditional write; on 412 re-read and RE-APPLY the mutation to
// the fresh state (never merges stale copies, never drops a concurrent writer's records).
async function mutateDb(blob, mutate) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const db = await readDb(blob);
    mutate(db);
    try { await writeDb(blob, db); return db; }
    catch (err) {
      if (err.statusCode !== 412 && err.statusCode !== 409) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("db-write-conflict");
}

function sanitizeProspect(p) {
  const rec = {
    name: s(p.name, 200),
    website: s(p.website, 300),
    phone: s(p.phone, 40),
    email: s(p.email, 200),
    contactName: s(p.contactName, 120),
    contactTitle: s(p.contactTitle, 120),
    emailSrc: s(p.emailSrc, 20),
    addr: s(p.addr, 300),
    city: s(p.city, 80),
    state: s(p.state, 12),
    lat: num(p.lat),
    lng: num(p.lng),
    rating: num(p.rating),
    ratingCount: num(p.ratingCount),
    kind: p.kind === "supplier" ? "supplier" : "contractor",
    trades: Array.isArray(p.trades) ? p.trades.map((t) => s(t, 60)).filter(Boolean).slice(0, 8) : [],
    source: s(p.source, 24),
  };
  if (rec.email && !EMAIL_RE.test(rec.email)) rec.email = "";
  // http(s) only: a stored javascript: URL would become a clickable link in the userscripts
  // (stored-XSS via a leaked key). Key derivation is unaffected - non-http URLs already yield
  // an empty hostname on both sides, falling back to the name.
  if (rec.website && !/^https?:\/\//i.test(rec.website)) rec.website = "";
  if (!rec.city && rec.addr) { const cs = cityStateFromAddr(rec.addr); rec.city = cs.city; rec.state = rec.state || cs.state; }
  return rec;
}
const EMAIL_SRC_RANK = { zoominfo: 2, manual: 2, scrape: 1, "": 0 };
function mergeProspect(existing, inc, now) {
  const e = existing || { firstSeen: now, seenCount: 0, trades: [], sources: [], outcomes: [] };
  ["name", "website", "phone", "addr", "city", "state"].forEach((f) => {
    if (inc[f]) e[f] = inc[f];                         // non-empty incoming wins; never blank a field
  });
  // kind is FIRST-writer-wins: a supplier saved by Find Suppliers must not flip to contractor
  // just because a later contractor-mode search re-found the same company (and vice versa).
  if (inc.kind && !e.kind) e.kind = inc.kind;
  // Email upgrades only: a scraped generic address must not clobber a ZoomInfo/manual direct
  // contact. When the email IS replaced, the contact name/title move with it (even to empty)
  // so the name/email pairing stays coherent.
  const incRank = EMAIL_SRC_RANK[inc.emailSrc || ""] || 0, curRank = EMAIL_SRC_RANK[e.emailSrc || ""] || 0;
  if (inc.email && (!e.email || incRank >= curRank)) {
    if (inc.email !== e.email) { e.contactName = inc.contactName || ""; e.contactTitle = inc.contactTitle || ""; }
    else { if (inc.contactName) e.contactName = inc.contactName; if (inc.contactTitle) e.contactTitle = inc.contactTitle; }
    e.email = inc.email; e.emailSrc = inc.emailSrc || "";
  } else if (!inc.email) {
    if (inc.contactName && !e.contactName) e.contactName = inc.contactName;
    if (inc.contactTitle && !e.contactTitle) e.contactTitle = inc.contactTitle;
  }
  ["lat", "lng", "rating", "ratingCount"].forEach((f) => { if (inc[f] != null) e[f] = inc[f]; });
  (inc.trades || []).forEach((t) => { if (e.trades.indexOf(t) === -1 && e.trades.length < 12) e.trades.push(t); });
  if (inc.source && e.sources.indexOf(inc.source) === -1 && e.sources.length < 8) e.sources.push(inc.source);
  e.seenCount = (e.seenCount || 0) + 1;
  e.lastSeen = now;
  return e;
}
function lastOutcome(rec) {
  const o = rec.outcomes && rec.outcomes.length ? rec.outcomes[rec.outcomes.length - 1] : null;
  return o ? { status: o.status, ts: o.ts, wo: o.wo || "", note: o.note || "", by: o.by || "" } : null;
}
function publicView(key, rec, dist) {
  return {
    key, name: rec.name || "", website: rec.website || "", phone: rec.phone || "",
    email: rec.email || "", contactName: rec.contactName || "", contactTitle: rec.contactTitle || "", emailSrc: rec.emailSrc || "",
    addr: rec.addr || "", city: rec.city || "", state: rec.state || "", lat: rec.lat, lng: rec.lng,
    rating: rec.rating, ratingCount: rec.ratingCount, kind: rec.kind || "contractor", trades: rec.trades || [],
    sources: rec.sources || [], firstSeen: rec.firstSeen, lastSeen: rec.lastSeen, seenCount: rec.seenCount || 0,
    lastOutcome: lastOutcome(rec), outcomes: (rec.outcomes || []).slice(-5),
    miles: dist != null ? Math.round(dist * 10) / 10 : undefined,
  };
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    // Two authorized callers: (a) an AAD-authenticated Broadway employee on a same-origin SWA
    // page (the Projects Tracker Prospects view), or (b) a userscript presenting the shared key.
    const employee = isEmployee(req);
    const expected = process.env.WO_INGEST_KEY;
    const keyHdr = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    const keyOk = !!(expected && keyHdr && keyHdr === expected);
    if (!employee && !keyOk) {
      if (!expected) { context.res = json(503, { error: "prospects not configured" }); return; }
      context.res = json(403, { error: "unauthorized" }); return;
    }

    const blob = await dbBlobClient();

    if (req.method === "GET") {
      const q = req.query || {};
      const db = await readDb(blob);
      const kind = q.kind === "supplier" ? "supplier" : (q.kind === "contractor" ? "contractor" : null);
      const nameQ = s(q.q, 80).toLowerCase();
      let out = [];
      let cap = MAX_RESULTS;
      if (q.all === "1" || q.scope === "all") {
        // Whole pipeline for the browser view (employee-facing). Newest activity first.
        Object.keys(db.items).forEach((k) => { out.push(publicView(k, db.items[k])); });
        out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        cap = ALL_CAP;
      } else if (q.near) {
        const m = String(q.near).match(/^(-?[\d.]+),(-?[\d.]+)$/);
        if (!m) { context.res = json(400, { error: "near must be lat,lng" }); return; }
        const lat = +m[1], lng = +m[2];
        const mi = Math.min(200, Math.max(1, num(q.mi) || 50));
        Object.keys(db.items).forEach((k) => {
          const r = db.items[k];
          if (r.lat == null || r.lng == null) return;
          const d = milesBetween(lat, lng, r.lat, r.lng);
          if (d <= mi) out.push(publicView(k, r, d));
        });
        out.sort((a, b) => a.miles - b.miles);
      } else if (q.city || q.state) {
        const city = s(q.city, 80).toLowerCase(), state = s(q.state, 12).toLowerCase();
        Object.keys(db.items).forEach((k) => {
          const r = db.items[k];
          if (city && String(r.city || "").toLowerCase() !== city) return;
          if (state && String(r.state || "").toLowerCase() !== state) return;
          out.push(publicView(k, r));
        });
        out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      } else { context.res = json(400, { error: "near=lat,lng or city/state required" }); return; }
      if (kind) out = out.filter((r) => r.kind === kind);
      if (nameQ) out = out.filter((r) => (r.name || "").toLowerCase().indexOf(nameQ) !== -1);
      context.res = json(200, { ok: true, total: out.length, prospects: out.slice(0, cap) });
      return;
    }

    // POST
    const body = req.body || {};
    const now = Date.now();

    if (Array.isArray(body.upsert)) {
      // Only the key-holding discovery tools write vendor records. Employees browse + record
      // outcomes; they must not be able to inject/overwrite pipeline records from the console.
      if (!keyOk) { context.res = json(403, { error: "upsert requires the discovery key" }); return; }
      const incoming = body.upsert.map(sanitizeProspect).filter((p) => p.name).slice(0, MAX_UPSERT);
      if (!incoming.length) { context.res = json(400, { error: "upsert[] with a name each is required" }); return; }
      let stored = 0;
      await mutateDb(blob, (db) => {
        stored = 0;
        incoming.forEach((p) => { const k = keyOf(p); db.items[k] = mergeProspect(db.items[k], p, now); stored++; });
      });
      context.res = json(200, { ok: true, stored });
      return;
    }

    const outcomeList = Array.isArray(body.outcomes) ? body.outcomes
      : (body.outcome && typeof body.outcome === "object" ? [body.outcome] : null);
    if (outcomeList) {
      const who = employee ? ((principalFromReq(req) || {}).userDetails || "") : "";
      const entries = outcomeList.map((o) => ({
        key: s(o && o.key, 220),
        status: OUTCOME_STATUSES.indexOf(o && o.status) !== -1 ? o.status : null,
        // Employee attribution is NON-spoofable: force the signed-in identity, ignore any client
        // 'by'. The userscript (key) path has no principal, so it supplies its own 'by'.
        wo: s(o && o.wo, 40), note: s(o && o.note, 500), by: employee ? s(who, 120) : (s(o && o.by, 120) || s(who, 120)),
      })).filter((e) => e.key && e.status).slice(0, 60);
      if (!entries.length) { context.res = json(400, { error: "outcome.key and a valid outcome.status are required" }); return; }
      let applied = 0, unknown = [];
      await mutateDb(blob, (db) => {
        applied = 0; unknown = [];
        entries.forEach((e) => {
          const rec = db.items[e.key];
          if (!rec) { unknown.push(e.key); return; }
          rec.outcomes = (rec.outcomes || []).concat([{ ts: now, status: e.status, wo: e.wo, note: e.note, by: e.by }]).slice(-MAX_OUTCOMES);
          rec.lastSeen = now;   // an outcome is activity: keep the record from aging out
          applied++;
        });
      });
      if (!applied) { context.res = json(404, { error: "unknown prospect key(s)", unknown }); return; }
      context.res = json(200, { ok: true, applied, unknown });
      return;
    }

    context.res = json(400, { error: "upsert[] or outcome{} required" });
  } catch (err) {
    context.log && context.log.error && context.log.error("vendor-prospects error:", String((err && err.message) || err));
    context.res = json(500, { error: "prospects failed" });
  }
};
