---
description: Record an architecture decision (ADR) and resolve the matching open question
argument-hint: <decision title, or Qn to resolve an open question>
---
Record a decision for PulseGate: **$ARGUMENTS**

1. If the argument is an open-question id (e.g. `Q5`), read it in docs/context/OPEN_QUESTIONS.md. If the user
   hasn't clearly chosen an option in this conversation, present the options with the proposed default and ask before writing.
2. Find the next ADR number in docs/adr/ (highest existing + 1, 4 digits). Copy docs/adr/0000-template.md to
   `docs/adr/NNNN-<kebab-slug>.md` and fill every section. The Decision must be precise enough to check code against.
   Cite the spec sections it refines or overrides in **Source** / **Supersedes**.
3. If it supersedes an earlier ADR, set that ADR's status to `Superseded by ADR-NNNN`.
4. Add a row to the table in docs/adr/README.md.
5. If it resolves an open question, move that item under **Resolved** in OPEN_QUESTIONS.md as `Qn → ADR-NNNN: <one line>`.
6. If it changes a non-negotiable invariant in CLAUDE.md, update that bullet too.
7. Reply with the ADR path and a one-sentence summary.
