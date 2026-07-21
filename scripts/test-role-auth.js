// Role-enforcement test suite - runs the REAL handlers (api/user-role, api/cc-purchase,
// api/cc-receipt, api/hvac-benchmark, api/send-bid) against the REAL shared module
// (api/shared/umbrava-auth.js), with only the process boundaries stubbed: `https` (Umbrava
// GraphQL / Power Automate flow / Microsoft Graph) and `@azure/storage-blob`. Never rewrites
// the code under test (Hard Rule 7).
//
// Run with the Adobe-bundled node (no Node on PATH):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-role-auth.js

"use strict";
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

// ---- tiny runner ----------------------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

const AUTH = require(path.join(__dirname, "..", "api", "shared", "umbrava-auth.js"));
const userRole = require(path.join(__dirname, "..", "api", "user-role", "index.js"));
const ccPurchase = require(path.join(__dirname, "..", "api", "cc-purchase", "index.js"));
const ccReceipt = require(path.join(__dirname, "..", "api", "cc-receipt", "index.js"));
const hvac = require(path.join(__dirname, "..", "api", "hvac-benchmark", "index.js"));
const sendBid = require(path.join(__dirname, "..", "api", "send-bid", "index.js"));

(async function main() {

  // ================= rank ladder (shared module) =================
  console.log("rank ladder");
  check("Operations Coordinator -> 1/staff", AUTH.rankOfRole("Operations Coordinator") === 1);
  check("On Call Coordinator -> 1", AUTH.rankOfRole("On Call Coordinator") === 1);
  check("trailing-space 'Vendor Management Coordinator ' -> 1", AUTH.rankOfRole("Vendor Management Coordinator ") === 1);
  check("Account Executive -> 1", AUTH.rankOfRole("Account Executive") === 1);
  check("Lead Operations Coordinator -> 2/lead", AUTH.rankOfRole("Lead Operations Coordinator") === 2);
  check("National Account Supervisor -> 3/supervisor", AUTH.rankOfRole("National Account Supervisor") === 3);
  check("Billing Manager -> 4/manager", AUTH.rankOfRole("Billing Manager") === 4);
  check("NATIONAL ACCOUNT MANAGER (case) -> 4", AUTH.rankOfRole("NATIONAL ACCOUNT MANAGER") === 4);
  check("Director -> 5/director", AUTH.rankOfRole("Director") === 5);
  check("Construction PM -> 1 (no keyword match, fails closed)", AUTH.rankOfRole("Construction PM") === 1);
  check("Vendor Management MGMT (trailing space) -> 1 (MGMT != manager keyword)", AUTH.rankOfRole("Vendor Management MGMT ") === 1);
  check("On Call Supervisor -> 3", AUTH.rankOfRole("On Call Supervisor") === 3);
  check("Sales / Billing / Admin -> 1", AUTH.rankOfRole("Sales") === 1 && AUTH.rankOfRole("Billing") === 1 && AUTH.rankOfRole("Admin") === 1);
  check("keyword: Regional Operations Supervisor -> 3", AUTH.rankOfRole("Regional Operations Supervisor") === 3);
  check("keyword: Warehouse Manager -> 4", AUTH.rankOfRole("Warehouse Manager") === 4);
  check("keyword: VP of Operations -> 5", AUTH.rankOfRole("VP of Operations") === 5);
  check("unknown 'Analyst' -> 1", AUTH.rankOfRole("Analyst") === 1);
  check("null role -> 1 (vouched staff floor)", AUTH.rankOfRole(null) === 1);
  check("app-setting override: Special Analyst -> 3", AUTH.rankOfRole("Special Analyst") === 3);
  check("tierOfRank(3) = supervisor", AUTH.tierOfRank(3) === "supervisor");

  // ================= user-role (regression vs the shipped behavior) =================
  console.log("user-role");
  let c = ctx(); await userRole(c, reqOf({ method: "OPTIONS" }));
  check("OPTIONS -> 204", c.res.status === 204);

  const savedKey = process.env.WO_INGEST_KEY;
  delete process.env.WO_INGEST_KEY;
  c = ctx(); await userRole(c, reqOf());
  check("no WO_INGEST_KEY -> 503", c.res.status === 503);
  process.env.WO_INGEST_KEY = savedKey;

  c = ctx(); await userRole(c, reqOf({ headers: { "x-bwn-key": "wrong" } }));
  check("bad key -> 403", c.res.status === 403);

  c = ctx(); await userRole(c, reqOf());
  check("no token -> 401 NO_TOKEN", c.res.status === 401 && c.res.body.code === "NO_TOKEN", c.res.body);

  c = ctx(); await userRole(c, reqOf({ body: { token: "abc\ndef" } }));
  check("header-illegal chars -> 401 malformed", c.res.status === 401 && c.res.body.code === "malformed", c.res.body);

  c = ctx(); await userRole(c, reqOf({ body: { token: "onlytwo.parts" } }));
  check("2-part token -> 401 malformed", c.res.status === 401 && c.res.body.code === "malformed", c.res.body);

  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ iss: "https://evil.example.com/" })) } }));
  check("bad iss -> 401 bad-iss + detail", c.res.status === 401 && c.res.body.code === "bad-iss" && c.res.body.detail && c.res.body.detail.iss === "https://evil.example.com/", c.res.body);

  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ aud: ["https://other.example.com"] })) } }));
  check("bad aud -> 401 bad-aud", c.res.status === 401 && c.res.body.code === "bad-aud", c.res.body);

  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ exp: NOW - 3600 })) } }));
  check("expired -> 401 expired", c.res.status === 401 && c.res.body.code === "expired", c.res.body);

  vouchUnauthenticated();
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
  check("Umbrava 500+UNAUTHENTICATED -> 401 not-vouched", c.res.status === 401 && c.res.body.code === "not-vouched", c.res.body);

  vouchDrift();
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
  check("GraphQL validation error -> 503 VOUCH_QUERY_DRIFT", c.res.status === 503 && c.res.body.code === "VOUCH_QUERY_DRIFT", c.res.body);

  vouchDown();
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
  check("Umbrava network error -> 503 UMBRAVA_UNAVAILABLE", c.res.status === 503 && c.res.body.code === "UMBRAVA_UNAVAILABLE", c.res.body);

  vouchOk("National Account Manager", "not-a-broadway-tenant");
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ "https://umbrava.com/tenantid": "also-wrong" })) } }));
  check("wrong tenant (vouch + claim) -> 403 WRONG_TENANT", c.res.status === 403 && c.res.body.code === "WRONG_TENANT", c.res.body);

  vouchOk("National Account Manager");   // vouch tenant = uppercased home tenant, claim wrong
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims({ "https://umbrava.com/tenantid": "not-broadway" })) } }));
  check("vouch tenant passes (case-insensitive) despite bad claim tenant", c.res.status === 200 && c.res.body.ok === true, c.res.body);

  vouchOk("National Account Manager", "");   // vouch tenant empty, claim good
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
  check("claim tenant accepted when vouch tenant empty", c.res.status === 200, c.res.body);

  vouchOk("National Account Manager");
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
  check("manager -> 200 rank 4 tier manager", c.res.status === 200 && c.res.body.rank === 4 && c.res.body.tier === "manager" && c.res.body.role === "National Account Manager", c.res.body);
  check("email lowercased from claim", c.res.body.email === "user@broadwaynational.com", c.res.body.email);
  check("roleSource umbrava + roleQuery me", c.res.body.roleSource === "umbrava" && c.res.body.roleQuery === "me", c.res.body);

  vouchOk("Operations Coordinator");
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
  check("coordinator -> rank 1 tier staff", c.res.status === 200 && c.res.body.rank === 1 && c.res.body.tier === "staff", c.res.body);

  vouchOk(null);
  c = ctx(); await userRole(c, reqOf({ body: { token: tok(claims()) } }));
  check("null role -> 200 rank 1, roleSource none", c.res.status === 200 && c.res.body.rank === 1 && c.res.body.roleSource === "none", c.res.body);

  vouchOk("National Account Manager");
  c = ctx(); await userRole(c, reqOf({ headers: { "x-bwn-key": "testkey", "authorization": "Bearer " + tok(claims()) } }));
  check("auth-header fallback still works (non-proxied context)", c.res.status === 200, c.res.body);

  // THE production scenario: SWA junk in the Authorization header + real token in the body.
  c = ctx(); await userRole(c, reqOf({
    headers: { "x-bwn-key": "testkey", "authorization": "Bearer " + tok({ iss: "https://guid.scm.azurewebsites.net", aud: "https://guid.azurewebsites.net/azurefunctions", exp: NOW + 300 }, { alg: "HS256", typ: "JWT" }) },
    body: { token: tok(claims()) },
  }));
  check("SWA junk header + body token -> body wins, 200", c.res.status === 200 && c.res.body.ok === true, c.res.body);

  c = ctx(); await userRole(c, reqOf({ headers: {}, query: { debug: "1" }, body: { token: tok(claims()) } }));
  check("debug echo unkeyed: no expected/match fields", c.res.status === 200 && c.res.body.keyed === false && !("expectedIss" in c.res.body) && c.res.body.tokenSource === "body", c.res.body);

  c = ctx(); await userRole(c, reqOf({ query: { debug: "1" }, body: { token: tok(claims()) } }));
  check("debug echo keyed: issMatch/audMatch true", c.res.status === 200 && c.res.body.keyed === true && c.res.body.issMatch === true && c.res.body.audMatch === true, c.res.body);

  // ================= cc-purchase (supervisor+ gate) =================
  console.log("cc-purchase");
  flowResponder = function () { return { status: 202, body: {} }; };
  const ccBody = { Date: "2026-07-21", CardUser: "Mike", SupplierName: "Home Depot", TotalAmount: "$1,234.50", actor: "spoofed@evil.com" };

  c = ctx(); await ccPurchase(c, reqOf({ headers: { "x-bwn-key": "wrong" }, body: ccBody }));
  check("bad key -> 403", c.res.status === 403);

  netlog.flow.length = 0;
  c = ctx(); await ccPurchase(c, reqOf({ body: ccBody }));
  check("no userToken -> 401 NO_TOKEN, flow not called", c.res.status === 401 && c.res.body.code === "NO_TOKEN" && netlog.flow.length === 0, c.res.body);

  vouchOk("Operations Coordinator");
  netlog.flow.length = 0;
  c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
  check("coordinator -> 403 ROLE_REQUIRED, flow not called", c.res.status === 403 && c.res.body.code === "ROLE_REQUIRED" && c.res.body.required === "supervisor" && c.res.body.role === "Operations Coordinator" && netlog.flow.length === 0, c.res.body);

  vouchOk("Lead Operations Coordinator");
  c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
  check("lead -> 403 ROLE_REQUIRED", c.res.status === 403 && c.res.body.code === "ROLE_REQUIRED", c.res.body);

  vouchOk("National Account Supervisor");
  netlog.flow.length = 0;
  c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
  check("supervisor -> 200, flow called once", c.res.status === 200 && c.res.body.ok === true && netlog.flow.length === 1, c.res.body);
  let fwd = netlog.flow.length ? JSON.parse(netlog.flow[0]) : {};
  check("flow body is the whitelist only (no userToken/actor leak)", !("userToken" in fwd) && !("actor" in fwd) && fwd.SupplierName === "Home Depot" && fwd.TotalAmount === "1234.50", fwd);
  check("verified email is the logged actor (not client 'actor')", c.logs.some(function (l) { return l.indexOf("user@broadwaynational.com") !== -1; }) && !c.logs.some(function (l) { return l.indexOf("spoofed@evil.com") !== -1; }), c.logs);

  vouchOk("National Account Manager");
  c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
  check("manager -> 200", c.res.status === 200 && c.res.body.ok === true, c.res.body);

  vouchDown();
  netlog.flow.length = 0;
  c = ctx(); await ccPurchase(c, reqOf({ body: Object.assign({ userToken: tok(claims()) }, ccBody) }));
  check("vouch outage -> 503 UMBRAVA_UNAVAILABLE, flow not called", c.res.status === 503 && c.res.body.code === "UMBRAVA_UNAVAILABLE" && netlog.flow.length === 0, c.res.body);

  // ================= cc-receipt (supervisor+ gate BEFORE the Graph config gate) =================
  console.log("cc-receipt");
  c = ctx(); await ccReceipt(c, reqOf({ body: { filename: "r.pdf", contentType: "application/pdf", dataB64: "aGk=" } }));
  check("no userToken -> 401 NO_TOKEN", c.res.status === 401 && c.res.body.code === "NO_TOKEN", c.res.body);

  vouchOk("Operations Coordinator");
  c = ctx(); await ccReceipt(c, reqOf({ body: { userToken: tok(claims()), filename: "r.pdf", contentType: "application/pdf", dataB64: "aGk=" } }));
  check("coordinator -> 403 ROLE_REQUIRED (before config 503)", c.res.status === 403 && c.res.body.code === "ROLE_REQUIRED", c.res.body);

  vouchOk("National Account Supervisor");
  c = ctx(); await ccReceipt(c, reqOf({ body: { userToken: tok(claims()), filename: "r.pdf", contentType: "application/pdf", dataB64: "aGk=" } }));
  check("supervisor + Graph unconfigured -> 503 (gate passed, config gate hit)", c.res.status === 503 && /graph app not configured/.test(String(c.res.body.error)), c.res.body);

  // ================= hvac-benchmark (identity fixed: body token + shared vouch) =================
  console.log("hvac-benchmark");
  vouchOk("Operations Coordinator");
  c = ctx(); await hvac(c, reqOf({ query: { action: "whoami" }, body: {} }));
  check("no token -> 401 NO_TOKEN", c.res.status === 401 && c.res.body.code === "NO_TOKEN", c.res.body);

  c = ctx(); await hvac(c, reqOf({ query: { action: "whoami" }, body: { token: tok(claims()) } }));
  check("whoami via POST body token -> 200 private (no roster)", c.res.status === 200 && c.res.body.ok === true && c.res.body.scope === "private" && c.res.body.email === "user@broadwaynational.com", c.res.body);

  c = ctx(); await hvac(c, reqOf({ query: { action: "read" }, body: { token: tok(claims()) } }));
  check("POST ?action=read -> 200 (read path, index null)", c.res.status === 200 && c.res.body.ok === true && c.res.body.index === null, c.res.body);

  blobState.uploads.length = 0;
  c = ctx(); await hvac(c, reqOf({ body: { token: tok(claims()), index: { price: { a: 1 }, assets: { a: {} } } } }));
  check("POST save with body token -> 200 + blob write", c.res.status === 200 && c.res.body.ok === true && blobState.uploads.length === 1, c.res.body);

  c = ctx(); await hvac(c, reqOf({ query: { action: "roster" }, body: { token: tok(claims()) } }));
  check("roster as non-admin -> 403", c.res.status === 403, c.res.body);

  // roster admin: read (POST, no roster prop) then write
  vouchOk("National Account Manager");
  const adminClaims = claims({ "https://umbrava.com/email": "admin@broadwaynational.com" });
  c = ctx(); await hvac(c, reqOf({ query: { action: "roster" }, body: { token: tok(adminClaims) } }));
  check("roster admin POST w/o roster -> read (200, empty default)", c.res.status === 200 && c.res.body.ok === true && c.res.body.roster && Array.isArray(c.res.body.roster.teams), c.res.body);

  c = ctx(); await hvac(c, reqOf({ query: { action: "roster" }, body: { token: tok(adminClaims), roster: { v: 1, teams: [{ id: "team-a", owner: "admin@broadwaynational.com", members: ["user@broadwaynational.com"] }] } } }));
  check("roster admin POST with roster -> save (200)", c.res.status === 200 && c.res.body.ok === true && c.res.body.teams === 1, c.res.body);

  vouchOk("Operations Coordinator");
  c = ctx(); await hvac(c, reqOf({ query: { action: "whoami" }, body: { token: tok(claims()) } }));
  check("whoami after roster seed -> team scope", c.res.status === 200 && c.res.body.scope === "team" && c.res.body.teamId === "team-a", c.res.body);

  // ================= send-bid (vouched identity while deploy-dark) =================
  console.log("send-bid");
  netlog.vouch.length = 0;
  c = ctx(); await sendBid(c, reqOf({ body: { from: "x@broadwaynational.com" } }));
  check("deploy-dark -> 503 before any vouch call", c.res.status === 503 && netlog.vouch.length === 0, c.res.body);

  process.env.BID_TENANT_ID = "t"; process.env.BID_CLIENT_ID = "c"; process.env.BID_CLIENT_SECRET = "s";
  process.env.BID_FROM_DOMAIN = "broadwaynational.com";
  c = ctx(); await sendBid(c, reqOf({ body: { from: "x@broadwaynational.com" } }));
  check("configured, no userToken -> 401 NO_TOKEN", c.res.status === 401 && c.res.body.code === "NO_TOKEN", c.res.body);

  vouchOk("Operations Coordinator");
  c = ctx(); await sendBid(c, reqOf({ body: { userToken: tok(claims()), from: "not-an-email" } }));
  check("vouched staff passes the gate (hits 400 invalid 'from')", c.res.status === 400 && /invalid 'from'/.test(String(c.res.body.error)), c.res.body);

  vouchDown();
  c = ctx(); await sendBid(c, reqOf({ body: { userToken: tok(claims()), from: "x@broadwaynational.com" } }));
  check("vouch outage -> 503", c.res.status === 503 && c.res.body.code === "UMBRAVA_UNAVAILABLE", c.res.body);
  delete process.env.BID_TENANT_ID; delete process.env.BID_CLIENT_ID; delete process.env.BID_CLIENT_SECRET; delete process.env.BID_FROM_DOMAIN;

  // ---- done ----
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error("suite crashed:", e && e.stack || e); process.exit(1); });
