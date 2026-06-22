# SWA Suite — Onboarding & Contributor Guide

How to add or change a tool in the Broadway internal ops Static Web App without breaking
deploy, auth, routing, or the shared utilities. Keep tools single-file and browser-first.

## Deploy model
Edit file → commit → push. Azure SWA auto-redeploys on push, so **a bad commit is a live
outage**. The only build step is theme sync (`node sync-theme.js`). Always run preflight
before you push.

## Before every commit
```
node scripts/preflight.js        # hard-fails block the commit; review advisories
node scripts/test-bn-core.js     # only if you touched classifiers or bn-core.js
```
`preflight.js` checks: inline `<script>` syntax in every tool, `staticwebapp.config.json`
route order + rolesSource wiring, BN-THEME sentinel balance, and CSP presence (advisory).

## The one invariant you must never break — route order
In `staticwebapp.config.json`, these must stay in this relative order:
`/.auth/*` → `/api/get-roles` → `/api/*` → … → `/*` (catch-all last).
`/api/get-roles` is the SWA `rolesSource`; if it falls below `/api/*` it gets the
`broadway_employee` guard and role resolution silently breaks. Preflight check [2] guards this.

## Onboarding a parked HTML tool — checklist
1. **Place** `<Tool>.html` at the repo root (alongside the other tools).
2. **Route + auth**: add a route entry with `"allowedRoles": ["broadway_employee"]`,
   keeping the order invariant above. The catch-all `/*` already covers it; an explicit
   entry is only needed for per-tool role differences.
3. **Theme**: add `/* BN-THEME:START */ … /* BN-THEME:END */` sentinels in the tool's
   `<style>`, add the filename to `TARGETS` in `sync-theme.js`, then run `node sync-theme.js`.
4. **Classification**: use `bn-core` (below) — do not re-implement division / jobClass /
   invoiced-WiFi logic. Re-implementation is exactly the drift that caused past mis-bucketing.
5. **CSP**: copy the Diagnostic's `Content-Security-Policy` meta (`script-src 'self' cdnjs
   'unsafe-inline'`, `connect-src 'self'`, `frame-ancestors 'none'`).
6. **Nav**: register the tool in `Broadway_Projects_Tracker.html` (the hub).
7. **Blob slots**: name new slots `clients/{client}/{slot}` — never hardcode flat keys.
8. **Preflight**, then commit/push.

## bn-core.js — shared classifiers (canonical source of truth)
`bn-core.js` holds the job-classification rules so they can't drift across tools again.
Three intentionally-distinct functions — **do not merge them** (merging changes counts):

| Function | Buckets | Match | Used by |
|---|---|---|---|
| `BN.division(jobId)` | WiFi / Photometrics / Service | unanchored | Dashboard Over-30 (open jobs) |
| `BN.jobClass(srcJobNum)` | wifi / rf / qr / service | anchored `^` | Diagnostic, closed-revenue parser |
| `BN.invoicedWifiByPO(po)` | boolean | PO `-TS` / `Tech-` / `WIFI` | invoiced-WiFi (PO-driven, NOT job #) |

`bn-core.js` works as a browser global (`window.BN`) and a Node module (the parity test
requires it). Run `node scripts/test-bn-core.js` after any change to prove it still matches
the live in-file classifiers (it diffs against the real functions plus a workbook corpus).

### Consuming bn-core (migration decision — not yet wired)
Until a tool is migrated, it still carries its own copy and `bn-core.js` is canonical
source only (referenced by nothing, so it's safe to ship). When migrating a tool, pick one:
- **(Recommended) Build-time inline** via `BN-CORE:START/END` sentinels + extend
  `sync-theme.js` to also sync `bn-core.js`. Preserves the self-contained single-file tool
  (snapshot exports keep working offline) — same pattern as the theme.
- **Runtime link** `<script src="bn-core.js"></script>`. Simpler, but the tool is no longer
  self-contained for snapshot export. CSP `script-src 'self'` already allows it.

Migrate one tool at a time; replace its local function bodies with delegations to `BN.*`,
run the parity test, preflight, then push.

## Authoring note (MCP / `edit_file`)
The Filesystem `edit_file` tool runs JS `String.replace`-style substitution on `newText`.
Escape `$` as `$$` when it is followed by `'`, `` ` ``, `&`, `$`, or a digit `1`–`9`
(`$0`, `${`, `$ ` are safe). For brand-new files use `write_file` (no substitution).
Always preflight after an MCP edit.
