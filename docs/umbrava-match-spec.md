# Umbrava-Match Spec (typography + interaction)

The single source of truth for making every BWN surface - the SWA HTML tools + the Tampermonkey
userscripts - match Umbrava (`app.umbrava.com`) in EVERYTHING BUT COLOR. Colors stay on the
existing BWN green tokens (see [[bwn-design-system]]); this doc governs font, size, weight, case,
geometry, and interaction/structure.

Directive (user, 2026-07-17): "everything but the color to match Umbrava" - match EXACTLY,
including the parts that reverse the earlier flat-weight spec. And "logic" = interaction/structure
parity, not just styling. House rule: no em-dash (U+2014), hyphens only.

All numbers below were MEASURED LIVE from Umbrava (React/MUI SPA) via computed styles on the home
page + a work-order detail page (2026-07-17). Re-verify a component live before matching it if in
doubt - do not guess (Hard Rule 6).

---

## 1. Typography (VERIFIED - the exact scale)

Umbrava's own UI renders the SYSTEM STACK (MUI's Roboto is loaded but overridden). Use this
family everywhere, quoted for JS string safety:

```
-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif
```

| Role (what it is) | size | weight | line-height | transform | MUI variant |
|---|---|---|---|---|---|
| Body / paragraph / default | 16px | 400 | 24px (1.5) | none | body1 / subtitle1 |
| Dense text, secondary rows | 14px | 400 | ~20px | none | body2 |
| Buttons, tabs | 14px | 500 | (button) | **none** | Button / Tab |
| Section title, DIALOG/MODAL title | 20px | 500 | 32px | none | h6 |
| Emphasis label (field label emphasis) | 14px | 600 | ~19px | none | subtitle2 |
| Chips / small tags | 12px | 600 | normal | none | Chip label |
| Page title | 18-48px | 600 | ~1.0-1.3 | none | page h1/h2 |
| Input text | 14px | 400 | ~1.4 | none | InputBase |
| Field label (at rest) | 16px | 400 | 16px | none | InputLabel (shrinks to 12 when floated) |

Weight rules: **400 body, 500 buttons/tabs/section-titles, 600 chips/emphasis-labels/page-titles.**
Case rule: **text-transform:none EVERYWHERE.** Umbrava uses no uppercase eyebrows/table-headers -
this REVERSES the earlier BWN "keep uppercase on headers/chips" decision. Remove all
`text-transform:uppercase` on suite UI (and the letter-spacing that rode with it).
Mono: Umbrava effectively has no mono UI (RobotoMono not loaded). The suite may KEEP its mono for
dense data (dashboard numbers) using `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` -
this is a suite-only concern, not an Umbrava match point.

## 2. Geometry + structure (VERIFIED primitives)

| Primitive | Umbrava |
|---|---|
| Border-radius vocabulary | **4px** controls/inputs/buttons (dominant) · **8px** cards/panels · **50%** circular · 16px pill/chip |
| Button geometry | 14/500/none, horizontal padding ~16px, radius 4px |
| Input (outlined) | radius 4px, 14px text |
| Card / Paper / Dialog elevation | soft low shadow, geometry `0 1px 10px` (shadow COLOR is Umbrava's slate; keep BWN's own shadow color) |
| Dialog/modal | MUI Dialog: title = h6 (20/500/32lh); content padded; actions row right-aligned, small gap, secondary+primary at bottom-right |

## 3. Mapping rules (how to translate current suite CSS -> Umbrava)

- Any `'DM Sans'` / `'DM Mono'` / `Roboto` / `Arial`-first / `'Segoe UI'`-first / bare
  `system-ui` / `var(--sans)` font-family -> the full system stack above. (DM is not loaded, so it
  currently falls back to Windows Arial, NOT Umbrava's Segoe UI - a real visible mismatch.)
- Weights 700/800/`bold` -> map by ROLE: page title/emphasis/chip -> 600; everything else -> 500;
  body copy -> 400. Never keep 700/800 (Umbrava's only 700s are a third-party embed, not its UI).
- `text-transform:uppercase` on suite UI -> `none` (drop the paired letter-spacing too).
- Section/dialog titles -> 20/500/32lh. Chips -> 12/600. Field emphasis labels -> 14/600.
  Buttons/tabs -> 14/500/none. Body -> 16/400. Dense rows -> 14/400.
- Control/input/button radius -> 4px; cards/panels -> 8px. (Do not chase color/shadow color.)

## 4. Interaction / structure parity ("logic") - per-component checklist

Verify each against Umbrava live before matching (Hard Rule 6). For every suite modal/tool:
- Dialog: header with title (h6) + a close affordance; padded content; a right-aligned action
  row with secondary (text/outlined) then primary (contained) button. Close on Esc + backdrop
  click + the X. Focus moves INTO the dialog on open and RETURNS to the trigger on close; focus is
  trapped while open (the suite already has bwnA11yDialog in the userscripts - reuse it).
- Buttons: primary = contained; secondary = text/outlined; destructive = its own treatment; all
  14/500/none, radius 4px. Consistent label casing (sentence case, not UPPER).
- Fields: label + input pattern consistent; radius 4px; helper/error text placement consistent.
- Spacing: consistent padding scale on panels/rows (Umbrava leans on an 8px rhythm).
- Tables/lists: header row weight/size consistent (Umbrava headers are NOT uppercase).
NOTE: match PATTERN + geometry, not Umbrava's exact colors or its MUI class names.

## 5. Per-surface state + execution order

Measured 2026-07-17. Group A already uses the system stack (needs weight/case correction only);
Group B still uses DM/Arial + 700/800 (needs the full pass).

| Surface | Runtime | Family | 700/800 | uppercase | Work |
|---|---|---|---|---|---|
| Broadway_Unified_Ops_Dashboard.html | SWA | system OK | ~0 | 25 | restore role 600 + drop uppercase |
| bwn-suite-core.user.js | userscript | system OK | 0 | 9 | role 600 + drop uppercase (SHARED CORE - mirror in AI) |
| bwn-suite-ai.user.js | userscript | system OK | 8 | 16 | role 600 + drop uppercase (SHARED CORE - mirror in Core) |
| bwn-bid-out.user.js | userscript | system OK | 0 | 0 | light: confirm role 600 on chips/titles |
| bwn-drop-upload / vendor-intake / wo-intake | userscript | system OK | 0 | 0 | minimal own UI - spot-fix only |
| Broadway_Projects_Tracker.html | SWA | **DM/Arial** | **125** | 53 | FULL pass (DM->system, 700/800->role, drop uppercase) |
| agent.html | SWA | **Arial/DM/Segoe-first** | 74 | 6 | FULL pass |
| Pilot_Proposal_Diagnostic.html | SWA | **DM** | 22 | 7 | FULL pass |
| Broadway_Coordinator_CheckIn.html | SWA | **var(--sans)=DM-first** | 11 | 7 | fix --sans/--mono token defs -> system, role 600, drop uppercase |
| wo_case_file.html | SWA | **DM** | 13 | 4 | FULL pass (smallest - good template) |

Recommended order: (1) wo_case_file.html as the proven template for the DM->system pass; then
(2) CheckIn (token-def fix is high-leverage); (3) Pilot; (4) agent.html; (5) Projects_Tracker
(biggest/riskiest last). In parallel track: (6) Dashboard weight/case; (7) Core+AI shared-core
weight/case (byte-identical, bump both); (8) Bid-Out + the 3 small intake scripts.

### Progress (2026-07-17)
- DONE + STAGED (SWA push): wo_case_file.html (template) + all 4 Group-B files
  (Broadway_Coordinator_CheckIn, Pilot_Proposal_Diagnostic, agent, Broadway_Projects_Tracker).
  Group B done via a per-file workflow (retheme + independent verify) + a final orchestrator
  gate: normalized-diff proved ONLY typography + font-loading changed (0 other diffs), leftover
  scan 0 (DM/700/800/uppercase/gfonts), em-dash 0, every inline <script> passes node --check.
- FONT-LOADING DECISION: these 5 pages LOADED DM via Google Fonts <link> (unlike the userscripts),
  so the pass also removed the DM <link>/preconnect AND stripped the now-dead fonts.googleapis
  (style-src) / fonts.gstatic (font-src) tokens from the CSP <meta>. Accepted as correct hygiene
  (verified the CSP change is ONLY those two font hosts; all other directives byte-identical).
- GROUP A (2026-07-17):
  - Dashboard: DONE + STAGED. 25 uppercase->none (+ paired letter-spacing reset), 34 selectors
    weight 500->600 (chips/badges/pills/tags/titles/emphasis; buttons/tabs kept 500; sizes/colors
    /logic unchanged). Verified 0 non-typography diff + inline scripts --check + em-dash 0. Two
    borderline fixes applied by hand: .em-kind-btn (a button) reverted 600->500; .pri2 (a priority
    pill) bumped 500->600 for parity with .pri-pill.
  - Core v1.53.0 + AI v1.36.0: PUSHED. Dropped uppercase (9 Core, 16 AI) -> none + paired
    letter-spacing reset. ALL in per-script modules (0 in the shared block), so the byte-identical
    BWN SHARED CORE block is untouched (still 1 diff = announceCore; VERSION guard stays 7).
    0 non-typography diff both files.
  - Bid-Out + drop-upload + vendor-intake + wo-intake: already compliant (0 uppercase, 0 heavy
    weights, system stack) - no case pass needed.
- Core v1.54.0 + AI v1.37.0: PUSHED. Weight 500->600 restored on chips/tags/pills/badges/emphasis/
  section-titles (Core 12, AI 18 selectors) - all in per-script modules; shared block still
  byte-identical (cross-file diff = 1 = announceCore; VERSION guard 7). 0 non-weight diff both.
  Buttons/tabs/captions/subtitles + the 20/500/32 h6-role titles correctly LEFT at 500.
- Bid-Out v0.21.1: PUSHED. .bwn-bo-chip 500->600 (chip); .bwn-bo-hd left 500 (it is the 20/32 modal
  title = Umbrava h6 role = 500). drop-upload/vendor-intake/wo-intake had no chip-at-500 to bump.

TYPOGRAPHY MATCH COMPLETE across all surfaces (font-family + case + weight). REMAINING:
- Part-2 interaction/structure parity (dialog header/footer patterns, focus/keyboard, eyebrow->h6
  structure) - the checklist in section 4; needs live inspection of Umbrava's dialogs.
- (Separate ask) WO-intake -> Documents-upload "Label = Work Order Request" dropdown - BLOCKED on a
  stable live session: the upload dialog's Label control renders only per-staged-file and the live
  Umbrava renderer timed out on that heavy dialog in two sessions; wiring it needs the Label
  control (autocomplete vs select) + its "Work Order Request" option verified live (Hard Rule 6).
  Plan recorded in [[bwn-note-composer-format]].

## 6. Verification protocol (every surface, before shipping)

1. `"/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" --check <file>` for
   every .js touched; for HTML, extract each inline `<script>` and --check it in isolation.
2. Normalized diff: mask all typography tokens (font-family/size/weight/transform/letter-spacing)
   and diff vs HEAD -> assert ZERO non-typography differences (proves logic/color/layout intact).
   This is the same guard that verified the Dashboard retheme.
3. Em-dash scan must be 0: search each touched file for the U+2014 codepoint and confirm there are none.
4. Live spot-check: for interaction changes, drive the actual modal/tool and confirm behavior.
5. Deploy split: userscripts committed+pushed to Intermu/userscripts (bump @version + VER;
   shared-core mirrored byte-identical + both bumped); SWA files STAGED only (user pushes).
