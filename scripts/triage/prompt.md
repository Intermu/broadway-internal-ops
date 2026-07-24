Run the daily broadway-internal-ops triage.

Activate the `triage` skill and follow its loop exactly:

1. Gather signals since the last run: recent commits (`git log --since`), the
   local green-gate baseline (preflight + the bundled-node test suites), any
   `gh` CI failures if authenticated, and the `CLAUDE.md` Active Work / Open
   Questions backlog.
2. Load `.triage/state.json` and dedupe against known findings by id.
3. Classify each signal with the finding rules (worth-doing / inbox / ignore).
4. For each worth-doing finding (up to the per-run cap of 3), fan out a draft
   sub-agent then an adversarial review sub-agent in an isolated worktree, and
   commit locally on `triage/<id>` ONLY when the review passes and the green
   gate is green baseline-aware.
5. Persist the state file and write the per-run log, including the baseline.
6. Spill everything unhandled to `.triage/inbox.md`.

Constraints (non-negotiable): never push, never merge, never force - commit
locally only; Mike pushes this SWA repo. Mutate nothing outside the worktree
except `.triage/`. Do not touch shared-core / userscripts / `.github/workflows`
/ `api` secrets - route those to inbox. No em-dash anywhere. If the working tree
is dirty, abort and write why to the inbox.

Green gate (bundled node must be on PATH):

    export PATH="/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs:$PATH"
    node scripts/preflight.js \
      && node scripts/test-bn-core.js \
      && node scripts/test-role-auth.js \
      && node scripts/test-data-store.js \
      && node scripts/test-ai-loop.js

When you finish, print a one-screen summary: signals gathered, findings new vs
known, fixes committed (with branches), items sent to inbox.
