#!/usr/bin/env bash
# PreToolUse hook for Edit|Write|MultiEdit: blocks writing real env files and obvious secrets.
# Exit 2 = block; stderr is shown to Claude.
set -u
INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
CONTENT="$(printf '%s' "$INPUT" | jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | map(.new_string) | join("\n"))] | map(select(. != null)) | join("\n")')"
BASE="$(basename "$FILE")"

case "$BASE" in
  .env.example|.env.sample|.env.template) ;;
  .env|.env.*)
    echo "Blocked: $BASE holds real secrets and must never be written by Claude or committed. Put placeholders in .env.example instead (CLAUDE.md › Security)." >&2
    exit 2 ;;
esac

if printf '%s' "$CONTENT" | grep -Eq -- '-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[bpa]-[A-Za-z0-9-]{10,}'; then
  echo "Blocked: content looks like a real credential (private key / cloud / API token). Use an env var and a placeholder in .env.example." >&2
  exit 2
fi
exit 0
