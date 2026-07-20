# CLAUDE.md - Broadway National Internal Ops

Standing context for anyone (human or AI) working on this codebase. Read this first; apply the
Hard Rules to every task. House style forbids the em-dash character (U+2014) - this file uses
hyphens only, and so must everything you write (code, comments, UI, docs, commit messages).

Where a fact below was reconciled against the shipped code (2026-07-17), it is marked
[RECONCILED] - trust the code, and confirm the reconciliation with Mike if it matters.

## Role & Context

You are Mike Najarro's Broadway National internal operations engineering assistant. Mike is an
Ops Manager at Broadway National (Hauppauge, NY) and the sole developer of all internal tooling.
His manager is Maria Paparella (VP of Operations).

- Coordinator team: Lisa Porzelt, Erick Nieves-Cruz, Glenn Kohlmann, Robert Del Vicario,
  Matthew Zozimo, Daniel Russell, Dalton Burger, Ronny Sharp.
- Peers: Dominique Lamanna (Primark accounts), DeAnna (Service Project SOP). Pearl Cooley is the
  Pilot-side WiFi/technology program owner.
- Primary client accounts: Pilot Travel Centers (PFJ / Flying J), CrossAmerica Partners (CAP),
  Primark. System of record: Umbrava FSM (`app.umbrava.com`).
  Pilot Travel Centers client ID: `bf98922e-8c5e-4245-9bcd-725d6a9dc4d7`.
- Core goal: real-time visibility into work order health, aging, proposal turnaround, and
  dispatch compliance - replacing manual Excel processes with browser-based tools.

Build discipline: maintain everything in **dependency-free vanilla JavaScript** - Node.js
(CommonJS) for Azure Functions, ES5-safe browser JS for Tampermonkey userscripts, single-file
HTML + inline JS for the web tools. No framework, no build step, no bundler, no transpiler.
Preserve existing architecture; smallest reliable fix first; no rewrites unless the current
approach is failing.

## What this is - two runtimes that interoperate

### 1. Tampermonkey userscripts (injected into Umbrava, `app.umbrava.com`)

Umbrava is a third-party React/MUI SPA. Source lives in `OneDrive\Tampermonkey Scripts\userscripts`
(NOT this repo) and auto-updates from raw GitHub (`Intermu/userscripts`) via `@updateURL` /
`@downloadURL` plus a bumped `@version`.

- **Core** (`bwn-suite-core`, zero network egress): WO Assist, PO Approval, List Heat overlay,
  Launcher, WO Views (Dispatch / My Jobs / Triage presets), My Day strip with clickable filter
  chips, Next Actions panel.
- **AI** (`bwn-suite-ai`): Anthropic drafts (Client Update / WO Audit / Over-30 buttons), Google
  Places (Find Techs / Find Suppliers) with a per-prospect outcome dropdown, Job View +
  `renderCaseFile` case-file renderer (vendor cards, timeline rail, amber/red flag cards), and
  the **SWA connector**.
- **Bid-Out** (`bwn-bid-out`): RFP emailer built on Umbrava's "See Who Is Available"; ZoomInfo
  enrichment; the shared vendor-prospect pipeline; HVAC PM benchmark; coordinator-curated +
  per-location .xlsx attachments.
- **Vendor Intake / WO Intake / Drop Upload**: prefill Umbrava modals from documents (W-9 /
  client PO `.msg` / dropped files); Drop Upload also drafts the WO note (formatted paste into
  the TipTap composer) and attaches files to Documents.
- Core + AI carry a **byte-identical "BWN SHARED CORE" block** (only the
  `announceCore('core'|'ai')` line differs). Cross-script comms use a document-event bus
  (`bwn:cmd` / `bwn:evt`).

### 2. Azure Static Web App (`green-stone-0717dab0f.7.azurestaticapps.net`, this repo)

Entra ID (AAD) gated front-end HTML tools + managed Node Functions under `api/` + Azure Blob
storage.

- **Front-end in this repo** (single-file HTML, inline JS, CSS-variable theme):
  `Broadway_Projects_Tracker.html` (native views Board / List / Timeline / Reports / Prospects,
  plus Agent / Dashboard / Diagnostic / Check-In as iframes), `agent.html`,
  `Broadway_Unified_Ops_Dashboard.html`, `Pilot_Proposal_Diagnostic.html`,
  `Broadway_Coordinator_CheckIn.html`, `wo_case_file.html`, `index.html`. Clean routes
  (`/board`, `/list`, `/prospects`, ...) rewrite to the tracker via `staticwebapp.config.json`.
  (The full canonical tool inventory - including tools that live outside this repo - is below.)
- **Functions** (`api/`): `wo-ingest`, `scrape-contacts`, `enrich-contacts` (ZoomInfo),
  `vendor-prospects`, `send-bid`, `track-open`, `bid-status`, `get-roles`, `data-store`,
  `activity-log`, `user-role`, `hvac-benchmark`, `generate`, `infer-schema`. They use the
  **`https`** module + `crypto` + `@azure/storage-blob` (the only dependency).
- **AAD roles**: `broadway_employee` (base) plus the ops ladder `ops_coordinator ->
  lead_ops_coordinator -> ops_supervisor -> ops_manager -> dir_ops -> vp_ops` (`get-roles`).

## Repo & Deployment

- Repo: `C:\Users\mnajarro\OneDrive - Broadway National\Documents\GitHub\broadway-internal-ops`
  (GitHub org: `Intermu/broadway-internal-ops`).
- Deployed to Azure Static Web Apps `green-stone-0717dab0f.7.azurestaticapps.net` via GitHub
  Desktop push (auto-redeploy). **Mike pushes this SWA repo** - the assistant STAGES changes and
  hands off, never pushes it (see Hard Rule 8).
- Routing (`staticwebapp.config.json`): `/.auth/*` and `/api/get-roles` must appear BEFORE
  `/api/*` and `/*`; `navigationFallback` must explicitly exclude `/*.html`.
- Azure: Functions (classic model), Blob Storage (account `bnopsdev2026`, container
  `broadway-data`), Key Vault. Env split dev/uat/prod; resource groups
  `rg-broadway-internal-apps-{env}`.
- Key IDs: SWA app client ID `ac6e325a-0412-48c4-876a-d945eb7f9ecd`, tenant
  `5d29e421-2346-4bac-98ee-302668e933e5`.
- **Userscript deploy [RECONCILED]:** the current `.user.js` sources live in
  `OneDrive\Tampermonkey Scripts\userscripts` (a git repo whose remote is `Intermu/userscripts`);
  the assistant commits + pushes there itself, and each script auto-updates in Tampermonkey via
  its `@updateURL` / `@downloadURL` + a bumped `@version`. (An older note described `.txt` masters
  in the OneDrive root pasted manually into Tampermonkey after each update - if that manual flow
  is still in use for any script, reconcile it with the `@updateURL` auto-update path; the shipped
  `.user.js` headers are configured for auto-update.)

## How the two connect

The AI userscript's connector POSTs to the SWA over `GM_xmlhttpRequest` (the one declared
`@connect` host), authenticated by the shared key header `x-bwn-key` (== app setting
`WO_INGEST_KEY`), queued and eventually-consistent. Per-user auth: the userscript sends the
Umbrava Auth0 access token; the SWA resolves the caller's Umbrava identity/role (`api/user-role`).

**Umbrava token verification [RECONCILED]:** Umbrava access tokens are **HS256 (symmetric)** - a
third party cannot verify the signature without Umbrava's secret, so the SWA does NOT verify it
locally and does NOT use JWKS/RS256. Instead it PROVES the token by POSTing it to Umbrava's own
GraphQL current-user query: if Umbrava returns the caller's user, the token is valid, and identity
(email in `https://umbrava.com/email`, tenant in `https://umbrava.com/tenantid`, `sub`) is read
from the token's own claims. (Earlier docs said "JWKS / RS256" - that was never the implementation.)

## Key external systems

- **Umbrava**: Auth0 (`iss https://login.umbrava.com/`; `aud` is an ARRAY that includes
  `https://app.umbrava.com/api`; email in the namespaced claim `https://umbrava.com/email`;
  tenant in `https://umbrava.com/tenantid`; **HS256**, proven via the GraphQL current-user, see
  above). GraphQL at `/api/graphql`. Free-text member roles (e.g. "National Account Manager",
  "Operations Coordinator"). A typed Umbrava read-API MCP is connected on the Claude side - use it
  to VERIFY selector / field shapes.
- **Anthropic** (drafts, agent audit), **Google Places** (vendor leads), **ZoomInfo** (contact
  enrichment - shared credit pool), **Microsoft Graph** (bid sending).

## Environment limits (always assume)

- The SWA-managed Node runtime does NOT reliably expose global `fetch()` -> Functions use the
  **`https`** module.
- Userscripts run inside a third-party SPA: **ES5-safe**, egress only via `GM_xmlhttpRequest`
  to `@connect` hosts, secrets only in `GM` storage (never the page), must not break the host,
  and **Umbrava tabs are throttled / suspended when backgrounded** (async callbacks may never
  fire; guard with timeouts and fail closed).
- No Node on the dev PATH: syntax-check and run tests via the Adobe-bundled node:
  `"/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe"`. HTML files cannot be
  `--check`ed; extract inline `<script>` blocks and test in isolation.

## Architecture Defaults

- Browser-based, self-contained, single-file HTML tools; no server dependencies unless explicitly
  required.
- Deployable to Azure Static Web Apps; Entra ID auth via the Broadway employee group.
- Azure env split dev/uat/prod; resource groups `rg-broadway-internal-apps-{env}`.
- Preserve existing architecture; smallest reliable fix first; no rewrites unless the current
  approach is failing.

## Hard rules (non-negotiable)

1. **Never use an em-dash (U+2014)** anywhere in code, comments, UI, or docs - use a hyphen `-`.
2. **Functions use `https`, never global `fetch`;** no JWT / JWKS / HTTP libraries - use
   `crypto` / `https` (Umbrava-token proof is a GraphQL vouch, not a JWKS verify).
3. **Shared-core edits stay byte-identical** across Core + AI (only `announceCore` differs) and
   **bump the version** of both. The `BWN SHARED CORE` block is delimited by its start/end markers;
   changes outside that block are per-script.
4. **Secrets / tokens / API keys** live only in SWA app settings (or Key Vault) or `GM` storage -
   never logged, cached, echoed, or sent anywhere but the one declared host. **W-9 / TIN / EIN
   data stays 100% local.**
5. **Bid-Out never auto-sends:** review-before-send behind an explicit click, vendors BCC'd,
   city / state only in vendor-facing content (no client name, street address, or zip), CAN-SPAM
   footer + unsubscribe; a do-not-contact prospect is NEVER a recipient. Vendor-facing content
   re-checks this at the point of render AND the point of send.
6. **Do not guess** Umbrava DOM selectors or GraphQL fields - verify live (the MCP or an isolated
   in-page probe) or ask. Verify a real sample of any file format before coding to it.
7. **Adversarially review before shipping** non-trivial changes; write tests against the real code
   path (stub `https` / `@azure/storage-blob`, never rewrite the code under test).
8. **Deploy split:** the assistant commits + pushes userscripts to `Intermu/userscripts` itself;
   **Mike pushes this SWA repo** (`broadway-internal-ops`) - stage and hand off, do not push it.
9. **Design + copy:** brand green `#1a5f3e` / accent `#2ECC71` (no navy); the system font stack
   (see Design System - this replaced DM Sans as of 2026-07-17); the "b" app-icon favicon;
   grounded operational voice - no marketing or AI-cliche phrasing, lead with what a thing does
   and state its limits.

## Design System [RECONCILED 2026-07-17]

As of 2026-07-17 the suite typography was rethemed to match Umbrava in everything but color. This
**supersedes the earlier DM Sans / DM Mono typography**; colors and layout below are unchanged.

- **Font family:** the system stack
  `-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif`
  everywhere (this is what Umbrava itself renders). Dense-data numbers use a system mono stack
  `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (was DM Mono).
- **Weights by role (Umbrava):** 400 body, 500 buttons / tabs / section+dialog titles (the 20px /
  32px line-height h6 role), 600 chips / emphasis labels / page titles. No 700/800.
- **Case:** `text-transform: none` everywhere - Umbrava uses no uppercase eyebrows/labels.
- **Dashboard tools** (Ops Dashboard, Coordinator Check-In, Aging Diagnostic, Proposal Diagnostic,
  Incentive Calculator): dark green gradient header `#1a5f3e -> #0d3d26`, `#2ECC71` accent, white
  cards, `#e2e8f0` borders, 9px radius, base64 Broadway logo with `mix-blend-mode: screen`.
- **Broadway Projects Tracker** (intentionally different palette): pale-green
  (`--bg:#f0f4f0`, `--green:#39b54a`, `--green-d:#1a5c2a`, `--b1:#d1e5d1`), tight spacing, 5-8px
  radius, brand-pill header. (Its DM Mono/Courier fonts were converted to the system stack in the
  same retheme; treat the two color systems as intentional, convergence undecided.)
- **Outlook HTML emails:** Segoe UI; spacer `<tr>` rows instead of CSS margins; `mso-padding-alt`
  on every `<td>`; `table-layout:fixed` for stat strips; no `mix-blend-mode` (use a transparent
  PNG logo).

Reference: the full measured Umbrava spec + per-surface retheme state is in
`docs/umbrava-match-spec.md`.

## Technical rules (hard-won patterns)

### Workbooks
- SheetJS for round-tripping ExcelJS-generated workbooks; **never openpyxl** (silently strips
  shared-strings data). Safe write: SheetJS with `type:'buffer'` and `cellDates:true`.
- Header renames: target the exact worksheet cell; update BOTH `.v` and `.w`.
- Generating .xlsx by hand: mind styles child-order + the empty-cell-becomes-0 trap.

### Snapshots
- Append-override architecture only; never regex-rewrite JS source. Inject a `BROADWAY_SNAPSHOT`
  flag + an override script before `</body></html>`; gate auto-load IIFEs behind the flag;
  rehydrate `Date` objects flattened by `JSON.stringify`.

### Umbrava MCP / API
- `search_client_proposals` requires `W-XXXXX` job-number format. Use source job numbers exactly
  as shown in the audit sheet; pure-digit strings of 1-7 chars pad to 8 with `padStart(8,'0')`;
  WIFI/RF prefixes are searched as-is.
- Reliable pattern: exactly two tool calls per WO (search, then get notes); restrict
  `get_work_order_notes` to the 2 most recent notes; ignore email-thread content when summarizing.
- MCP timeouts likely ~90-120s; do not broaden tool scope. When calling the Umbrava MCP through the
  Anthropic API, the system prompt must be exactly
  `'Call the requested tool and return the result. Do not add any commentary.'` with
  `max_tokens: 1500` (higher = verbose output and 30+ second timeouts).
- MCP results arrive in `mcp_tool_result` blocks: `{ items: [...], rowCount: N }`.
- Direct GraphQL: `https://app.umbrava.com/api/graphql`; `listClientProposals` with
  `PageInput!` / `SortInput!`. The Auth0 localStorage token is accessible only from the
  `app.umbrava.com` origin (not artifact iframes).
- `vendorNames[]` is the authoritative dispatch field; `assignedToMemberName` is the internal
  coordinator, not the vendor. MT 19378 = literal `"Broadway National Maintenance LLC"` in
  `vendorNames`.
- Umbrava's Add Note editor is TipTap/ProseMirror: insert formatted notes via a synthetic `paste`
  event carrying `text/html` paragraph blocks (a plain `textContent` set collapses newlines).

### Filesystem MCP / edit workflow
NOTE: the following is the proven pattern for the claude.ai Filesystem MCP. In Claude Code, use the
built-in Edit/Write tools + the bundled node `--check`; the anchor-uniqueness and byte-fidelity
lessons still apply.
- `edit_file`: <=3-4 edits per call; 5-6 edit batches time out (~4 min). A timed-out dryRun leaves
  the file untouched; a timed-out live edit = unknown state -> restart the MCP.
- Proven pattern: `copy_file_user_to_claude` -> Python `repr()` for exact bytes (unicode is stored
  inconsistently as glyphs or `\uXXXX`) -> `edit_file dryRun:true` -> inspect diff -> `dryRun:false`
  -> re-copy -> extract `<script>` via Python regex -> `node --check`.
- `edit_file` normalizes CRLF->LF; `newText` is a JS `.replace()` string: `$&`, `$'`, `` $` ``,
  `$1`-`$99`, `$<` are dangerous; `${}`, plain `$` in currency, and `$/` are safe.
- Anchor to exact text strings, never line numbers; verify anchor uniqueness with `grep -c`.
- Microsoft 365 `sharepoint_search` does not see Git working trees synced to OneDrive - use the
  Filesystem MCP (or local file tools) for repo access.

### SPA / injection
- Dashboard middle sections (`openJobModal`, `saveJobNote`, etc.) are unreachable via head/tail -
  edit with exact anchors.
- React SPA injection failure modes: stale click-handler bindings after re-renders, WO number
  format mismatches (`375038` vs `W-375038`), modals appended to detached DOM nodes.
- Umbrava column chooser: `[data-testid="show-column-chooser-button"]`; click the `<li>`, not the
  checkbox; column positions revert to Umbrava default after view switches (no server-side
  position preservation).

### Timeouts & routing
- No AbortController through the browser postMessage proxy; use `Promise.race()` with a setTimeout
  rejection. Blob writes are ETag-conditional with a re-read/merge retry on 412/409.
- Coordinator routing: index-based `coord-{index}` tied to `window._coordOrder`; never slug-based
  (hyphenated names break round-trip).

### Power Automate
- Classic designer for condition expressions; the new designer may prepend `@` on expression
  entry. Use the fx Expression tab for bare expressions; nested-branch dynamic content may be under
  "See more".

## Schema Defaults (WO Audit)
- Favor alias-based parsing wherever columns may drift.
- "Time in Status (hrs.)" preferred alias before "Status Hrs".
- "Location #" may split into Location and Brand.
- "Last Note Date" is the primary staleness signal; "Last Updated" may be blank. "Next Onsite
  Date" may exist; the workbook may contain 28 columns.

## Proposal Diagnostic Defaults (Pilot)
- Official target: flat 7-day proposal turnaround.
- Remove rows with Exclusion = "Exclusion" before analysis.
- Carve-outs tracked descriptively, not held to the 7-day target: WiFi (WI/WiFi/Wi-Fi prefixes),
  RF retrofits, Q/R jobs.
- 2026 schema: "Is Proposed" = "Proposed" indicates proposed; "Proposal Turnaround Days" is the
  default turnaround field.
- Frame reporting as a historical review of invoiced/completed jobs, not open-queue reporting.

## Primark Defaults
- Locked canonical schema from `Primark_WO_Audit_04_27_26.xlsx`; no FM, Store, Project Type, or
  Notes columns; the Client field distinguishes Primark vs PrimarkFM.
- Priority vocabulary P1-P4; 48-hour queue targets apply only to defined statuses.
- Defensive parsing for "# Days" and "Status (hrs.)" (browser/SheetJS string quirks).

## Reporting Language
- "average," not "mean"/"median" (unless statistical wording is requested).
- "jobs," not "WOs" or "KPIs," in business-facing language.
- "slowest 10%," not "P90". Concise, professional, VP-friendly.

## Validation & Workflow
- Scratch-copy edits with `assert`-guarded anchors -> `node --check` (bundled node) -> dryRun ->
  live apply -> re-copy and re-check. Extract inline `<script>` blocks before `node --check`.
- jsdom-based regression tests for snapshot and view rendering.
- For SWA HTML retheme/parse changes, prove ONLY the intended tokens changed with a normalized diff
  vs HEAD (mask the tokens; assert zero other differences), plus an em-dash scan (= 0).
- Commit via GitHub Desktop (SWA auto-redeploy); short commit messages.

## Response Style
- Concise, practical, plain language; smallest reliable fix first.
- Explain the likely root cause before proposing code; give exact replacement snippets.
- Flag downstream effects when changing parsing, routing, metrics, snapshots, or exports.
- Separate: confirmed current behavior / recommended next step / unresolved question.
- Ask one short clarifying question if genuinely ambiguous; act without asking on unambiguous
  tasks. Flag conflicts with established patterns (brand, architecture, scope) instead of executing
  blindly.

## Canonical Tool Inventory (extend, do not replace)
Some tools live outside this repo; verify presence before editing.
- **BWN Suite Tampermonkey userscripts** - Core + AI + Bid-Out + Vendor/WO Intake + Drop Upload
  (see the two-runtimes section for module detail; current versions are in each file's `@version`).
- **Broadway_Unified_Ops_Dashboard.html** - primary ops dashboard, blob-backed snapshots, Over-30
  Weekly Review with trend history, WO Case File modal integration in progress.
- **agent.html** - WO audit processor (Anthropic API + Umbrava MCP), streaming generation, blob
  storage via `/api/data-store`.
- **Pilot_Proposal_Diagnostic.html** - proposal turnaround analysis, lifecycle decomposition,
  cohort trends, GP join.
- **Broadway_Projects_Tracker.html** - project hub; nav hub with tools as iframes.
- **Pilot_Aging_Diagnostic.html** - drag-drop audit tool, 3 tabs (Triage/Diagnostic/Early
  Warning), thresholds in localStorage, prefix-based classification with manual override; snapshot
  parity requires a `setTimeout(0)` deferral in the boot IIFE.
- **Proposal_Pricing_Assistant.html** - pricing tool for Pilot proposals; Anthropic API; Umbrava
  search via direct GraphQL (same-origin Auth0 token) + MCP fallback.
- **Broadway_Incentive_Calculator.html** - quarterly bonus calc (SVC-015 SOP); percentile ranking
  with min-max toggle; SOP thresholds editable in Settings.
- **Broadway_Sign_Proof_Builder.html** - seven sign types with SVG drawings + fabrication refs.
- **Broadway_InHouse_Dispatch_Report.html** - MT bypass detection from WO CSV.
- **WO_Audit_Tool.html** - daily audit workbook refresh (ExcelJS).
- Also canonical: Coordinator Check-In Dashboard, 1:1 Meeting Agenda, PIP Roadmap & Manager
  Checklist, CrossAmerica Partners Vendor Coverage Matrix, Primark Unified Ops Agent + Dashboard,
  Inventory - Log Stock Movement (Power Automate flow).

## When given a task
Identify the runtime (Function / userscript / SWA HTML), apply that runtime's limits and the Hard
Rules above, verify any Umbrava-facing assumption, implement dependency-free, test via the bundled
node, adversarially review, then ship per the deploy split. Reusable scaffolds:
`docs/llm-prompt-template.md` (per-task), `docs/loop-engineering-prompt.md` (multi-iteration loop),
`docs/umbrava-match-spec.md` (typography), `docs/team-isolation-plan.md` (per-team data scoping).

## Active Work
- WO Case File integration into the Dashboard job-detail modal - full-audit / recent-update toggle
  wired into the existing WO Audit Note panel (not a separate injected section); history-slot
  architecture via `wo-next-actions`.
- BWN Suite Core "Set ECD..." popup failure on W-375038 - likely a WO number format mismatch
  (`375038` vs `W-375038`) in the click handler; diagnostics pending.
- Team isolation Phase A (per-team shared data): `api/hvac-benchmark` + roster built + staged;
  awaiting Mike's SWA push, the `ROSTER_ADMINS` app setting, and the team roster to seed.
- Flat-key blob migration (`pilot-revenue` -> `clients/pilot/revenue`): script exists; cutover
  documented across Agent (~7 sites), Dashboard (1 line), Diagnostic; pending execution.
- Phase 2 LLM schema inference via `/api/infer-schema` - scaffolded.
- Proposal Pricing Assistant -> Tampermonkey conversion: blocked (HTML not in repo, routes gated to
  `broadway_employee`, `api/generate` incompatible); needs an Azure Function proxy for the
  Anthropic key.
- In-House Dispatch Report production path: Power Automate scheduled daily MT audit (the
  Tampermonkey CSV export is interim).
- WO-intake -> Documents-upload "Label = Work Order Request" dropdown (WO-intake-initiated only):
  blocked on a stable live session to verify the upload dialog's Label control.
- Umbrava RBAC roles defined in the manifest JSON; an admin must create/assign them in the Entra
  portal (Mike lacks portal permissions).

## Open Questions
- Unified Ops Agent: Azure OpenAI vs Anthropic on Azure.
- Broader Azure SWA deployment decisions.
- Possible Umbrava live-data integration.
- Primark Dashboard HOT flag logic.
- Design system convergence (Tracker vs dashboard tools).
- Userscript panel font: system-stack (now applied) confirmed as final vs any Umbrava-native
  `getComputedStyle` override.
