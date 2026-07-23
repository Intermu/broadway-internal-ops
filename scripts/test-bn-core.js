/* test-bn-core.js -- guards the bn-core consumption boundary. The live tools now
 * delegate their classifiers to window.BN (bn-core), so this proves the delegation
 * is wired correctly.
 *
 * Runs on Node's built-in test runner (node:test) - no dependencies, no build.
 * Run with the Adobe-bundled node (no Node on PATH):
 *   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bn-core.js
 * or the whole suite dir:
 *   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" --test scripts
 *
 * Extracts the live functions straight out of the HTML by brace-matching, injects
 * BN, and asserts identical output to bn-core across an edge-case corpus (and, when
 * present, every real Source Job # in a Pilot revenue workbook). A mismapped
 * delegator (wrong arg or wrong BN.* fn) fails here.
 *
 * NOTE (pre-existing): the o30Division parity guard is retired (todo below). It is
 * NOT a source regression - O30_BUCKET still exists in the Dashboard (near line 3532).
 * The old red was a harness gap: grabFn brace-extracts o30Division fine, but the body
 * now reads O30_BUCKET plus the divisionOf() -> divisionAuto() -> divisionsCfg() /
 * JOB_DIVISION chain, and a single-function grab injects only BN, so a call throws
 * ReferenceError: O30_BUCKET is not defined. Wiring the whole chain in would still not
 * assert anything useful: o30Division was refactored to client-config-driven, anchored,
 * override-aware classification (with a Q/R bucket), which genuinely diverges from
 * BN.division's fixed unanchored 3-bucket regex - and no live code calls BN.division
 * anymore (its former consumer o30Division was rewritten). Decision deferred: repoint
 * the guard at divisionAuto, or retire BN.division. _cclass / classifyJob /
 * _closedWifiByPO still delegate to BN.* and are guarded here.
 */
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// repo root = parent of this script's dir when run as scripts/test-bn-core.js;
// fall back to cwd so it also runs if copied elsewhere.
const ROOT = fs.existsSync(path.join(__dirname, "..", "bn-core.js"))
  ? path.join(__dirname, "..")
  : process.cwd();

const BN = require(path.join(ROOT, "bn-core.js"));

function grabFn(file, name) {
  const h = fs.readFileSync(file, "utf8");
  const at = h.indexOf("function " + name + "(");
  if (at < 0) throw new Error("could not find " + name + " in " + path.basename(file));
  let depth = 0, started = false, out = "";
  for (let k = at; k < h.length; k++) {
    const c = h[k];
    out += c;
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) break; }
  }
  // eslint-disable-next-line no-new-func
  // Live call sites now delegate to bn-core, so the extracted function references
  // BN; inject it so the delegator resolves (a mismapped delegator fails the asserts).
  return new Function("BN", "return (" + out + ")")(BN);
}

const DASH = path.join(ROOT, "Broadway_Unified_Ops_Dashboard.html");
const DIAG = path.join(ROOT, "Pilot_Proposal_Diagnostic.html");

const _cclass = grabFn(DASH, "_cclass");              // live 4-bucket (delegates to BN.jobClass)
const _closedWifiByPO = grabFn(DASH, "_closedWifiByPO"); // delegates to BN.invoicedWifiByPO
const classifyJob = grabFn(DIAG, "classifyJob");      // live 4-bucket (row form)

const jobCorpus = [
  "", "   ", "1980247", "2098878 (add)", "2098878 - additional",
  "RF 01913140", "RF01913140", "RF-01913140", "RF 5", " RF 7", "PROJECT RF 9", "RFID 123",
  "WIFI (984428)", "WIFI(984428)", "WIFi1048949", "Wi-Fi (123)", "WI 123", "WIFI",
  "Q/R 1155688", "QR 123", "Q/R (1056054)", "QUOTE 5",
  null, undefined, 1980247
];

describe("bn-core v" + BN.VERSION + " parity: job classifiers", () => {
  for (const x of jobCorpus) {
    const label = JSON.stringify(x);
    const s = String(x == null ? "" : x);
    it("jobClass vs _cclass " + label, () => {
      assert.strictEqual(BN.jobClass(x), _cclass(s));
    });
    it("jobClass vs classifyJob " + label, () => {
      assert.strictEqual(BN.jobClass(x), classifyJob({ sourceJobNum: x }));
    });
  }

  // Retired guard (see the file-header NOTE): grabbing o30Division and injecting only
  // BN throws "ReferenceError: O30_BUCKET is not defined" - a harness gap, not a source
  // regression (O30_BUCKET is still defined near Dashboard line 3532). Even fully wired
  // through the divisionOf()/divisionAuto()/JOB_DIVISION chain, o30Division no longer
  // matches BN.division (anchored client-config buckets vs a fixed unanchored regex), and
  // nothing calls BN.division at runtime. Non-gating pending: repoint at divisionAuto or
  // retire BN.division.
  it.todo("division vs BN.division parity - o30Division diverged (divisionOf/divisionAuto); repoint or retire BN.division");
});

const poCorpus = [
  "", null, "WIFI-123", "wifi 5", "WIFItech", "Tech-44", "tech-99",
  "123456789012", "12 - TS - 34", "X-TS-Y", "TS-12", "ABC", "  -TS  ", "PO-100 / PO-200"
];

describe("bn-core parity: invoicedWifiByPO", () => {
  for (const p of poCorpus) {
    it("invoicedWifiByPO " + JSON.stringify(p), () => {
      assert.strictEqual(BN.invoicedWifiByPO(p), _closedWifiByPO(p));
    });
  }
});

// Optional: every real Source Job # in a Pilot revenue workbook, if available.
// xlsx is not installed by default (no node_modules); skip cleanly when absent.
describe("bn-core parity: Pilot revenue workbook (optional)", () => {
  let XLSX = null, wbPath = null;
  try {
    XLSX = require("xlsx");
    const candidates = [
      path.join(ROOT, "Pilot_Revenue_26.xlsx"),
      "/mnt/user-data/uploads/Pilot_Revenue_26.xlsx"
    ];
    wbPath = candidates.find(p => fs.existsSync(p)) || null;
  } catch (e) { /* xlsx module unavailable */ }

  if (XLSX && wbPath) {
    const wb = XLSX.readFile(wbPath);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Work Order Report"], { defval: "" });
    it(rows.length + " Source Job # rows from " + path.basename(wbPath), () => {
      for (const r of rows) {
        const v = r["Source Job #"];
        assert.strictEqual(BN.jobClass(v), _cclass(String(v == null ? "" : v)));
      }
    });
  } else {
    it.skip("workbook corpus (no workbook / xlsx module)", () => {});
  }
});
