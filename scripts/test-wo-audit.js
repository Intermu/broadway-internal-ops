// WO Audit summarize proxy test suite - runs the REAL handler (api/wo-audit/index.js)
// against the REAL shared module (api/shared/umbrava-auth.js), with only the `https`
// process boundary stubbed (Anthropic Messages). Never rewrites the code under test.
//
// Covers the 2026-07-23 security fixes: the constant-time x-bwn-key gate (crypto-2, via
// AUTH.safeStrEqual), the per-IP courtesy throttle (val-1), and the suppression of the
// upstream Anthropic error body / raw exception in responses (val-4). Plus the gates and
// the no-tool happy path.
//
// Runs on Node's built-in test runner (node:test) - no dependencies, no build.
// Run with the Adobe-bundled node (no Node on PATH):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit.js

"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

// ---- env BEFORE the handler require --------------------------------------------------------
process.env.WO_INGEST_KEY = "testkey";
process.env.ANTHROPIC_API_KEY = "sk-test";
delete process.env.WO_AUDIT_RL_MAX;

// ---- https stub (Anthropic only; wo-audit does no vouch) -----------------------------------
const https = require("https");
const netlog = { model: [] };
let modelResponder = null;
https.request = function (opts, cb) {
  const chunks = [];
  const self = {
    on: function (ev, fn) { this["_" + ev] = fn; return this; },
    write: function (d) { chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); return true; },
    destroy: function (err) { if (err && this._error) this._error(err); },
    end: function (payload) {
      if (payload) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const host = String(opts.hostname || opts.host || "");
      const me = this;
      setImmediate(function () {
        let out;
        try {
          if (host !== "api.anthropic.com") throw new Error("unexpected host " + host);
          netlog.model.push(bodyStr); out = modelResponder(opts, bodyStr);
        } catch (e) { if (me._error) me._error(e); return; }
        const res = { statusCode: out.status, _h: {}, on: function (ev, fn) { this._h[ev] = fn; return this; } };
        cb(res);
        const raw = out.raw != null ? out.raw : JSON.stringify(out.body == null ? {} : out.body);
        if (res._h.data && raw) res._h.data(raw);
        if (res._h.end) res._h.end();
      });
      return this;
    },
  };
  return self;
};
function mNote(text) { return { status: 200, body: { content: [{ type: "text", text: text }], stop_reason: "end_turn" } }; }

// ---- helpers -------------------------------------------------------------------------------
function ctx() { const log = function () {}; log.warn = log; log.error = log; return { log: log, res: null }; }
function reqOf(over) {
  return Object.assign({ method: "POST", headers: { "x-bwn-key": "testkey" }, query: {}, body: {} }, over || {});
}
const wa = require(path.join(__dirname, "..", "api", "wo-audit", "index.js"));
const okBody = { wo: { raw: "361519", status: "In Progress" }, notes: [{ content: "Vendor scheduled Tuesday.", createdDate: "2026-07-20", type: "Client" }] };

describe("wo-audit gates", () => {
  it("OPTIONS -> 204", async () => { const c = ctx(); await wa(c, reqOf({ method: "OPTIONS" })); assert.strictEqual(c.res.status, 204); });
  it("GET -> 405", async () => { const c = ctx(); await wa(c, reqOf({ method: "GET" })); assert.strictEqual(c.res.status, 405); });
  it("bad key -> 403 (constant-time compare)", async () => {
    const c = ctx(); await wa(c, reqOf({ headers: { "x-bwn-key": "wrong" }, body: okBody }));
    assert.strictEqual(c.res.status, 403);
  });
  it("no WO_INGEST_KEY -> 503", async () => {
    const saved = process.env.WO_INGEST_KEY; delete process.env.WO_INGEST_KEY;
    const c = ctx(); await wa(c, reqOf({ body: okBody }));
    process.env.WO_INGEST_KEY = saved;
    assert.strictEqual(c.res.status, 503);
  });
  it("missing wo.raw/number -> 400", async () => {
    const c = ctx(); await wa(c, reqOf({ body: { wo: {}, notes: [] } }));
    assert.strictEqual(c.res.status, 400);
  });
});

describe("wo-audit happy path", () => {
  it("valid request -> 200 with note text", async () => {
    netlog.model.length = 0;
    modelResponder = function () { return mNote("Vendor is scheduled for Tuesday; awaiting on-site completion."); };
    const c = ctx(); await wa(c, reqOf({ headers: { "x-bwn-key": "testkey", "x-forwarded-for": "1.1.1.1" }, body: okBody }));
    assert.ok(c.res.status === 200 && /scheduled for Tuesday/.test(c.res.body.note) && netlog.model.length === 1, JSON.stringify(c.res.body));
  });
});

describe("wo-audit error suppression (val-4)", () => {
  it("upstream Anthropic error -> 502 with NO detail/raw echoed", async () => {
    modelResponder = function () { return { status: 429, raw: "{\"error\":{\"type\":\"rate_limit\",\"message\":\"quota billing internals\"}}" }; };
    const c = ctx(); await wa(c, reqOf({ headers: { "x-bwn-key": "testkey", "x-forwarded-for": "2.2.2.2" }, body: okBody }));
    assert.ok(c.res.status === 502, "status: " + c.res.status);
    assert.ok(c.res.body.detail === undefined, "no detail field leaked: " + JSON.stringify(c.res.body));
    assert.ok(!/quota billing internals/.test(JSON.stringify(c.res.body)), "raw provider body must not be echoed");
  });
});

describe("wo-audit throttle (val-1)", () => {
  it("over the per-IP cap -> 429", async () => {
    process.env.WO_AUDIT_RL_MAX = "2";
    modelResponder = function () { return mNote("ok"); };
    const hdr = { "x-bwn-key": "testkey", "x-forwarded-for": "3.3.3.3" };   // isolated bucket
    const r1 = ctx(); await wa(r1, reqOf({ headers: hdr, body: okBody }));
    const r2 = ctx(); await wa(r2, reqOf({ headers: hdr, body: okBody }));
    const r3 = ctx(); await wa(r3, reqOf({ headers: hdr, body: okBody }));
    delete process.env.WO_AUDIT_RL_MAX;
    assert.ok(r1.res.status === 200 && r2.res.status === 200 && r3.res.status === 429,
      "3rd over cap -> 429: " + JSON.stringify([r1.res.status, r2.res.status, r3.res.status]));
  });
});
