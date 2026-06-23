/* bn-core.js -- Broadway National internal ops suite, shared client core.
 *
 * SINGLE SOURCE OF TRUTH for job classification and per-client config. Historically each tool carried
 * its own copy of these rules and they drifted (three near-identical classifiers
 * across the Dashboard and the Diagnostic), which is the root cause of the
 * "looks fine but mis-buckets / drops rows" class of bug. Centralize here.
 *
 * IMPORTANT -- there are deliberately TWO DIFFERENT classification rules, plus a
 * PO rule. Do NOT merge them; merging changes counts in at least one tool:
 *
 *   BN.division(jobId)          3 buckets: 'WiFi' | 'Photometrics' | 'Service'
 *                               UNANCHORED match, used by the Ops Dashboard
 *                               Over-30 review (open jobs). No Q/R bucket --
 *                               Q/R folds into Service there by design.
 *
 *   BN.jobClass(sourceJobNum)   4 buckets: 'wifi' | 'rf' | 'qr' | 'service'
 *                               ANCHORED (^) match, used by the Proposal
 *                               Diagnostic and the Dashboard closed-revenue
 *                               parser. Has a Q/R bucket.
 *
 *   BN.invoicedWifiByPO(po)     boolean. Invoiced/closed WiFi is decided by the
 *                               Source PO # (-TS / Tech- / WIFI), NOT the job
 *                               number. Intentionally different from the two
 *                               classifiers above.
 *
 *   BN.DEFAULT_CLIENT_CONFIG    canonical per-client defaults (over-30 threshold,
 *   BN.mergeConfig(base, over)  proposal target, carve-out prefixes, brands).
 *                               Pages fetch the data-store "config" slot and
 *                               overlay it via mergeConfig; partial blobs only
 *                               override the keys they set. Not a classifier --
 *                               grouped here so every tool reads one definition.
 *
 * Loads as a browser global (window.BN) and as a Node module (module.exports)
 * so the parity regression test can require it. Build-time inlined into each
 * tool's BN-CORE sentinel region by sync-theme.js; the tools' classifiers
 * delegate to it (single source of truth -- edit here, then run sync-theme.js).
 */
(function (root) {
  "use strict";

  var BN = { VERSION: "0.1.0" };

  // 3-bucket, unanchored. Verbatim from Dashboard o30Division (open-job review).
  // Accepts a job-id string (callers previously passed {jobId}); String()-guarded
  // so a stray number can't throw, which is behavior-identical for string inputs.
  BN.division = function (jobId) {
    var id = String(jobId == null ? "" : jobId).toUpperCase();
    if (/WI[\s\-]?FI/.test(id)) return "WiFi";
    if (/(?:^|[^A-Z])RF[\s-]*\d/.test(id)) return "Photometrics";
    return "Service";
  };

  // 4-bucket, anchored. Verbatim from Dashboard _cclass / Diagnostic classifyJob
  // core. Pass the Source Job # string (Diagnostic builds it from
  // sourceJobNum || job || tracking before calling).
  BN.jobClass = function (s) {
    s = String(s == null ? "" : s).trim();
    if (/^WI[\s-]*FI/i.test(s) || /^WI\s/i.test(s)) return "wifi";
    if (/^RF\b/i.test(s)) return "rf";
    if (/^Q\/?R\b/i.test(s)) return "qr";
    return "service";
  };

  // Invoiced/closed WiFi rule (per ops): Source PO # contains "-TS" (allowing
  // spaces around the dash and multi-PO cells), starts with "Tech-", or contains
  // "WIFI" (any casing/delimiter). Verbatim from Dashboard _closedWifiByPO.
  BN.invoicedWifiByPO = function (po) {
    var s = String(po == null ? "" : po).trim();
    if (!s) return false;
    if (/wifi/i.test(s)) return true;
    if (/^tech-/i.test(s)) return true;
    if (s.replace(/\s*-\s*/g, "-").toUpperCase().indexOf("-TS") !== -1) return true;
    return false;
  };

  // ── CLIENT CONFIG ───────────────────────────────────────────────
  // Per-client settings (Pilot vs CrossAmerica vs Primark). These are the
  // canonical defaults; the runtime source of truth is the data-store "config"
  // slot (clients/<client>/config). Pages overlay that blob on top of these via
  // BN.mergeConfig so a partial blob only changes the keys it sets. Values mirror
  // constants historically hardcoded across the tools; migrate consumers onto
  // window._clientConfig.* one at a time.
  BN.DEFAULT_CLIENT_CONFIG = {
    _about: "Fallback only. Runtime source of truth is the data-store 'config' slot (clients/<client>/config).",
    client: "pilot",
    displayName: "Pilot Travel Centers",
    brands: ["PFJ", "Flying J", "Pilot"],
    over30: { threshold: 30, approachingBand: [20, 30], historyCap: 60 },
    proposal: {
      turnaroundDays: 7,
      exclusionValue: "Exclusion",
      carveOuts: { wifiPrefixes: ["WI", "WiFi", "Wi-Fi"], rfPrefixes: ["RF"], qrPrefixes: ["Q", "R"] }
    },
    priorityVocab: ["P1", "P2", "P3", "P4", "Red", "Yellow", "Blue"]
  };

  // Deep-overlay `over` onto `base`: nested plain objects merge recursively;
  // arrays and scalars are replaced wholesale. Returns a new object (inputs are
  // not mutated). A null/undefined `over` yields `base` unchanged.
  BN.mergeConfig = function (base, over) {
    if (!over || typeof over !== "object") return base;
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (var k in over) {
      if (!Object.prototype.hasOwnProperty.call(over, k)) continue;
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) &&
          base && typeof base[k] === "object" && !Array.isArray(base[k]))
        out[k] = BN.mergeConfig(base[k], over[k]);
      else out[k] = over[k];
    }
    return out;
  };

  if (typeof module !== "undefined" && module.exports) module.exports = BN;
  if (root) root.BN = BN;
})(typeof window !== "undefined" ? window : null);
