// Data-store test suite - runs the REAL handler (api/data-store/index.js) with only the
// process boundary stubbed: an etag-aware @azure/storage-blob (honors If-Match -> 412, bumps
// etag per write). Covers the Phase 1 additive slots (wo-dataset, wo-snapshot-history), the
// If-Match / 412 merge-retry contract appendSnapshotHistory relies on, and regressions
// (unknown slot / missing client 400, wo-snapshot-today rotation, revenue-gp financial gate).
// Never rewrites the code under test (Hard Rule 7).
//
// Runs on Node's built-in test runner (node:test) - no dependencies, no build.
// Run with the Adobe-bundled node (no Node on PATH):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-data-store.js

"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert");
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

// ---- helpers -----------------------------------------------------------------------------
function principal(roles) { return { "x-ms-client-principal": Buffer.from(JSON.stringify({ userRoles: roles })).toString("base64") }; }
async function call(method, query, body, headers) {
  const ctx = { log: { error: function () {} } };
  await handler(ctx, { method: method, query: query || {}, body: body || null, headers: headers || {} });
  return ctx.res;
}

describe("data-store handler", () => {
  it("wo-dataset POST -> 200 ok, then GET round-trips data", async () => {
    let r = await call("POST", { key: "wo-dataset", client: "pilot" }, { data: { schemaVersion: 1, rows: [1, 2, 3] }, metadata: { rows: 3 } });
    assert.ok(r.status === 200 && r.body.ok, "wo-dataset POST returns 200 ok");
    let g = await call("GET", { key: "wo-dataset", client: "pilot" });
    assert.ok(g.status === 200 && g.body.exists && g.body.data.rows.length === 3, "wo-dataset GET round-trips data");
  });

  it("wo-snapshot-history POST -> 200 ok, then GET round-trips days map", async () => {
    let r = await call("POST", { key: "wo-snapshot-history", client: "pilot" }, { data: { v: 1, days: { "2026-07-22": { total: 5 } } } });
    assert.ok(r.status === 200 && r.body.ok, "wo-snapshot-history POST returns 200 ok");
    let g = await call("GET", { key: "wo-snapshot-history", client: "pilot" });
    assert.ok(g.body.exists && g.body.data.days["2026-07-22"].total === 5, "wo-snapshot-history GET round-trips days map");
  });

  it("unknown slot -> 400", async () => {
    let r = await call("POST", { key: "not-a-slot", client: "pilot" }, { data: {} });
    assert.strictEqual(r.status, 400);
  });

  it("missing client -> 400", async () => {
    let r = await call("GET", { key: "wo-dataset" });
    assert.strictEqual(r.status, 400);
  });

  it("If-Match / 412 merge-retry contract (what appendSnapshotHistory depends on)", async () => {
    // Fresh slot so etag is deterministic.
    delete store["clients/pilot/wo-snapshot-history"];
    let c = await call("POST", { key: "wo-snapshot-history", client: "pilot" }, { data: { v: 1, days: { a: 1 } } });
    const etag1 = c.body.etag;
    assert.ok(!!etag1, "conditional slot first write returns an etag");
    let stale = await call("POST", { key: "wo-snapshot-history", client: "pilot" }, { data: { v: 1, days: {} }, ifMatch: '"999"' });
    assert.ok(stale.status === 412 && stale.body.etag === etag1, "stale ifMatch -> 412 with current etag handed back");
    let retry = await call("POST", { key: "wo-snapshot-history", client: "pilot" }, { data: { v: 1, days: { a: 1, b: 2 } }, ifMatch: etag1 });
    assert.ok(retry.status === 200 && retry.body.etag !== etag1, "retry with correct etag -> 200 and new etag");
  });

  it("wo-snapshot-today rotation: different-dated snapshot rotates prior to 'previous'", async () => {
    delete store["clients/pilot/wo-snapshot-today"];
    delete store["clients/pilot/wo-snapshot-previous"];
    await call("POST", { key: "wo-snapshot-today", client: "pilot" }, { data: { dateStr: "Mon 07/21/2026", total: 10 } });
    let r = await call("POST", { key: "wo-snapshot-today", client: "pilot" }, { data: { dateStr: "Tue 07/22/2026", total: 12 } });
    assert.ok(r.body.previous && r.body.previous.dateStr === "Mon 07/21/2026", "different-dated snapshot rotates prior to 'previous'");
  });

  it("revenue-gp financial slot gate: without role -> 403", async () => {
    let noauth = await call("GET", { key: "revenue-gp", client: "pilot" });
    assert.strictEqual(noauth.status, 403);
  });

  it("revenue-gp financial slot gate: with ops_manager (L4) -> 200", async () => {
    let withauth = await call("GET", { key: "revenue-gp", client: "pilot" }, null, principal(["ops_manager"]));
    assert.strictEqual(withauth.status, 200);
  });

  it("list surfaces the new slot after a write", async () => {
    let l = await call("GET", { key: null, client: "pilot", action: "list" });
    assert.ok(l.status === 200 && l.body["wo-dataset"] && l.body["wo-dataset"].exists === true, "list shows wo-dataset present");
  });

  // ---- security fix authz-1: om-bonus is a financial slot (L4+ for ALL access) ----------
  it("om-bonus financial gate: no role -> 403 on GET, POST, and DELETE", async () => {
    let g = await call("GET", { key: "om-bonus", client: "pilot" });
    let p = await call("POST", { key: "om-bonus", client: "pilot" }, { data: { bonusTarget: 1000 } });
    let d = await call("DELETE", { key: "om-bonus", client: "pilot" });
    assert.ok(g.status === 403 && p.status === 403 && d.status === 403, "om-bonus without L4 role: " + JSON.stringify([g.status, p.status, d.status]));
  });

  it("om-bonus financial gate: ops_manager (L4) -> allowed and round-trips", async () => {
    let p = await call("POST", { key: "om-bonus", client: "pilot" }, { data: { bonusTarget: 1000 } }, principal(["ops_manager"]));
    let g = await call("GET", { key: "om-bonus", client: "pilot" }, null, principal(["ops_manager"]));
    assert.ok(p.status === 200 && g.status === 200 && g.body.data.bonusTarget === 1000, "om-bonus L4 access: " + JSON.stringify([p.status, g.status]));
  });

  // ---- security fix authz-2 / inj-2: knowledge + config writes need supervisor (L3)+ -----
  it("knowledge write gate: broadway_employee (no elevated role) POST/DELETE -> 403", async () => {
    let p = await call("POST", { key: "knowledge", client: "pilot" }, { data: { v: 1, md: "planted" } });
    let d = await call("DELETE", { key: "knowledge", client: "pilot" });
    assert.ok(p.status === 403 && d.status === 403, "knowledge write without L3: " + JSON.stringify([p.status, d.status]));
  });

  it("knowledge READ stays open at the broadway_employee gate (GET not elevated)", async () => {
    let g = await call("GET", { key: "knowledge", client: "pilot" });
    assert.strictEqual(g.status, 200);   // exists:false is fine; the point is it is NOT 403
  });

  it("knowledge write allowed at ops_supervisor (L3)+", async () => {
    let p = await call("POST", { key: "knowledge", client: "pilot" }, { data: { v: 1, md: "team SOP" } }, principal(["ops_supervisor"]));
    assert.ok(p.status === 200 && p.body.ok, "knowledge write at L3: " + JSON.stringify(p.body));
  });

  it("config write gate: no elevated role -> 403; ops_supervisor -> 200", async () => {
    let denied = await call("POST", { key: "config", client: "pilot" }, { data: { targetGP: 40 } });
    let ok = await call("POST", { key: "config", client: "pilot" }, { data: { targetGP: 40 } }, principal(["ops_supervisor"]));
    assert.ok(denied.status === 403 && ok.status === 200, "config write gate: " + JSON.stringify([denied.status, ok.status]));
  });
});
