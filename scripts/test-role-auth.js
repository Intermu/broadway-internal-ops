// Role-enforcement test suite - runs the REAL handlers (api/user-role, api/cc-purchase,
// api/cc-receipt, api/hvac-benchmark, api/send-bid) against the REAL shared module
// (api/shared/umbrava-auth.js), with only the process boundaries stubbed: `https` (Umbrava
// GraphQL / Power Automate flow / Microsoft Graph) and `@azure/storage-blob`. Never rewrites
// the code under test (Hard Rule 7).
//
// Runs on Node's built-in test runner (node:test) - no dependencies, no build.
// Run with the Adobe-bundled node (no Node on PATH):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-role-auth.js

"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const Module = require("module");

// ---- env BEFORE any handler/module require (the shared module reads env at load) --------
process.env.WO_INGEST_KEY = "testkey";
process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
process.env.CC_PURCHASE_FLOW_URL = "https://flow.example.com/trigger?sig=x";
process.env.ROSTER_ADMINS = "admin@broadwaynational.com";
process.env.UMBRAVA_ROLE_RANKS = "Special Analyst=3";   // exercises the app-setting override
delete process.env.UMBRAVA_ISS; delete process.env.UMBRAVA_AUD;
delete process.env.UMBRAVA_TENANTS; delete process.env.UMBRAVA_GRAPHQL;
delete process.env.BID_TENANT_ID; delete process.env.BID_CLIENT_ID; delete process.env.BID_CLIENT_SECRET;
delete process.env.BID_FROM_ALLOWED; delete process.env.BID_FROM_DOMAIN;
delete process.env.AAD_TENANT_ID; delete process.env.AAD_CLIENT_ID; delete process.env.AAD_CLIENT_SECRET;
delete process.env.CC_RECEIPT_FOLDER_URL;

// ---- @azure/storage-blob stub (hvac-benchmark / send-bid) --------------------------------
const blobState = { docs: {}, uploads: [] };   // docs[name] = obj served on download
function nf() { const e = new Error("not found"); e.statusCode = 404; return e; }
const blobStub = {
  BlobServiceClient: {
    fromConnectionString: function () {
      return {
        getContainerClient: function () {
          return {
            createIfNotExists: async function () { },
            getBlockBlobClient: function (name) {
              return {
                download: async function () {
                  if (!(name in blobState.docs)) throw nf();
                  const txt = JSON.stringify(blobState.docs[name]);
                  return {
                    metadata: {},
                    etag: '"e1"',
                    readableStreamBody: (async function* () { yield Buffer.from(txt); })(),
                  };
                },
                upload: async function (body, len, opts) {
                  blobState.uploads.push({ name: name, body: String(body), opts: opts });
                  blobState.docs[name] = JSON.parse(String(body));
                },
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

// ---- https stub ---------------------------------------------------------------------------
// Routed by host: app.umbrava.com -> vouch, flow.example.com -> Power Automate trigger,
// login.microsoftonline.com / graph.microsoft.com -> Graph. Each responder gets
// (opts, bodyStr) and returns { status, body } or throws (network error).
const https = require("https");
const netlog = { vouch: [], flow: [], graph: [] };
let vouchResponder = null, flowResponder = null, graphResponder = null;
https.request = function (opts, cb) {
  const chunks = [];
  const req = {
    _h: {},
    on: function (ev, fn) { this._h[ev] = fn; return this; },
    setTimeout: function () { return this; },
    write: function (d) { chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); return true; },
    destroy: function (err) { if (err && this._h.error) this._h.error(err); },
    end: function (payload) {
      if (payload) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const host = String(opts.hostname || opts.host || "");
      const self = this;
      setImmediate(function () {
        let out;
        try {
          if (host === "app.umbrava.com") { netlog.vouch.push(bodyStr); out = vouchResponder(opts, bodyStr); }
          else if (host === "flow.example.com") { netlog.flow.push(bodyStr); out = flowResponder(opts, bodyStr); }
          else if (host === "login.microsoftonline.com" || host === "graph.microsoft.com") { netlog.graph.push(bodyStr); out = graphResponder(opts, bodyStr); }
          else throw new Error("unexpected host " + host);
        } catch (e) { if (self._h.error) self._h.error(e); return; }
        const res = { statusCode: out.status, _h: {}, on: function (ev, fn) { this._h[ev] = fn; return this; } };
        cb(res);
        const raw = out.raw != null ? out.raw : JSON.stringify(out.body == null ? {} : out.body);
        if (res._h.data && raw) res._h.data(raw);
        if (res._h.end) res._h.end();
      });
      return this;
    },
  };
  return req;
};

// ---- token + request helpers ---------------------------------------------------------------
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function tok(claims, header) { return b64u(header || { alg: "RS256", kid: "k1", typ: "JWT" }) + "." + b64u(claims) + ".c2ln"; }
const NOW = Math.floor(Date.now() / 1000);
const HOME_TENANT = "42726f61-6477-6179-4e61-74696f6e616c";
function claims(over) {
  return Object.assign({
    iss: "https://login.umbrava.com/",
    aud: ["https://app.umbrava.com/api"],
    exp: NOW + 3600,
    sub: "waad|abc123",
    "https://umbrava.com/email": "User@BroadwayNational.com",
    "https://umbrava.com/tenantid": HOME_TENANT,
  }, over || {});
}
function vouchOk(roleName, tenantId) {
  vouchResponder = function () {
    return { status: 200, body: { data: { me: { id: "u1", tenantId: tenantId === undefined ? HOME_TENANT.toUpperCase() : tenantId, profile: { id: "p1", role: roleName == null ? null : { id: 17, name: roleName } } } } } };
  };
}
function vouchUnauthenticated() {
  vouchResponder = function () { return { status: 500, body: { errors: [{ message: "nope", extensions: { code: "UNAUTHENTICATED" } }] } }; };
}
function vouchDrift() {
  vouchResponder = function () { return { status: 400, body: { errors: [{ message: "Cannot query field" }] } }; };
}
function vouchDown() { vouchResponder = function () { throw new Error("ECONNRESET"); }; }

function ctx() {
  const logs = [];
  const log = function () { logs.push(Array.prototype.slice.call(arguments).join(" ")); };
  log.warn = log; log.error = log;
  return { log: log, logs: logs, res: null };
}
function reqOf(over) {
  return Object.assign({ method: "POST", headers: { "x-bwn-key": "testkey" }, query: {}, body: {} }, over || {});
}

const AUTH = require(path.join(__dirname, "..", "api", "shared", "umbrava-auth.js"));
const userRole = require(path.join(__dirname, "..", "api", "user-role", "index.js"));
const ccPurchase = require(path.join(__dirname, "..", "api", "cc-purchase", "index.js"));
const ccReceipt = require(path.join(__dirname, "..", "api", "cc-receipt", "index.js"));
const hvac = require(path.join(__dirname, "..", "api", "hvac-benchmark", "index.js"));
const sendBid = require(path.join(__dirname, "..", "api", "send-bid", "index.js"));

// ================= rank ladder (shared module) =================
describe("rank ladder", () => {
  it("Operations Coordinator -> 1/staff", () => assert.strictEqual(AUTH.rankOfRole("Operations Coordinator"), 1));
  it("On Call Coordinator -> 1", () => assert.strictEqual(AUTH.rankOfRole("On Call Coordinator"), 1));
  it("trailing-space 'Vendor Management Coordinator ' -> 1", () => assert.strictEqual(AUTH.rankOfRole("Vendor Management Coordinator "), 1));
  it("Account Executive -> 1", () => assert.strictEqual(AUTH.rankOfRole("Account Executive"), 1));
  it("Lead Operations Coordinator -> 2/lead", () => assert.strictEqual(AUTH.rankOfRole("Lead Operations Coordinator"), 2));
  it("National Account Supervisor -> 3/supervisor", () => assert.strictEqual(AUTH.rankOfRole("National Account Supervisor"), 3));
  it("Billing Manager -> 4/manager", () => assert.strictEqual(AUTH.rankOfRole("Billing Manager"), 4));
  it("NATIONAL ACCOUNT MANAGER (case) -> 4", () => assert.strictEqual(AUTH.rankOfRole("NATIONAL ACCOUNT MANAGER"), 4));
  it("Director -> 5/director", () => assert.strictEqual(AUTH.rankOfRole("Director"), 5));
  it("Construction PM -> 1 (no keyword match, fails closed)", () => assert.strictEqual(AUTH.rankOfRole("Construction PM"), 1));
  it("Vendor Management MGMT (trailing space) -> 1 (MGMT != manager keyword)", () => assert.strictEqual(AUTH.rankOfRole("Vendor Management MGMT "), 1));
  it("On Call Supervisor -> 3", () => assert.strictEqual(AUTH.rankOfRole("On Call Supervisor"), 3));
  it("Sales / Billing / Admin -> 1", () => assert.ok(AUTH.rankOfRole("Sales") === 1 && AUTH.rankOfRole("Billing") === 1 && AUTH.rankOfRole("Admin") === 1));
  it("keyword: Regional Operations Supervisor -> 3", () => assert.strictEqual(AUTH.rankOfRole("Regional Operations Supervisor"), 3));
  it("keyword: Warehouse Manager -> 4", () => assert.strictEqual(AUTH.rankOfRole("Warehouse Manager"), 4));
  it("keyword: VP of Operations -> 5", () => assert.strictEqual(AUTH.rankOfRole("VP of Operations"), 5));
  it("unknown 'Analyst' -> 1", () => assert.strictEqual(AUTH.rankOfRole("Analyst"), 1));
  it("null role -> 1 (vouched staff floor)", () => assert.strictEqual(AUTH.rankOfRole(null), 1));
  it("app-setting override: Special Analyst -> 3", () => assert.strictEqual(AUTH.rankOfRole("Special Analyst"), 3));
  it("tierOfRank(3) = supervisor", () => assert.strictEqual(AUTH.tierOfRank(3), "supervisor"));
});

// ================= user-role (regression vs the shipped behavior) =================
describe("user-role", () => {
  it("OPTIONS -> 204", async () => {
    const c = ctx(); await userRole(c, reqOf({ method: "OPTIONS" }));
    assert.strictEqual(c.res.status, 204);
  });

  it("no WO_INGEST_KEY -> 503", async () => {
    const savedKey = process.env.WO_INGEST_KEY;
    delete process.env.WO_INGEST_KEY;
    const c = ctx(); await userRole(c, reqOf());
    process.env.WO_INGEST_KEY = savedKey;
    assert.strictEqual(c.res.status, 503);
  });

  it("bad key -> 403", async () => {
    const c = ctx(); await userRole(c, reqOf({ headers: { "x-bwn-key": "wrong" } }));
    assert.strictEqual(c.res.status, 403);
  });

  it("no token -> 401 NO_TOKEN", async () => {
    const c = ctx(); await userRole(c, reqOf());
    assert.ok(c.res.status === 401 && c.res.body.code === "NO_TOKEN", JSON.stringify(c.res.body));
  });

  it("header-illegal chars -> 401 malformed", async () => {
    const c = ctx(); await userRole(c, reqOf({ body: { token: "abc\ndef" } }));
    assert.ok(c.res.status === 401 && c.res.body.code === "malformed", JSON.stringify(c.res.body));
  });

  it("2-part token -> 401 malformed", async () => {
    const c = ctx(); await userRole(c, reqOf({ body: { token: "onlytwo.parts" } }));
    assert.ok(c.res.status === 401 && c.res.body.code === "malformed", JSON.stringify(c.res.body));
  });

  it("bad iss -> 401 bad-iss + detail", async () => {
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ iss: "https://evil.example.com/" })) } }));
    assert.ok(c.res.status === 401 && c.res.body.code === "bad-iss" && c.res.body.detail && c.res.body.detail.iss === "https://evil.example.com/", JSON.stringify(c.res.body));
  });

  it("bad aud -> 401 bad-aud", async () => {
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ aud: ["https://other.example.com"] })) } }));
    assert.ok(c.res.status === 401 && c.res.body.code === "bad-aud", JSON.stringify(c.res.body));
  });

  it("expired -> 401 expired", async () => {
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ exp: NOW - 3600 })) } }));
    assert.ok(c.res.status === 401 && c.res.body.code === "expired", JSON.stringify(c.res.body));
  });

  it("Umbrava 500+UNAUTHENTICATED -> 401 not-vouched", async () => {
    vouchUnauthenticated();
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 401 && c.res.body.code === "not-vouched", JSON.stringify(c.res.body));
  });

  it("GraphQL validation error -> 503 VOUCH_QUERY_DRIFT", async () => {
    vouchDrift();
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 503 && c.res.body.code === "VOUCH_QUERY_DRIFT", JSON.stringify(c.res.body));
  });

  it("Umbrava network error -> 503 UMBRAVA_UNAVAILABLE", async () => {
    vouchDown();
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 503 && c.res.body.code === "UMBRAVA_UNAVAILABLE", JSON.stringify(c.res.body));
  });

  it("wrong tenant (vouch + claim) -> 403 WRONG_TENANT", async () => {
    vouchOk("National Account Manager", "not-a-broadway-tenant");
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ "https://umbrava.com/tenantid": "also-wrong" })) } }));
    assert.ok(c.res.status === 403 && c.res.body.code === "WRONG_TENANT", JSON.stringify(c.res.body));
  });

  it("vouch tenant passes (case-insensitive) despite bad claim tenant", async () => {
    vouchOk("National Account Manager");   // vouch tenant = uppercased home tenant, claim wrong
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ "https://umbrava.com/tenantid": "not-broadway" })) } }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true, JSON.stringify(c.res.body));
  });

  it("claim tenant accepted when vouch tenant empty", async () => {
    vouchOk("National Account Manager", "");   // vouch tenant empty, claim good
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
    assert.strictEqual(c.res.status, 200);
  });

  it("manager -> 200 rank 4 tier manager (+ email lowercased + roleSource)", async () => {
    vouchOk("National Account Manager");
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 200 && c.res.body.rank === 4 && c.res.body.tier === "manager" && c.res.body.role === "National Account Manager", "manager -> 200 rank 4 tier manager: " + JSON.stringify(c.res.body));
    assert.strictEqual(c.res.body.email, "user@broadwaynational.com", "email lowercased from claim");
    assert.ok(c.res.body.roleSource === "umbrava" && c.res.body.roleQuery === "me", "roleSource umbrava + roleQuery me: " + JSON.stringify(c.res.body));
  });

  it("coordinator -> rank 1 tier staff", async () => {
    vouchOk("Operations Coordinator");
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 200 && c.res.body.rank === 1 && c.res.body.tier === "staff", JSON.stringify(c.res.body));
  });

  it("null role -> 200 rank 1, roleSource none", async () => {
    vouchOk(null);
    const c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 200 && c.res.body.rank === 1 && c.res.body.roleSource === "none", JSON.stringify(c.res.body));
  });

  it("auth-header fallback still works (non-proxied context)", async () => {
    vouchOk("National Account Manager");
    const c = ctx(); await userRole(c, reqOf({ headers: { "x-bwn-key": "testkey", "authorization": "Bearer " + tok(claims()) } }));
    assert.strictEqual(c.res.status, 200);
  });

  it("SWA junk header + body token -> body wins, 200", async () => {
    // THE production scenario: SWA junk in the Authorization header + real token in the body.
    vouchOk("National Account Manager");
    const c = ctx(); await userRole(c, reqOf({
      headers: { "x-bwn-key": "testkey", "authorization": "Bearer " + tok({ iss: "https://guid.scm.azurewebsites.net", aud: "https://guid.azurewebsites.net/azurefunctions", exp: NOW + 300 }, { alg: "HS256", typ: "JWT" }) },
      body: { token: tok(claims()) },
    }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true, JSON.stringify(c.res.body));
  });

  it("debug echo unkeyed: no expected/match fields", async () => {
    vouchOk("National Account Manager");
    const c = ctx(); await userRole(c, reqOf({ headers: {}, query: { debug: "1" }, body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 200 && c.res.body.keyed === false && !("expectedIss" in c.res.body) && c.res.body.tokenSource === "body", JSON.stringify(c.res.body));
  });

  it("debug echo keyed: issMatch/audMatch true", async () => {
    vouchOk("National Account Manager");
    const c = ctx(); await userRole(c, reqOf({ query: { debug: "1" }, body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 200 && c.res.body.keyed === true && c.res.body.issMatch === true && c.res.body.audMatch === true, JSON.stringify(c.res.body));
  });
});

// ================= cc-purchase (supervisor+ gate) =================
describe("cc-purchase", () => {
  flowResponder = function () { return { status: 202, body: {} }; };
  const ccBody = { Date: "2026-07-21", CardUser: "Mike", SupplierName: "Home Depot", TotalAmount: "$1,234.50", actor: "spoofed@evil.com" };

  it("bad key -> 403", async () => {
    const c = ctx(); await ccPurchase(c, reqOf({ headers: { "x-bwn-key": "wrong" }, body: ccBody }));
    assert.strictEqual(c.res.status, 403);
  });

  it("no userToken -> 401 NO_TOKEN, flow not called", async () => {
    netlog.flow.length = 0;
    const c = ctx(); await ccPurchase(c, reqOf({ body: ccBody }));
    assert.ok(c.res.status === 401 && c.res.body.code === "NO_TOKEN" && netlog.flow.length === 0, JSON.stringify(c.res.body));
  });

  it("coordinator -> 403 ROLE_REQUIRED, flow not called", async () => {
    vouchOk("Operations Coordinator");
    netlog.flow.length = 0;
    const c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
    assert.ok(c.res.status === 403 && c.res.body.code === "ROLE_REQUIRED" && c.res.body.required === "supervisor" && c.res.body.role === "Operations Coordinator" && netlog.flow.length === 0, JSON.stringify(c.res.body));
  });

  it("lead -> 403 ROLE_REQUIRED", async () => {
    vouchOk("Lead Operations Coordinator");
    const c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
    assert.ok(c.res.status === 403 && c.res.body.code === "ROLE_REQUIRED", JSON.stringify(c.res.body));
  });

  it("supervisor -> 200, flow called once (whitelist only, verified email logged)", async () => {
    vouchOk("National Account Supervisor");
    netlog.flow.length = 0;
    const c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true && netlog.flow.length === 1, "supervisor -> 200, flow called once: " + JSON.stringify(c.res.body));
    const fwd = netlog.flow.length ? JSON.parse(netlog.flow[0]) : {};
    assert.ok(!("userToken" in fwd) && !("actor" in fwd) && fwd.SupplierName === "Home Depot" && fwd.TotalAmount === "1234.50", "flow body is the whitelist only (no userToken/actor leak): " + JSON.stringify(fwd));
    assert.ok(c.logs.some(function (l) { return l.indexOf("user@broadwaynational.com") !== -1; }) && !c.logs.some(function (l) { return l.indexOf("spoofed@evil.com") !== -1; }), "verified email is the logged actor (not client 'actor'): " + JSON.stringify(c.logs));
  });

  it("manager -> 200", async () => {
    vouchOk("National Account Manager");
    const c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true, JSON.stringify(c.res.body));
  });

  it("vouch outage -> 503 UMBRAVA_UNAVAILABLE, flow not called", async () => {
    vouchDown();
    netlog.flow.length = 0;
    const c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
    assert.ok(c.res.status === 503 && c.res.body.code === "UMBRAVA_UNAVAILABLE" && netlog.flow.length === 0, JSON.stringify(c.res.body));
  });
});

// ================= cc-receipt (supervisor+ gate BEFORE the Graph config gate) =================
describe("cc-receipt", () => {
  it("no userToken -> 401 NO_TOKEN", async () => {
    const c = ctx(); await ccReceipt(c, reqOf({ body: { filename: "r.pdf", contentType: "application/pdf", dataB64: "aGk=" } }));
    assert.ok(c.res.status === 401 && c.res.body.code === "NO_TOKEN", JSON.stringify(c.res.body));
  });

  it("coordinator -> 403 ROLE_REQUIRED (before config 503)", async () => {
    vouchOk("Operations Coordinator");
    const c = ctx(); await ccReceipt(c, reqOf({ body: { userToken: tok(claims()), filename: "r.pdf", contentType: "application/pdf", dataB64: "aGk=" } }));
    assert.ok(c.res.status === 403 && c.res.body.code === "ROLE_REQUIRED", JSON.stringify(c.res.body));
  });

  it("supervisor + Graph unconfigured -> 503 (gate passed, config gate hit)", async () => {
    vouchOk("National Account Supervisor");
    const c = ctx(); await ccReceipt(c, reqOf({ body: { userToken: tok(claims()), filename: "r.pdf", contentType: "application/pdf", dataB64: "aGk=" } }));
    assert.ok(c.res.status === 503 && /graph app not configured/.test(String(c.res.body.error)), JSON.stringify(c.res.body));
  });
});

// ================= hvac-benchmark (identity fixed: body token + shared vouch) =================
describe("hvac-benchmark", () => {
  const adminClaims = claims({ "https://umbrava.com/email": "admin@broadwaynational.com" });

  it("no token -> 401 NO_TOKEN", async () => {
    vouchOk("Operations Coordinator");
    const c = ctx(); await hvac(c, reqOf({ query: { action: "whoami" }, body: {} }));
    assert.ok(c.res.status === 401 && c.res.body.code === "NO_TOKEN", JSON.stringify(c.res.body));
  });

  it("whoami via POST body token -> 200 private (no roster)", async () => {
    vouchOk("Operations Coordinator");
    const c = ctx(); await hvac(c, reqOf({ query: { action: "whoami" }, body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true && c.res.body.scope === "private" && c.res.body.email === "user@broadwaynational.com", JSON.stringify(c.res.body));
  });

  it("POST ?action=read -> 200 (read path, index null)", async () => {
    vouchOk("Operations Coordinator");
    const c = ctx(); await hvac(c, reqOf({ query: { action: "read" }, body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true && c.res.body.index === null, JSON.stringify(c.res.body));
  });

  it("POST save with body token -> 200 + blob write", async () => {
    vouchOk("Operations Coordinator");
    blobState.uploads.length = 0;
    const c = ctx(); await hvac(c, reqOf({ body: { token: tok(claims()), index: { price: { a: 1 }, assets: { a: {} } } } }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true && blobState.uploads.length === 1, JSON.stringify(c.res.body));
  });

  it("roster as non-admin -> 403", async () => {
    vouchOk("Operations Coordinator");
    const c = ctx(); await hvac(c, reqOf({ query: { action: "roster" }, body: { token: tok(claims()) } }));
    assert.strictEqual(c.res.status, 403);
  });

  it("roster admin POST w/o roster -> read (200, empty default)", async () => {
    vouchOk("National Account Manager");
    const c = ctx(); await hvac(c, reqOf({ query: { action: "roster" }, body: { token: tok(adminClaims) } }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true && c.res.body.roster && Array.isArray(c.res.body.roster.teams), JSON.stringify(c.res.body));
  });

  it("roster admin POST with roster -> save (200)", async () => {
    vouchOk("National Account Manager");
    const c = ctx(); await hvac(c, reqOf({ query: { action: "roster" }, body: { token: tok(adminClaims), roster: { v: 1, teams: [{ id: "team-a", owner: "admin@broadwaynational.com", members: ["user@broadwaynational.com"] }] } } }));
    assert.ok(c.res.status === 200 && c.res.body.ok === true && c.res.body.teams === 1, JSON.stringify(c.res.body));
  });

  it("whoami after roster seed -> team scope", async () => {
    vouchOk("Operations Coordinator");
    const c = ctx(); await hvac(c, reqOf({ query: { action: "whoami" }, body: { token: tok(claims()) } }));
    assert.ok(c.res.status === 200 && c.res.body.scope === "team" && c.res.body.teamId === "team-a", JSON.stringify(c.res.body));
  });
});

// ================= send-bid (vouched identity while deploy-dark) =================
describe("send-bid", () => {
  it("deploy-dark -> 503 before any vouch call", async () => {
    netlog.vouch.length = 0;
    const c = ctx(); await sendBid(c, reqOf({ body: { from: "x@broadwaynational.com" } }));
    assert.ok(c.res.status === 503 && netlog.vouch.length === 0, JSON.stringify(c.res.body));
  });

  it("configured, no userToken -> 401 NO_TOKEN", async () => {
    process.env.BID_TENANT_ID = "t"; process.env.BID_CLIENT_ID = "c"; process.env.BID_CLIENT_SECRET = "s";
    process.env.BID_FROM_DOMAIN = "broadwaynational.com";
    const c = ctx(); await sendBid(c, reqOf({ body: { from: "x@broadwaynational.com" } }));
    assert.ok(c.res.status === 401 && c.res.body.code === "NO_TOKEN", JSON.stringify(c.res.body));
  });

  it("vouched staff passes the gate (hits 400 invalid 'from')", async () => {
    vouchOk("Operations Coordinator");
    const c = ctx(); await sendBid(c, reqOf({ body: { userToken: tok(claims()), from: "not-an-email" } }));
    assert.ok(c.res.status === 400 && /invalid 'from'/.test(String(c.res.body.error)), JSON.stringify(c.res.body));
  });

  it("vouch outage -> 503", async () => {
    vouchDown();
    const c = ctx(); await sendBid(c, reqOf({ body: { userToken: tok(claims()), from: "x@broadwaynational.com" } }));
    assert.ok(c.res.status === 503 && c.res.body.code === "UMBRAVA_UNAVAILABLE", JSON.stringify(c.res.body));
    delete process.env.BID_TENANT_ID; delete process.env.BID_CLIENT_ID; delete process.env.BID_CLIENT_SECRET; delete process.env.BID_FROM_DOMAIN;
  });
});
