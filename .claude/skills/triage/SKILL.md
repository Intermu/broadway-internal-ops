---
name: triage
description: >
  Daily solo-dev triage for broadway-internal-ops. Run for the morning triage
  pass, or when asked to triage recent commits, red local tests/preflight, or
  the CLAUDE.md backlog. Reads the signals since the last run, dedupes against
  a gitignored state file, drafts fixes in isolated worktrees with an
  adversarial review pass, commits locally on green (never pushes - Mike
  pushes), and spills everything it cannot safely handle to an inbox. The
  state file is the spine: it remembers what was tried, what passed, and what
  is still open, so each run resumes where the last one stopped.
metadata:
  version: "1.0"
  author: broadway-internal-ops
---

# Triage skill (broadway-internal-ops, solo-dev variant)

A self-resuming morning loop. One run = gather -> load state -> triage ->
fan-out fix -> persist -> spill. Everything personal (state, inbox, runs) lives
under `.triage/`, which is gitignored. This skill file and the scripts are
committed; the data never leaves the machine.

This is a deliberately trimmed adaptation of the mcpvault `triage` skill. This
repo is solo (Mike), uses a commit -> push -> Azure-SWA-auto-redeploy model
(NOT pull requests), and has little or no external issue/PR traffic. So the
contributor-comment, maintainer-voice, autonomy-tier, promise-tracking, PR, and
npm-publish machinery is stripped. What is kept: the state-file resume spine,
the worktree draft -> adversarial-review -> green-gate-before-commit pattern,
and the gather -> triage -> spill-to-inbox loop.

## Preconditions

- `.triage/` exists. If missing, run `scripts/triage/bootstrap.sh` first; it
  scaffolds `state.json`, `inbox.md`, and `runs/`.
- Clean working tree on `main`. The loop only mutates `.triage/` on the base
  checkout; all code changes happen in worktrees.
- The bundled node is used for every check (no Node on PATH). Prepend its dir
  so `node` resolves for both the gate and preflight's internal `node --check`:
  `export PATH="/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs:$PATH"`

## The green gate (this repo's checks)

There is no `npm test` / `npm run build` here (vanilla JS, no build step). The
gate is preflight plus the bundled-node test suites, all run with the bundled
node on PATH:

```
export PATH="/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs:$PATH"
node scripts/preflight.js \
  && node scripts/test-bn-core.js \
  && node scripts/test-role-auth.js \
  && node scripts/test-data-store.js \
  && node scripts/test-ai-loop.js
```

The gate is **baseline-aware**, not "everything green". At loop start, run each
part once and record pass/fail as the run's baseline. A fix is acceptable only
if: preflight passes, every suite green at baseline stays green (no new
regression), and if the fix targets a suite that was red at baseline, that
suite flips to green. A pre-existing red suite never blocks an unrelated fix,
and no fix may introduce a new red. (At time of writing `test-bn-core.js` is
red; the other three suites and preflight are green.)

## The loop

### 1. Gather (read-only)

Window = `state.json.last_run` (fall back to 24h). Collect, in priority order:

```
# recent commits (the primary local signal)
git log --since="$SINCE" --pretty='%h %s %an'

# local green-gate baseline (the primary FAILURE signal in this repo)
# run the gate above; record which suites pass/fail

# CI failures via gh, if authenticated (see note)
gh run list --status failure --created ">=$SINCE" --json databaseId,name,headSha,conclusion,url
```

Note: today the GitHub Actions workflow only runs the SWA deploy action, so
`gh run list` failures are deploy failures, not test failures. Until the CI
test-gate prerequisite lands, the **local green gate is the real failure
signal**; treat `gh` CI output as advisory and skip it if `gh` is absent.

Also read the two backlog sections in `CLAUDE.md` (`## Active Work`,
`## Open Questions`). They are the solo-dev analog of "open issues": a curated
list of known work. Surface items that match the worth-doing bar; leave the
rest as `backlog` findings for the human.

### 2. Load state

Read `.triage/state.json`. Build a map of known findings by `id`. The `id` is
`<source>:<signature>` (see `resources/state-schema.md`), stable across runs so
the same red test or backlog item always maps to the same finding.

### 3. Triage

For each signal compute its `id` and classify with `resources/finding-rules.md`:

- **known + terminal** (`committed`, `resolved`, `wont_fix`) -> skip, bump `last_seen`.
- **known + open** under the attempt cap -> retry.
- **new + worth-doing** -> append as `status: open`, proceed to fan-out.
- **new + needs judgment / ambiguous / out of scope** -> inbox, `needs_human`.
- **noise** (already-tracked flake, bot commits) -> ignore, log only.

Before triaging, reconcile resolution (see state-schema `Detecting resolution`):
a `committed` finding whose triage branch has landed on `main` -> `resolved`; a
red-test finding now green and absent -> `resolved` "passed on its own".

### 4. Fan-out (bounded)

Findings with no blocker proceed to a new fix, up to the per-run cap in
`finding-rules.md` (3), ranked by priority. For each, spawn TWO sub-agents via
the **Agent tool with `isolation: "worktree"`** (auto-created, auto-cleaned, so
parallel fixes cannot collide). Manual fallback: `git worktree add
../broadway-internal-ops-triage-<id> -b triage/<id>` then remove after.

- **Draft agent**: given the finding + failing output/backlog item, write the
  smallest fix. Must read the relevant source first, match existing style
  (vanilla JS, no deps; ES5-safe for userscripts, CommonJS for Functions), obey
  the CLAUDE.md Hard Rules (no em-dash, `https` not `fetch`, shared-core stays
  byte-identical + version-bumped in BOTH files), and add or update a test that
  proves the fix against the real code path.
- **Review agent**, adversarial: check the draft against the Hard Rules and
  existing tests, then run the green gate in the worktree. Verdict is PASS only
  if the fix is correct, minimal, tested, and the gate is green baseline-aware.

Outcome:

- **PASS + gate green** -> commit locally on the `triage/<id>` branch (one
  focused commit, message per CLAUDE.md style, no em-dash). Set
  `status: committed`, record the branch. **Never push, never merge, never
  --force** (Hard Rule 8: Mike pushes the SWA repo). Then list it under
  `## Ready to push` in the inbox.
- **anything else** (reviewer fails, gate red, fix unclear, > 2 files of scope,
  or the fix would touch shared-core / userscripts / `.github/workflows/` /
  secrets) -> write the draft + reason to `inbox.md`, set `status: needs_human`.
  Keep the branch only if the draft is worth resuming.

### 5. Persist (the spine)

Update `.triage/state.json`: set `last_run` to now, append an `attempts` entry
per touched finding (run date, result, note, branch), update `status`,
`last_seen`, `branch`. Write the per-run log to `.triage/runs/<date>.md`
including the baseline pass/fail set.

`state.json` is the resume point. Never overwrite history, append to `attempts`.
If the file is malformed, stop: copy it to `state.json.corrupt-<date>` and spill
the whole run to inbox rather than risk losing the spine.

### 6. Spill

Anything the loop could not classify, fix, or safely commit goes to `inbox.md`
with enough context to act on cold. The inbox is the only thing the human must
read each morning. Sections:

- `## Ready to push` - green, locally committed fixes awaiting Mike's review +
  push. Each: finding id, branch, one-line what/why, what the reviewer verified.
- `## Needs decision` - findings parked for a human call. Each: finding id,
  source, what was tried, why it is here, smallest next action.

## Guardrails

- **Never push, never merge, never `--force`.** Commit locally only; Mike pushes
  this SWA repo (Hard Rule 8). No auto-merge.
- Never touch files outside the worktree except `.triage/`.
- Never edit `.github/workflows/*` or anything under `api/` app-settings /
  secrets from the loop; route those to inbox.
- Shared-core (`BWN SHARED CORE`) and userscript fixes live in a different repo
  (`Intermu/userscripts`) - out of this loop's local scope; route to inbox.
- No em-dash (U+2014) anywhere in code, comments, commits, or docs; hyphen only.
- Respect the caps in `finding-rules.md`; spill the overflow rather than run long.
- If the working tree is dirty, abort and write why to `inbox.md`.

## Resources

- `resources/state-schema.md` - state.json shape, id derivation, transitions.
- `resources/finding-rules.md` - worth-doing vs inbox vs ignore, caps.
