#!/usr/bin/env bash
# SessionStart hook (startup | resume | clear | compact).
# Prints the shared project context; stdout is injected into Claude's context.
set -u
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
CTX="$ROOT/docs/context"
INPUT="$(cat 2>/dev/null || true)"
SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo startup)"

section() { printf '\n===== %s =====\n' "$1"; }

echo "PulseGate shared context (injected by .claude/hooks/session-start.sh, source=$SOURCE)."
echo "Follow the Context protocol in CLAUDE.md: record decisions with /adr, finish sessions with /handoff."

section "STATE (docs/context/STATE.md)"
[ -f "$CTX/STATE.md" ] && head -n 80 "$CTX/STATE.md"

section "OPEN QUESTIONS (titles only — read docs/context/OPEN_QUESTIONS.md for detail)"
if [ -f "$CTX/OPEN_QUESTIONS.md" ]; then
  awk '/^## Open/{f=1;next} /^## /{f=0} f && /^- \*\*Q[0-9]+/' "$CTX/OPEN_QUESTIONS.md" \
    | sed -E 's/^- \*\*(Q[0-9]+ — [^*]*)\*\*(.*)$/- \1\2/' | head -n 40
fi

section "DECISIONS (docs/adr/README.md — accepted ADRs override the specs)"
[ -f "$ROOT/docs/adr/README.md" ] && grep -E '^\| \[' "$ROOT/docs/adr/README.md" | head -n 60

section "LATEST SESSION LOG ENTRIES"
if [ -f "$CTX/SESSION_LOG.md" ]; then
  # last two "## " entries
  awk '/^## /{n++} {buf[n]=buf[n] $0 "\n"} END{for(i=(n>1?n-1:1);i<=n;i++) printf "%s", buf[i]}' "$CTX/SESSION_LOG.md" | head -n 60
fi

section "RECENTLY MODIFIED FILES (last 7 days, excluding deps)"
find "$ROOT" -type f -mtime -7 \
  -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/dist/*' \
  -not -path '*/.claude/state/*' -not -name '.DS_Store' 2>/dev/null \
  | sed "s|^$ROOT/||" | head -n 30

if git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  TOP="$(git -C "$ROOT" rev-parse --show-toplevel)"
  if [ "$TOP" = "$ROOT" ]; then
    section "GIT"
    git -C "$ROOT" log --oneline -n 8 2>/dev/null || echo "(no commits yet)"
    git -C "$ROOT" status --short 2>/dev/null | head -n 20
  else
    section "GIT"
    echo "WARNING: git root is $TOP, not the project folder. Suggest 'git init' in $ROOT."
  fi
fi
exit 0
