/* test-bn-core.js -- guards the bn-core consumption boundary. The live tools now
 * delegate their classifiers to window.BN (bn-core), so this proves the delegation
 * is wired correctly. Run from repo root:  node scripts/test-bn-core.js
 *
 * Extracts the live functions straight out of the HTML by brace-matching, injects
 * BN, and asserts identical output to bn-core across an edge-case corpus (and, when
 * present, every real Source Job # in a Pilot revenue workbook). A mismapped
 * delegator (wrong arg or wrong BN.* fn) fails here. Exits non-zero on any mismatch
 * so it can gate a commit.
 */
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

const o30Division = grabFn(DASH, "o30Division");      // live 3-bucket
const _cclass = grabFn(DASH, "_cclass");              // live 4-bucket
const _closedWifiByPO = grabFn(DASH, "_closedWifiByPO");
const classifyJob = grabFn(DIAG, "classifyJob");      // live 4-bucket (row form)

let fails = 0, checks = 0;
function eq(label, a, b) {
  checks++;
  if (a !== b) { fails++; console.log("  MISMATCH [" + label + "]  bn=" + JSON.stringify(a) + "  live=" + JSON.stringify(b)); }
}

const jobCorpus = [
  "", "   ", "1980247", "2098878 (add)", "2098878 - additional",
  "RF 01913140", "RF01913140", "RF-01913140", "RF 5", " RF 7", "PROJECT RF 9", "RFID 123",
  "WIFI (984428)", "WIFI(984428)", "WIFi1048949", "Wi-Fi (123)", "WI 123", "WIFI",
  "Q/R 1155688", "QR 123", "Q/R (1056054)", "QUOTE 5",
  null, undefined, 1980247
];

for (const x of jobCorpus) {
  eq("division:" + x, BN.division(x), o30Division({ jobId: (x == null ? x : String(x)) }));
  const s = String(x == null ? "" : x);
  eq("jobClass/_cclass:" + x, BN.jobClass(x), _cclass(s));
  eq("jobClass/classifyJob:" + x, BN.jobClass(x), classifyJob({ sourceJobNum: x }));
}

const poCorpus = [
  "", null, "WIFI-123", "wifi 5", "WIFItech", "Tech-44", "tech-99",
  "123456789012", "12 - TS - 34", "X-TS-Y", "TS-12", "ABC", "  -TS  ", "PO-100 / PO-200"
];
for (const p of poCorpus) eq("invoicedWifiByPO:" + p, BN.invoicedWifiByPO(p), _closedWifiByPO(p));

// Optional: every real Source Job # in a Pilot revenue workbook, if available.
let xlsxNote = "skipped (no workbook / xlsx module)";
try {
  const XLSX = require("xlsx");
  const candidates = [
    path.join(ROOT, "Pilot_Revenue_26.xlsx"),
    "/mnt/user-data/uploads/Pilot_Revenue_26.xlsx"
  ];
  const wbPath = candidates.find(p => fs.existsSync(p));
  if (wbPath) {
    const wb = XLSX.readFile(wbPath);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Work Order Report"], { defval: "" });
    let n = 0;
    for (const r of rows) {
      const v = r["Source Job #"];
      eq("xlsx.division", BN.division(v), o30Division({ jobId: (v == null ? v : String(v)) }));
      eq("xlsx.jobClass", BN.jobClass(v), _cclass(String(v == null ? "" : v)));
      n++;
    }
    xlsxNote = n + " Source Job # rows from " + path.basename(wbPath);
  }
} catch (e) { xlsxNote = "skipped (" + e.message + ")"; }

console.log("bn-core v" + BN.VERSION + " parity: " + (checks - fails) + "/" + checks + " checks passed");
console.log("workbook corpus: " + xlsxNote);
if (fails) { console.log("FAIL: " + fails + " mismatch(es)"); process.exit(1); }
console.log("OK: bn-core is behavior-identical to the live classifiers.");
