const https = require("https");
const { BlobServiceClient } = require("@azure/storage-blob");

// ZoomInfo contact enrichment for the BWN Bid-Out userscript. Given companies discovered
// via Google Places (name/website/city/state), look up named contacts (owner / ops / office)
// with verified emails through Broadway's ZoomInfo subscription, so net-new vendors whose
// websites publish no email can still be reached by the email RFP.
//
// Reached ANONYMOUSLY at the SWA route layer (Umbrava is a different origin, not federated
// to Broadway AAD) and gated by the SAME shared function key as wo-ingest (x-bwn-key vs
// app setting WO_INGEST_KEY). Fails CLOSED: 503 if the key is unset, 403 on a bad key.
//
// DEPLOY-DARK: a second gate returns 503 "awaiting ZoomInfo credentials" until the ZoomInfo
// app settings exist (ZI_USERNAME + ZI_PASSWORD - an API user on Broadway's existing
// ZoomInfo contract; legacy Enterprise API, base https://api.zoominfo.com).
//
// CREDIT PROTECTION (ZoomInfo bills a credit per enriched record, from the pool SHARED with
// the sales team): (1) results cached 30 days in a blob so repeat bid-outs in the same area
// never re-burn a credit; (2) per-call caps (<=8 companies, <=2 contacts each); (3) a daily
// record ceiling (ZI_DAILY_CAP, default 40) tracked in the same blob. The daily counter is
// read-check-write (a concurrent pair of calls could slightly overshoot the ceiling); the
// hard bound per call is the company x contact cap. Fixed egress host - no SSRF surface.

const ZI_HOST = "api.zoominfo.com";
const MAX_COMPANIES = 8;
const CONTACTS_PER_COMPANY = 2;
const DEFAULT_DAILY_CAP = 40;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const CACHE_MAX_ITEMS = 500;
const ZI_TIMEOUT_MS = 15000;
const CONTAINER_NAME = "broadway-data";
const CACHE_BLOB = "clients/pilot/zi-enrich-cache";

const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

// ---- ZoomInfo HTTP (fixed host, JSON in/out) --------------------------------
function ziPost(path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = https.request({
      host: ZI_HOST, path, method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, headers || {}),
      timeout: ZI_TIMEOUT_MS,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; if (buf.length > 2000000) { req.destroy(); reject(new Error("zi-response-too-large")); } });
      res.on("end", () => {
        let j = null; try { j = JSON.parse(buf); } catch (e) { /* leave null */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("zi-timeout")); });
    req.on("error", reject);
    req.end(payload);
  });
}

// Module-cached JWT (ZoomInfo tokens last ~60 min; refresh at 50).
let tokenCache = { jwt: null, exp: 0 };
async function ziToken() {
  if (tokenCache.jwt && Date.now() < tokenCache.exp) return tokenCache.jwt;
  const r = await ziPost("/authenticate", {}, {
    username: process.env.ZI_USERNAME,
    password: process.env.ZI_PASSWORD,
  });
  const jwt = r.json && (r.json.jwt || r.json.token);
  if (r.status !== 200 || !jwt) throw new Error("zi-auth-failed:" + r.status);
  tokenCache = { jwt, exp: Date.now() + 50 * 60 * 1000 };
  return jwt;
}

// ---- Defensive response mining ----------------------------------------------
// ZoomInfo response envelopes vary by endpoint/version; rather than bind to one exact
// shape, walk the JSON and collect anything that looks like a person record with an email.
// Strict charset (mirrors send-bid): a hostile "email" carrying , ; < > quotes could smuggle
// extra recipients into a mailto BCC or silently fail the Graph send - never let one into the
// cache or a response.
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[A-Za-z]{2,}$/;
function mineContacts(node, out, depth) {
  if (!node || typeof node !== "object" || depth > 8 || out.length >= 10) return;
  if (Array.isArray(node)) { for (const it of node) mineContacts(it, out, depth + 1); return; }
  const email = [node.email, node.emailAddress, node.workEmail].find((v) => typeof v === "string" && EMAIL_RE.test(v.trim()));
  if (email) {
    const first = typeof node.firstName === "string" ? node.firstName : "";
    const last = typeof node.lastName === "string" ? node.lastName : "";
    const name = (first || last) ? (first + " " + last).trim() : (typeof node.name === "string" ? node.name : "");
    const title = typeof node.jobTitle === "string" ? node.jobTitle : (typeof node.title === "string" ? node.title : "");
    const phone = [node.directPhone, node.phone, node.mobilePhone].find((v) => typeof v === "string" && v.trim()) || "";
    if (!out.some((c) => c.email.toLowerCase() === email.trim().toLowerCase())) {
      out.push({ name, title, email: email.trim(), phone: phone.trim() });
    }
  }
  for (const k of Object.keys(node)) mineContacts(node[k], out, depth + 1);
}
function minePersonIds(node, out, depth) {
  if (!node || typeof node !== "object" || depth > 8 || out.length >= 25) return;
  if (Array.isArray(node)) { for (const it of node) minePersonIds(it, out, depth + 1); return; }
  const id = node.personId != null ? node.personId : node.id;
  if ((typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) && (node.firstName || node.lastName || node.jobTitle)) {
    if (!out.some((p) => String(p.id) === String(id))) out.push({ id, hasEmail: node.hasEmail !== false });
  }
  for (const k of Object.keys(node)) minePersonIds(node[k], out, depth + 1);
}

// Search contacts at a company, then enrich the top few into full records (this is the
// credit-burning step - each returned record charges the shared pool).
async function ziLookup(company, jwt, maxContacts) {
  const auth = { Authorization: "Bearer " + jwt };
  const search = await ziPost("/search/contact", auth, {
    companyName: company.name,
    rpp: Math.max(maxContacts * 2, 4),   // search is free-ish; over-fetch so we can prefer has-email records
  });
  if (search.status === 401) throw new Error("zi-unauthorized");
  if (search.status !== 200 || !search.json) return { contacts: [], billed: 0 };
  const people = [];
  minePersonIds(search.json, people, 0);
  // Only submit has-email people to /enrich: ZoomInfo bills a credit per RETURNED record,
  // and a record known to lack an email is pure credit waste for this feature.
  const pick = people.filter((p) => p.hasEmail).slice(0, maxContacts);
  if (!pick.length) return { contacts: [], billed: 0 };
  const enrich = await ziPost("/enrich/contact", auth, {
    matchPersonInput: pick.map((p) => ({ personId: p.id })),
    outputFields: ["firstName", "lastName", "jobTitle", "email", "phone", "directPhone", "companyName"],
  });
  if (enrich.status === 401) throw new Error("zi-unauthorized");
  const contacts = [];
  if (enrich.status === 200 && enrich.json) mineContacts(enrich.json, contacts, 0);
  // billed = what we SUBMITTED (conservatively high): credits are charged per record ZoomInfo
  // returns, whether or not it carried a usable email - never count fewer than could be billed.
  return { contacts: contacts.slice(0, maxContacts), billed: pick.length };
}

// ---- Cache blob ---------------------------------------------------------------
function cacheBlobClient() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
  return BlobServiceClient.fromConnectionString(conn)
    .getContainerClient(CONTAINER_NAME)
    .getBlockBlobClient(CACHE_BLOB);
}
function streamToString(readable) {
  return new Promise((resolve, reject) => {
    let out = "";
    readable.on("data", (d) => { out += d; });
    readable.on("end", () => resolve(out));
    readable.on("error", reject);
  });
}
async function readCache(blob) {
  try {
    const dl = await blob.download();
    const data = JSON.parse(await streamToString(dl.readableStreamBody));
    return {
      items: (data && typeof data.items === "object" && data.items) || {},
      spend: (data && typeof data.spend === "object" && data.spend) || {},
      etag: dl.etag, exists: true,
    };
  } catch (err) {
    if (err.statusCode === 404) return { items: {}, spend: {}, etag: null, exists: false };
    throw err;
  }
}
async function writeCache(blob, cache) {
  // Evict expired + oldest-over-cap items, trim spend to 14 days, then conditional upload.
  const now = Date.now();
  const keys = Object.keys(cache.items).filter((k) => now - (cache.items[k].ts || 0) < CACHE_TTL_MS);
  keys.sort((a, b) => (cache.items[b].ts || 0) - (cache.items[a].ts || 0));
  const items = {};
  keys.slice(0, CACHE_MAX_ITEMS).forEach((k) => { items[k] = cache.items[k]; });
  const spend = {};
  Object.keys(cache.spend).sort().slice(-14).forEach((d) => { spend[d] = cache.spend[d]; });
  const body = JSON.stringify({ v: 1, items, spend });
  const conditions = cache.exists ? { ifMatch: cache.etag } : { ifNoneMatch: "*" };
  await blob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, conditions });
}

// Must mirror the Bid-Out userscript's normName exactly (keys must agree on both sides).
function normName(s) {
  return String(s || "").toLowerCase().replace(/&/g, " and ")
    .replace(/\b(inc|llc|corp|co|company|ltd|the|and|of)\b/g, " ").replace(/[^a-z0-9]+/g, "");
}
// Must mirror the Bid-Out userscript's domainOf exactly (keys must agree on both sides):
// URL-parse (protocol-less strings yield ""), strip www., lowercase.
function domainOf(url) {
  try { return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; }
}
// Key = domain, else normalized name, else the raw lowercased name (an all-stopword name like
// "The Company Inc" normalizes to "" - distinct companies must never share the "" cache key).
// Must mirror the userscript's derivation exactly.
function keyOf(c) { return domainOf(c.website) || normName(c.name) || String(c.name || "").toLowerCase().replace(/\s+/g, " ").trim(); }

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "enrich not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!key || key !== expected) { context.res = json(403, { error: "unauthorized" }); return; }

    // Deploy-dark gate: no ZoomInfo credentials yet -> tell the client cleanly.
    if (!process.env.ZI_USERNAME || !process.env.ZI_PASSWORD) {
      context.res = json(503, { error: "awaiting ZoomInfo credentials", code: "ZI_UNCONFIGURED" });
      return;
    }

    const body = req.body || {};
    let companies = Array.isArray(body.companies) ? body.companies : [];
    companies = companies
      .map((c) => ({ name: String((c && c.name) || "").slice(0, 200).trim(), website: String((c && c.website) || "").slice(0, 300).trim() }))
      .filter((c) => c.name)
      .slice(0, MAX_COMPANIES);
    if (!companies.length) { context.res = json(400, { error: "companies[] with a name each is required" }); return; }

    const dailyCap = Math.max(1, parseInt(process.env.ZI_DAILY_CAP, 10) || DEFAULT_DAILY_CAP);
    const today = new Date().toISOString().slice(0, 10);
    const blob = cacheBlobClient();
    const cache = await readCache(blob);
    const results = {};
    const skippedForCap = [];
    const skippedForTime = [];
    const spentBefore = cache.spend[today] || 0;   // baseline for the delta this call spends
    let spentToday = spentBefore;
    let jwt = null;
    let dirty = false;
    let authFailed = false;
    const writtenKeys = [];        // only these may be merged onto a fresh read (never our stale copies)
    const t0 = Date.now();
    const TIME_BUDGET_MS = 30000;  // stay inside the SWA gateway window; leftovers return as skipped

    for (const c of companies) {
      const k = keyOf(c);
      const hit = cache.items[k];
      if (hit && Date.now() - (hit.ts || 0) < CACHE_TTL_MS) {
        results[k] = { contacts: hit.contacts || [], cached: true };
        continue;
      }
      if (Date.now() - t0 > TIME_BUDGET_MS) { skippedForTime.push(k); continue; }
      if (spentToday + CONTACTS_PER_COMPANY > dailyCap) { skippedForCap.push(k); continue; }
      let looked;
      try {
        if (!jwt) jwt = await ziToken();
        looked = await ziLookup(c, jwt, CONTACTS_PER_COMPANY);
      } catch (e) {
        if (String(e && e.message).indexOf("zi-unauthorized") === 0 || String(e && e.message).indexOf("zi-auth-failed") === 0) {
          // Do NOT throw: credits already burned this request must still be persisted below.
          tokenCache = { jwt: null, exp: 0 };
          authFailed = true;
          break;
        }
        results[k] = { contacts: [], error: "lookup-failed" };
        continue;
      }
      spentToday += looked.billed;   // credits charged per record ZoomInfo RETURNS - count what we submitted
      cache.items[k] = { contacts: looked.contacts, ts: Date.now() };
      writtenKeys.push(k);
      results[k] = { contacts: looked.contacts, cached: false };
      dirty = true;
    }

    if (dirty) {
      cache.spend[today] = spentToday;
      const delta = spentToday - spentBefore;
      // Conditional write with a short merge-retry so concurrent calls don't clobber each other.
      // On conflict: re-read, add OUR DELTA to the fresh counter (a 412 means our write never
      // landed, so the fresh value can't already contain it - Math.max would LOSE concurrent
      // spend), and re-apply only the keys THIS call wrote (our stale copies of other items
      // must not overwrite a concurrent call's fresh entries).
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await writeCache(blob, cache); break; }
        catch (err) {
          if (err.statusCode !== 412 && err.statusCode !== 409) break;   // non-conflict: cache write is best-effort
          const fresh = await readCache(blob);
          writtenKeys.forEach((k) => { fresh.items[k] = cache.items[k]; });
          fresh.spend[today] = (fresh.spend[today] || 0) + delta;
          cache.items = fresh.items; cache.spend = fresh.spend; cache.etag = fresh.etag; cache.exists = fresh.exists;
        }
      }
    }

    if (authFailed) {
      context.res = json(502, { error: "ZoomInfo auth failed - check ZI_USERNAME/ZI_PASSWORD", code: "ZI_AUTH", results, spentToday, dailyCap });
      return;
    }
    context.res = json(200, { ok: true, results, spentToday, dailyCap, skippedForCap, skippedForTime });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg.indexOf("zi-auth-failed") === 0 || msg.indexOf("zi-unauthorized") === 0) {
      context.res = json(502, { error: "ZoomInfo auth failed - check ZI_USERNAME/ZI_PASSWORD", code: "ZI_AUTH" });
      return;
    }
    context.log && context.log.error && context.log.error("enrich-contacts error:", msg);
    context.res = json(500, { error: "enrich failed" });
  }
};
