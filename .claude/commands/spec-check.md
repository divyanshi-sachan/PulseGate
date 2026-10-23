---
description: Review current changes against PulseGate specs, invariants and ADRs
argument-hint: [optional path or component to focus on]
---
Use the `spec-reviewer` subagent to review the current work $ARGUMENTS against CLAUDE.md invariants,
accepted ADRs, and the three spec documents. Give it the list of files changed this session.
Then report its findings to the user grouped as: violations (must fix), undocumented decisions (need an ADR),
missing tests, and nits. Offer to fix violations; do not fix silently.
