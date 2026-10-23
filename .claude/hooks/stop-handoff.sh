#!/usr/bin/env bash
# Stop hook: if Claude edited project files this session but the session log is older than the
# last edit, block once and ask for a handoff so decisions/progress are persisted.
set -u
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
INPUT="$(cat)"
ACTIVE="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')"
SID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"
LOG="$ROOT/docs/context/SESSION_LOG.md"
EDITS="$ROOT/.claude/state/edits-$SID.tsv"

[ "$ACTIVE" = "true" ] && exit 0          # already reminded once; don't loop
[ -f "$EDITS" ] || exit 0

# Last edit to anything other than the context docs themselves.
LAST="$(grep -v '/docs/context/' "$EDITS" | cut -f1 | sort -n | tail -n 1)"
[ -z "$LAST" ] && exit 0
LOG_MTIME="$(stat -f %m "$LOG" 2>/dev/null || stat -c %Y "$LOG" 2>/dev/null || echo 0)"
[ "$LOG_MTIME" -ge "$LAST" ] && exit 0

COUNT="$(grep -v '/docs/context/' "$EDITS" | cut -f2 | sort -u | wc -l | tr -d ' ')"
jq -n --arg n "$COUNT" '{
  decision: "block",
  reason: ("You edited " + $n + " project file(s) since docs/context/SESSION_LOG.md was last updated. Before stopping: (1) record any decision made this session as an ADR (/adr) and resolve matching OPEN_QUESTIONS items, (2) update docs/context/STATE.md, (3) append a SESSION_LOG.md entry (same steps as /handoff). If the edits were trivial, append a one-line log entry and stop.")
}'
exit 0
