#!/usr/bin/env node
/* sync-theme.js -- Broadway internal ops suite.
 * Copies the canonical theme block from bn-theme.css into the BN-THEME sentinel
 * region of each opted-in tool. Run from the repo root:
 *     node sync-theme.js            # apply
 *     node sync-theme.js --dry-run  # preview only, write nothing
 * Single source of truth = bn-theme.css. Tools stay single-file (inline tokens)
 * so snapshot exports remain self-contained.
 */
const fs = require("fs");
const SRC = "bn-theme.css";
const TARGETS = [
  "Broadway_Unified_Ops_Dashboard.html",
  // add tools here as they opt in (must already contain the BN-THEME sentinels):
  // "Pilot_Proposal_Diagnostic.html",
  // "agent.html",
];
const DRY = process.argv.slice(2).some(a => a === "--dry-run" || a === "--dry" || a === "-n");

function region(text, label) {
  const lines = text.split("\n");
  const si = lines.findIndex(l => l.trimStart().startsWith("/* BN-THEME:START"));
  const ei = lines.findIndex(l => l.trimStart().startsWith("/* BN-THEME:END"));
  if (si < 0 || ei < 0 || ei <= si)
    throw new Error("BN-THEME sentinels missing or out of order in " + label);
  return { lines, si, ei };
}

const src = region(fs.readFileSync(SRC, "utf8"), SRC);
const payload = src.lines.slice(src.si + 1, src.ei); // lines strictly between markers

let changed = 0, missing = 0;
for (const t of TARGETS) {
  if (!fs.existsSync(t)) { console.log("? " + t + " (not found, skipped)"); missing++; continue; }
  const text = fs.readFileSync(t, "utf8");
  let r;
  try { r = region(text, t); }
  catch (e) { console.log("! " + t + " (" + e.message + ")"); missing++; continue; }
  const current = r.lines.slice(r.si + 1, r.ei);
  if (current.join("\n") === payload.join("\n")) { console.log("= " + t + " (in sync)"); continue; }
  const updated = [...r.lines.slice(0, r.si + 1), ...payload, ...r.lines.slice(r.ei)];
  changed++;
  console.log("~ " + t + " (" + current.length + " -> " + payload.length + " payload lines)" + (DRY ? " [dry-run]" : ""));
  if (!DRY) fs.writeFileSync(t, updated.join("\n"));
}
console.log("--");
console.log((DRY ? "[dry-run] " : "") + changed + " file(s) " + (DRY ? "would change" : "updated") + ", " + missing + " skipped.");
