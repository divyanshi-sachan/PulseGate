---
description: Persist this session's progress and decisions for the next session
---
Write the session handoff so the next Claude session starts with full context.

1. Review what happened this session (conversation + files changed). List any decision made that has no ADR yet;
   create ADRs for them first (follow .claude/commands/adr.md), asking the user only if a choice was left ambiguous.
2. Update docs/context/STATE.md: `_Last updated_` date, current phase, Done, Next up (concrete, ordered), Blockers.
   Keep it under ~60 lines — it is injected into every session.
3. Add any newly discovered spec gaps to docs/context/OPEN_QUESTIONS.md with a proposed default.
4. Append ONE entry to the bottom of docs/context/SESSION_LOG.md:
   `## YYYY-MM-DD · <short title>` then bullets **Goal**, **Changed**, **Decisions** (ADR links), **Open threads**.
   Never rewrite older entries.
5. If test/lint/build commands now exist, make sure the Commands block in CLAUDE.md is accurate.
6. Reply with a 3-line summary of what was recorded.
