#!/usr/bin/env node
/* preflight.js -- Broadway internal ops suite, pre-commit deploy gate.
 * Run from repo root:  node scripts/preflight.js
 *
 * Catches the deploy-breakers before push (SWA auto-deploys on push, so a bad
 * commit is a live outage):
 *   1. Inline <script> syntax errors in every tool (node --check).
 *   2. staticwebapp.config.json route order + rolesSource wiring.
 *   3. BN-THEME sentinel balance (so sync-theme.js can run).
 *   4. CSP presence per tool (advisory).
 * Exits non-zero on any HARD failure (1 or 2). Advisories never fail the gate.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const ROOT = process.cwd();
let hardFail = 0, warn = 0;
const log = (m) => console.log(m);
const fail = (m) => { hardFail++; console.log("  FAIL  " + m); };
const advise = (m) => { warn++; console.log("  WARN  " + m); };

function toolHtml() {
  return fs.readdirSync(ROOT)
    .filter(f => f.toLowerCase().endsWith(".html"))
    .filter(f => f !== "index.html"); // redirect shell, no app logic
}

// 1. inline script syntax ---------------------------------------------------
log("[1] inline <script> syntax (node --check)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bnpf-"));
for (const f of toolHtml()) {
  const html = fs.readFileSync(path.join(ROOT, f), "utf8")
    .replace(/<!--[\s\S]*?-->/g, ""); // drop HTML comments first: a commented-out
                                      // "<script>" mention would otherwise match
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc=/i.test(m[1]) && m[2].trim().length);
  let bad = 0;
  blocks.forEach((m, i) => {
    const js = path.join(tmp, f.replace(/\W+/g, "_") + "." + i + ".js");
    fs.writeFileSync(js, m[2]);
    try { execSync("node --check " + JSON.stringify(js), { stdio: "pipe" }); }
    catch (e) { bad++; fail(f + " block#" + i + ": " + String(e.stderr || e).split("\n")[0]); }
  });
  if (!bad) log("  ok    " + f + " (" + blocks.length + " inline block(s))");
}

// 2. staticwebapp.config.json -----------------------------------------------
log("[2] staticwebapp.config.json routing");
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "staticwebapp.config.json"), "utf8"));
  const order = (cfg.routes || []).map(r => r.route);
  const idx = (p) => order.indexOf(p);
  const before = (a, b, label) => {
    if (idx(a) < 0) return advise("route " + a + " not found (" + label + ")");
    if (idx(b) < 0) return advise("route " + b + " not found (" + label + ")");
    if (idx(a) < idx(b)) log("  ok    " + a + " before " + b);
    else fail(a + " must come before " + b + " (" + label + ")");
  };
  before("/.auth/*", "/api/*", "auth before api");
  before("/api/get-roles", "/api/*", "rolesSource before api guard");
  before("/api/*", "/*", "api before catch-all");
  const rs = cfg.auth && cfg.auth.rolesSource;
  if (rs === "/api/get-roles") log("  ok    rolesSource -> /api/get-roles");
  else advise("auth.rolesSource is " + JSON.stringify(rs) + " (expected /api/get-roles)");
} catch (e) { fail("cannot parse staticwebapp.config.json: " + e.message); }

// 3. theme sentinels --------------------------------------------------------
log("[3] BN-THEME sentinel balance");
for (const f of toolHtml()) {
  const html = fs.readFileSync(path.join(ROOT, f), "utf8");
  const s = html.indexOf("BN-THEME:START"), e = html.indexOf("BN-THEME:END");
  if (s < 0 && e < 0) { log("  --    " + f + " (no theme sentinels; not themed)"); continue; }
  if (s >= 0 && e > s) log("  ok    " + f);
  else fail(f + " has unbalanced/missing BN-THEME sentinels");
}

// 4. CSP presence (advisory) ------------------------------------------------
log("[4] Content-Security-Policy per tool (advisory)");
for (const f of toolHtml()) {
  const html = fs.readFileSync(path.join(ROOT, f), "utf8");
  if (/Content-Security-Policy/i.test(html)) log("  ok    " + f);
  else advise(f + " has no CSP meta -- consider propagating the Diagnostic's CSP");
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
log("--");
log("preflight: " + (hardFail ? hardFail + " hard failure(s)" : "no hard failures") + ", " + warn + " advisory warning(s)");
process.exit(hardFail ? 1 : 0);
