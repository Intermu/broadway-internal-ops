# State schema

`.triage/state.json` is the spine: the single source of truth for what the loop
has seen, tried, and resolved. It is gitignored and lives only on this machine.

## Shape

```json
{
  "version": 1,
  "last_run": "2026-07-23T07:00:00Z",
  "findings": {
    "<id>": {
      "source": "test | ci | commit | backlog",
      "signature": "stable identity string (see below)",
      "title": "human-readable summary",
      "status": "open | in_progress | committed | needs_human | resolved | wont_fix",
      "first_seen": "ISO-8601",
      "last_seen": "ISO-8601",
      "branch": "triage/<id> or null",
      "attempts": [
        {
          "run": "2026-07-23",
          "result": "committed | needs_human | retry | resolved | error",
          "note": "what happened, why",
          "branch": "triage/<id> or null"
        }
      ]
    }
  }
}
```

## id derivation

`id = "<source>:<signature>"` (lowercased, spaces -> `-`). The `signature` is the
most invariant identity for each source, so the same problem maps to the same
finding every run:

- **test**: the suite file + a stable slug of the failing assertion, NOT the run
  time. `test:test-bn-core-division-empty`. A whole-suite failure collapses to
  `test:test-bn-core`.
- **ci**: the workflow/job name (thin until the CI test-gate lands).
- **commit**: only tracked when a commit introduces a regression; the signature
  is the regression it caused, not the sha, so a later revert collapses to the
  same finding.
- **backlog**: a stable slug of the `CLAUDE.md` Active Work / Open Questions
  item, e.g. `backlog:ecd-popup-wo-number-format`.

Same signature -> same id -> dedupe works. That is how tomorrow resumes today.

## Status transitions

```
  new worth-doing ─────────────► open
                                   │  fan-out
                                   ▼
                             in_progress
                ┌──────────────────┼──────────────────┐
         PASS + green gate     reviewer fail        unclear / over cap
                │                  │                    │
                ▼                  ▼                    ▼
            committed          needs_human          needs_human
                │
    triage branch lands on main (next run detects it)
                ▼
            resolved

  human decision, any state ───► wont_fix  (terminal, never reopened)
```

Terminal states (`committed`, `resolved`, `wont_fix`) are skipped on later runs;
only `last_seen` is bumped. `open` and `needs_human` are eligible for retry until
the attempt cap in `finding-rules.md`. `committed` means a green fix is committed
locally awaiting Mike's push - the loop never advances it to `resolved` itself.

## Detecting resolution

On gather, before triaging, reconcile:

- A `committed` finding whose `triage/<id>` branch has landed on `main` (its
  commits are now reachable from `main`, or the branch is gone) -> `resolved`.
- A `test`/`ci` finding whose suite is now green and absent from the current
  baseline failures -> `resolved`, note "passed on its own".

## Invariants

- Never delete a finding. History is the point.
- Never rewrite an `attempts` entry. Append only.
- `last_run` advances only after a successful persist. If the run aborts, the
  next run re-reads the same window - safe, because triage is idempotent on `id`.
- If `state.json` fails to parse, do NOT recreate it. Stop, copy it to
  `state.json.corrupt-<date>`, and spill the whole run to inbox. Losing the spine
  is the one unrecoverable failure.
