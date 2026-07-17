# Broadway National Ops Suite - System Brief

Standing context for anyone (human or AI) working on this codebase. Read this first; apply
the Hard Rules to every task. House style forbids the em-dash character (U+2014) - this file
uses hyphens only, and so must everything you write.

## Role

Maintain Broadway National's internal operations tooling in **dependency-free vanilla
JavaScript**: Node.js (CommonJS) for Azure Functions, ES5-safe browser JS for Tampermonkey
userscripts, and single-file HTML + inline JS for the web tools. No framework, no build step,
no bundler, no transpiler.

## What this is

An internal suite for Broadway National (a facilities-services aggregator) used by ops
coordinators, supervisors, and managers. Two runtimes that interoperate:

### 1. Tampermonkey userscripts (injected into Umbrava, `app.umbrava.com`)

Umbrava is a third-party React/MUI SPA. Source lives in `OneDrive\Tampermonkey Scripts\userscripts`
(NOT this repo) and auto-updates from raw GitHub (`Intermu/userscripts`) via `@updateURL` /
`@downloadURL` plus a bumped `@version`.

- **Core** (`bwn-suite-core`, zero network egress): WO Assist, PO Approval, List Heat, Launcher.
- **AI** (`bwn-suite-ai`): Anthropic drafts (Client Update / WO Audit), Google Places (Find
  Techs / Find Suppliers), Job View, and the **SWA connector**.
- **Bid-Out** (`bwn-bid-out`): RFP emailer built on Umbrava's "See Who Is Available"; ZoomInfo
  enrichment; the shared vendor-prospect pipeline.
- **Vendor Intake / WO Intake / Drop Upload**: prefill Umbrava modals from documents (W-9 /
  client PO `.msg` / dropped files).
- Core + AI carry a **byte-identical "BWN SHARED CORE" block** (only the
  `announceCore('core'|'ai')` line differs). Cross-script comms use a document-event bus
  (`bwn:cmd` / `bwn:evt`).

### 2. Azure Static Web App (`green-stone-0717dab0f.7.azurestaticapps.net`, this repo)

AAD-gated front-end HTML tools + managed Node Functions under `api/` + Azure Blob storage.

- **Front-end** (single-file HTML, inline JS, CSS-variable theme):
  `Broadway_Projects_Tracker.html` (native views Board / List / Timeline / Reports /
  **Prospects**, plus Agent / Dashboard / Diagnostic / Check-In as iframes), `agent.html`,
  `Broadway_Unified_Ops_Dashboard.html`, `Pilot_Proposal_Diagnostic.html`,
  `Broadway_Coordinator_CheckIn.html`, `wo_case_file.html`, `index.html`. Clean routes
  (`/board`, `/list`, `/prospects`, ...) rewrite to the tracker via `staticwebapp.config.json`.
- **Functions** (`api/`): `wo-ingest`, `scrape-contacts`, `enrich-contacts` (ZoomInfo),
  `vendor-prospects`, `send-bid`, `track-open`, `bid-status`, `get-roles`, `data-store`,
  `activity-log`, `user-role`. They use the **`https`** module + `crypto` + `@azure/storage-blob`.
- **AAD roles**: `broadway_employee` (base) plus the ops ladder `ops_coordinator ->
  lead_ops_coordinator -> ops_supervisor -> ops_manager -> dir_ops -> vp_ops` (`get-roles`).

## How the two connect

The AI userscript's connector POSTs to the SWA over `GM_xmlhttpRequest` (the one declared
`@connect` host), authenticated by the shared key header `x-bwn-key` (== app setting
`WO_INGEST_KEY`), queued and eventually-consistent. Per-user auth: the userscript sends the
Umbrava Auth0 access token and the SWA verifies it against Umbrava's JWKS (RS256) to resolve
the caller's Umbrava role (`api/user-role`).

## Key external systems

- **Umbrava**: Auth0 (`iss https://login.umbrava.com/`; `aud` is an ARRAY that includes
  `https://app.umbrava.com/api`; email in the namespaced claim `https://umbrava.com/email`;
  tenant in `https://umbrava.com/tenantid`; RS256). GraphQL at `/api/graphql`. Free-text member
  roles (e.g. "National Account Manager", "Operations Coordinator"). A typed Umbrava read-API
  MCP is connected on the Claude side - use it to VERIFY selector / field shapes.
- **Anthropic** (drafts), **Google Places** (vendor leads), **ZoomInfo** (contact enrichment -
  shared credit pool), **Microsoft Graph** (bid sending, mostly deferred).

## Environment limits (always assume)

- The SWA-managed Node runtime does NOT reliably expose global `fetch()` -> Functions use the
  **`https`** module.
- Userscripts run inside a third-party SPA: **ES5-safe**, egress only via `GM_xmlhttpRequest`
  to `@connect` hosts, secrets only in `GM` storage (never the page), must not break the host,
  and **Umbrava tabs are throttled / suspended when backgrounded** (async callbacks may never
  fire).
- No Node on the dev PATH: syntax-check and run tests via the Adobe-bundled node:
  `"/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe"`. HTML files cannot
  be `--check`ed; extract functions to test in isolation.

## Hard rules (non-negotiable)

1. **Never use an em-dash (U+2014)** anywhere in code, comments, or UI - use a hyphen `-`.
2. **Functions use `https`, never global `fetch`;** no JWT / JWKS / HTTP libraries - use
   `crypto` / `https`.
3. **Shared-core edits stay byte-identical** across Core + AI (only `announceCore` differs) and
   **bump the version**.
4. **Secrets / tokens / API keys** live only in SWA app settings or `GM` storage - never
   logged, cached, echoed, or sent anywhere but the one declared host. **W-9 / TIN / EIN data
   stays 100% local.**
5. **Bid-Out never auto-sends:** review-before-send, vendors BCC'd, city / state only (no
   client name or street address), CAN-SPAM + unsubscribe.
6. **Do not guess** Umbrava DOM selectors or GraphQL fields - verify live (MCP / an isolated
   probe) or ask.
7. **Adversarially review before shipping** non-trivial changes; write tests against the real
   code path (stub `https`, not `fetch`).
8. **Deploy split:** push userscripts to `Intermu/userscripts` yourself; **the user pushes this
   SWA repo** (`broadway-internal-ops`) - stage and hand off, do not push it.
9. **Design + copy:** brand green `#1a5f3e` / accent `#2ECC71` (no navy); system / DM Sans +
   DM Mono; the "b" app-icon favicon; grounded operational voice - no marketing or AI-cliche
   phrasing, lead with what a thing does and state its limits.

## When given a task

Identify the runtime (Function / userscript / SWA HTML), apply that runtime's limits and the
Hard Rules above, verify any Umbrava-facing assumption, implement dependency-free, test via the
bundled node, review, then ship per the deploy split. A reusable per-task prompt scaffold lives
in `docs/llm-prompt-template.md`.
