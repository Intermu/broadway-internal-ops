#!/usr/bin/env node
/* sync-theme.js -- Broadway internal ops suite.
 * Inlines canonical shared blocks into the sentinel regions of each opted-in
 * tool so the tools stay single-file (self-contained snapshots, CSP-safe):
 *   BN-THEME  <- the region between sentinels in bn-theme.css  (design tokens)
 *   BN-CORE   <- the whole of bn-core.js                        (shared classifiers)
 * Run from the repo root:
 *     node sync-theme.js            # apply
 *     node sync-theme.js --dry-run  # preview only, write nothing
 * Single source of truth = bn-theme.css / bn-core.js. A target only receives a
 * block if it already contains that block's sentinels, so tools opt in per block.
 */
const fs = require("fs");

const SOURCES = [
  { src: "bn-theme.css", label: "BN-THEME", mode: "region" },
  { src: "bn-core.js",   label: "BN-CORE",  mode: "file"   },
];
const TARGETS = [
  "Broadway_Unified_Ops_Dashboard.html",
  "Pilot_Proposal_Diagnostic.html",
  // add tools here as they opt in (must contain the relevant sentinels):
  // "agent.html",
];
const DRY = process.argv.slice(2).some(a => a === "--dry-run" || a === "--dry" || a === "-n");

// Find the lines bounding a sentinel region. Sentinels are block comments whose
// content starts with "<LABEL>:START" / "<LABEL>:END" (valid in both CSS and JS).
function findRegion(lines, label) {
  const si = lines.findIndex(l => l.trimStart().startsWith("/* " + label + ":START"));
  const ei = lines.findIndex(l => l.trimStart().startsWith("/* " + label + ":END"));
  if (si < 0 || ei < 0 || ei <= si) return null;
  return { si, ei };
}

// Payload for a source: the region between its own sentinels ("region"), or the
// entire file ("file", with one trailing blank line trimmed).
function payloadFor(source) {
  const lines = fs.readFileSync(source.src, "utf8").split("\n");
  if (source.mode === "file") {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
  const r = findRegion(lines, source.label);
  if (!r) throw new Error(source.label + " sentinels missing in " + source.src);
  return lines.slice(r.si + 1, r.ei);
}

const payloads = SOURCES.map(s => ({ label: s.label, lines: payloadFor(s) }));

let changed = 0, missing = 0;
for (const t of TARGETS) {
  if (!fs.existsSync(t)) { console.log("? " + t + " (not found, skipped)"); missing++; continue; }
  let lines = fs.readFileSync(t, "utf8").split("\n");
  let touched = false;
  for (const p of payloads) {
    const r = findRegion(lines, p.label); // re-find after any prior splice in this file
    if (!r) { console.log("  - " + t + ": no " + p.label + " region (skipped)"); continue; }
    const current = lines.slice(r.si + 1, r.ei);
    if (current.join("\n") === p.lines.join("\n")) { console.log("  = " + t + ": " + p.label + " in sync"); continue; }
    lines = [...lines.slice(0, r.si + 1), ...p.lines, ...lines.slice(r.ei)];
    touched = true;
    console.log("  ~ " + t + ": " + p.label + " (" + current.length + " -> " + p.lines.length + " lines)" + (DRY ? " [dry-run]" : ""));
  }
  if (touched) { changed++; if (!DRY) fs.writeFileSync(t, lines.join("\n")); }
}
console.log("--");
console.log((DRY ? "[dry-run] " : "") + changed + " file(s) " + (DRY ? "would change" : "updated") + ", " + missing + " skipped.");
