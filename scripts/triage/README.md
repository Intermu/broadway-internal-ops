# Triage automation (solo-dev variant)

A self-resuming morning loop that triages recent commits, red local
tests/preflight, and the CLAUDE.md backlog, drafts fixes in isolated worktrees
with an adversarial review pass, commits them locally on green, and spills
everything it cannot safely handle to an inbox.

This is a trimmed adaptation of the mcpvault `triage` skill. This repo is solo
(Mike), uses commit -> push -> Azure-SWA-auto-redeploy (not pull requests), and
has little external issue/PR traffic, so the contributor-comment, voice,
autonomy-tier, promise-tracking, PR, and npm-publish machinery is stripped. What
transfers: the state-file resume spine, the worktree draft ->
adversarial-review -> green-gate-before-commit pattern, and the gather -> triage
-> spill loop.

## Parts

```
.claude/skills/triage/SKILL.md            the loop the agent follows
.claude/skills/triage/resources/          state schema, finding rules
scripts/triage/bootstrap.sh               scaffolds .triage/ (idempotent)
scripts/triage/prompt.md                  the morning prompt
.triage/state.json                        the spine: what was tried/passed/open
.triage/inbox.md                          human queue (Ready to push / Needs decision)
.triage/runs/<date>.md                    per-run audit log
```

`.triage/` is gitignored and lives only on this machine. The skill file and
these scripts are committed.

## Green gate (this repo's checks)

There is no `npm test` / `npm run build` (vanilla JS, no build step). The gate is
preflight plus the bundled-node test suites. The bundled node must be on PATH so
`node` resolves for both the gate and preflight's internal `node --check`:

```bash
export PATH="/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs:$PATH"
node scripts/preflight.js \
  && node scripts/test-bn-core.js \
  && node scripts/test-role-auth.js \
  && node scripts/test-data-store.js \
  && node scripts/test-ai-loop.js
```

The gate is baseline-aware (no NEW regressions), not "everything green", because
a suite may already be red. See SKILL.md.

## Run it

```bash
bash scripts/triage/bootstrap.sh   # scaffold .triage/ (first run only)
```

Then invoke the skill interactively in Claude Code (`/triage`, or ask to "run
the daily triage"). `scripts/triage/prompt.md` is the same instruction for an
optional scheduled run via Claude Code's `/loop` or the `schedule` skill
(CronCreate). There is intentionally no headless `run.sh`: this repo is
Mike-driven and the loop never pushes, so scheduling is optional.

## Deploy protocol

The loop commits locally on a `triage/<id>` branch and stops. It never pushes,
merges, or force-pushes - Mike reviews the branch and pushes this SWA repo
himself (a push auto-deploys to production). Committed fixes are listed under
`## Ready to push` in the inbox.
