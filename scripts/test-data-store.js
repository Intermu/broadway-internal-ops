// Data-store test suite - runs the REAL handler (api/data-store/index.js) with only the
// process boundary stubbed: an etag-aware @azure/storage-blob (honors If-Match -> 412, bumps
// etag per write). Covers the Phase 1 additive slots (wo-dataset, wo-snapshot-history), the
// If-Match / 412 merge-retry contract appendSnapshotHistory relies on, and regressions
// (unknown slot / missing client 400, wo-snapshot-today rotation, revenue-gp financial gate).
// Never rewrites the code under test (Hard Rule 7).
//
// Run with the Adobe-bundled node (no Node on PATH):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-data-store.js

"use strict";
const path = require("path");
const Module = require("module");

process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";

// ---- etag-aware @azure/storage-blob stub -------------------------------------------------
const store = {}; // name -> { body:string, meta, etag:number }
function notFound() { const e = new Error("not found"); e.statusCode = 404; return e; }
function condFail() { const e = new Error("condition not met"); e.statusCode = 412; return e; }
const blobStub = {
  BlobServiceClient: {
    fromConnectionString: function () {
      return {
        getContainerClient: function () {
          return {
            createIfNotExists: async function () {},
            getBlockBlobClient: function (name) {
              return {
                download: async function () {
                  const rec = store[name];
                  if (!rec) throw notFound();
                  return {
                    metadata: rec.meta,
                    etag: '"' + rec.etag + '"',
                    readableStreamBody: (async function* () { yield Buffer.from(rec.body); })(),
                  };
                },
                upload: async function (body, len, opts) {
                  const rec = store[name];
                  const cond = (opts && opts.conditions) || {};
                  if (cond.ifMatch && (!rec || ('"' + rec.etag + '"') !== cond.ifMatch)) throw condFail();
                  if (cond.ifNoneMatch === "*" && rec) throw condFail();
                  const etag = (rec ? rec.etag : 0) + 1;
                  store[name] = { body: String(body), meta: (opts && opts.metadata) || {}, etag: etag };
                  return { etag: '"' + etag + '"' };
                },
                getProperties: async function () {
                  const rec = store[name];
                  if (!rec) throw notFound();
                  return { metadata: rec.meta };
                },
                deleteIfExists: async function () { delete store[name]; },
              };
            },
          };
        },
      };
    },
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/storage-blob") return blobStub;
  return realLoad.apply(this, arguments);
};

const handler = require(path.join(__dirname, "..", "api", "data-store", "index.js"));

// ---- harness -----------------------------------------------------------------------------
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.log("  FAIL: " + label); } }
function principal(roles) { return { "x-ms-client-principal": Buffer.from(JSON.stringify({ userRoles: roles })).toString("base64") }; }
async function call(method, query, body, headers) {
  const ctx = { log: { error: function () {} } };
  await handler(ctx, { method: method, query: query || {}, body: body || null, headers: headers || {} });
  return ctx.res;
}

(async function () {
  // 1. wo-dataset accepted: POST then GET round-trip
  let r = await call("POST", { key: "wo-dataset", client: "pilot" }, { data: { schemaVersion: 1, rows: [1, 2, 3] }, metadata: { rows: 3 } });
  ok(r.status === 200 && r.body.ok, "wo-dataset POST returns 200 ok");
  let g = await call("GET", { key: "wo-dataset", client: "pilot" });
  ok(g.status === 200 && g.body.exists && g.body.data.rows.length === 3, "wo-dataset GET round-trips data");

  // 2. wo-snapshot-history accepted
  r = await call("POST", { key: "wo-snapshot-history", client: "pilot" }, { data: { v: 1, days: { "2026-07-22": { total: 5 } } } });
  ok(r.status === 200 && r.body.ok, "wo-snapshot-history POST returns 200 ok");
  g = await call("GET", { key: "wo-snapshot-history", client: "pilot" });
  ok(g.body.exists && g.body.data.days["2026-07-22"].total === 5, "wo-snapshot-history GET round-trips days map");

  // 3. unknown slot rejected
  r = await call("POST", { key: "not-a-slot", client: "pilot" }, { data: {} });
  ok(r.status === 400, "unknown slot -> 400");

  // 4. missing client rejected
  r = await call("GET", { key: "wo-dataset" });
  ok(r.status === 400, "missing client -> 400");

  // 5. If-Match / 412 merge-retry contract (what appendSnapshotHistory depends on)
  //    Fresh slot so etag is deterministic.
  delete store["clients/pilot/wo-snapshot-history"];
  let c = await call("POST", { key: "wo-snapshot-history", client: "pilot" }, { data: { v: 1, days: { a: 1 } } });
  const etag1 = c.body.etag;
  ok(!!etag1, "conditional slot first write returns an etag");
  let stale = await call("POST", { key: "wo-snapshot-history", client: "pilot" }, { data: { v: 1, days: {} }, ifMatch: '"999"' });
  ok(stale.status === 412 && stale.body.etag === etag1, "stale ifMatch -> 412 with current etag handed back");
  let retry = await call("POST", { key: "wo-snapshot-history", client: "pilot" }, { data: { v: 1, days: { a: 1, b: 2 } }, ifMatch: etag1 });
  ok(retry.status === 200 && retry.body.etag !== etag1, "retry with correct etag -> 200 and new etag");

  // 6. wo-snapshot-today rotation regression
  delete store["clients/pilot/wo-snapshot-today"];
  delete store["clients/pilot/wo-snapshot-previous"];
  await call("POST", { key: "wo-snapshot-today", client: "pilot" }, { data: { dateStr: "Mon 07/21/2026", total: 10 } });
  r = await call("POST", { key: "wo-snapshot-today", client: "pilot" }, { data: { dateStr: "Tue 07/22/2026", total: 12 } });
  ok(r.body.previous && r.body.previous.dateStr === "Mon 07/21/2026", "different-dated snapshot rotates prior to 'previous'");

  // 7. financial slot gate unchanged
  let noauth = await call("GET", { key: "revenue-gp", client: "pilot" });
  ok(noauth.status === 403, "revenue-gp without role -> 403");
  let withauth = await call("GET", { key: "revenue-gp", client: "pilot" }, null, principal(["ops_manager"]));
  ok(withauth.status === 200, "revenue-gp with ops_manager (L4) -> 200");

  // 8. list surfaces the new slot after a write
  let l = await call("GET", { key: null, client: "pilot", action: "list" });
  ok(l.status === 200 && l.body["wo-dataset"] && l.body["wo-dataset"].exists === true, "list shows wo-dataset present");

  console.log("\ndata-store: " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error("harness error:", e); process.exit(1); });
