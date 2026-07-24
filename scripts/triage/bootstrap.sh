#!/usr/bin/env bash
# Scaffold the gitignored .triage/ data dir for the triage skill.
# Idempotent: safe to re-run. Seeds state.json, inbox.md, and runs/.
# No maintainer-voice profile here - this solo-dev variant posts no comments.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRIAGE_DIR="$REPO_ROOT/.triage"

mkdir -p "$TRIAGE_DIR/runs"

if [[ ! -f "$TRIAGE_DIR/state.json" ]]; then
  cat > "$TRIAGE_DIR/state.json" <<'JSON'
{
  "version": 1,
  "last_run": null,
  "findings": {}
}
JSON
  echo "created .triage/state.json"
fi

if [[ ! -f "$TRIAGE_DIR/inbox.md" ]]; then
  cat > "$TRIAGE_DIR/inbox.md" <<'MD'
# Triage inbox

Everything the morning loop could not commit on its own. Read this first.

## Ready to push

_Green, locally committed fixes awaiting review + push (Mike pushes; the loop never does). Each: finding id, branch, one-line what/why, what the reviewer verified._

## Needs decision

_Findings parked for a human call. Each: finding id, source, what was tried, why it is here, smallest next action._
MD
  echo "created .triage/inbox.md"
fi

echo "bootstrap complete: $TRIAGE_DIR"
