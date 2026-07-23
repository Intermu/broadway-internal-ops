# Finding rules

How to classify a gathered signal: **worth-doing**, **inbox**, or **ignore**.
When a signal could fit two buckets, pick the more conservative one (inbox over
worth-doing, ignore over inbox).

## Caps

- **Per-run fix cap: 3.** At most 3 findings go through fan-out per run. Rank by
  priority (below); spill the rest to inbox as `open` so the next run picks them
  up. Log what was deferred, never silently drop.
- **Attempt cap: 2.** A finding the loop has already failed to fix twice stops
  auto-retrying and stays `needs_human`. Mike reopens it manually.
- **Scope cap: 2 files.** If the draft touches more than 2 source files, it is
  too big for the loop; send to inbox regardless of the reviewer verdict.

## Worth-doing (fan-out a fix)

A signal is worth-doing only if ALL hold:

- The fix is **bounded and mechanical-ish**: a failing test with an obvious
  cause, a regression a recent commit introduced, a small correctness bug, a
  typo, a clear off-by-one, a missing guard already implied by neighboring code.
- The **expected change fits the scope cap** (<= 2 files) and adds or updates a
  test against the real code path.
- There is a **clear pass/fail signal**: a suite that should flip green, or
  preflight that should pass.
- It is **not** a feature, an interface change, a schema/parsing change with
  downstream effects, or anything needing a product/design decision.

Priority order when over the per-run cap:

1. A suite that is red at baseline and has an obvious deterministic cause
   (the local gate is red - fix first).
2. Regressions a recent commit introduced.
3. Small, reproducible bugs surfaced by the gate or a `backlog` item.

## Inbox (needs_human)

Send to inbox, do not attempt a fix, when ANY holds:

- The cause is unclear or not reproducible from the signal alone.
- The fix needs a judgment call: behavior change, interface/route change,
  parsing/metric/snapshot/export change with downstream effects, a security
  decision, or anything the CLAUDE.md Hard Rules flag.
- It is a feature or enhancement, not a bug (most `backlog` items land here).
- It would exceed the scope cap, or the draft did and the reviewer flagged it.
- The reviewer failed the draft twice (attempt cap hit).
- The change touches anything **out of the loop's local scope**: shared-core /
  userscripts (`Intermu/userscripts`, a different repo), `.github/workflows/*`,
  `api/` secrets or app settings, or W-9 / TIN / financial data.

Each inbox entry records: the finding id, source, what was tried (if anything),
the reason it landed here, and the smallest next action.

## Ignore (log only)

Do not act, do not inbox, just note in the run log:

- Findings in a terminal state (`committed`, `resolved`, `wont_fix`) - bump
  `last_seen` only.
- Flaky tests already tracked as a known finding.
- Bot/automation commits and noise.

## Repo-specific notes

This suite is dependency-free vanilla JS across three runtimes (Azure Functions,
Tampermonkey userscripts, single-file HTML tools). Highest-value, lowest-risk
findings:

- A red `scripts/test-*.js` suite with a deterministic cause (harness or a real
  regression in an inlined `BN-CORE` / `api/` code path).
- A preflight hard failure: inline `<script>` syntax error, `staticwebapp.config.json`
  route-order regression, or unbalanced `BN-THEME` / `BN-CORE` sentinels.

Treat anything about routing, auth/role enforcement, the shared-core block, or a
parsing/schema contract as inbox by default - those carry blast radius beyond a
test, and this repo auto-deploys to production on Mike's push.
