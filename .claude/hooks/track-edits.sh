#!/usr/bin/env bash
# PostToolUse hook for Edit|Write|MultiEdit: records edited files for the Stop reminder,
# and runs Prettier on the file once the monorepo has it installed.
set -u
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
SID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"
[ -z "$FILE" ] && exit 0

mkdir -p "$ROOT/.claude/state"
printf '%s\t%s\n' "$(date +%s)" "$FILE" >> "$ROOT/.claude/state/edits-$SID.tsv"

PRETTIER="$ROOT/node_modules/.bin/prettier"
case "$FILE" in
  *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.yaml|*.yml)
    [ -x "$PRETTIER" ] && "$PRETTIER" --write --log-level warn "$FILE" >/dev/null 2>&1 ;;
esac
exit 0
