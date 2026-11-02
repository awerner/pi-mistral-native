# 0008. Reference discipline in code and documentation

- **Status**: Trial
- **Date**: 2026-11-07

## Context

Comments and documentation that carry issue numbers, dated update blocks or
development history rot fast: the tracker reference goes stale, the
history duplicates what git already records, and readers must reconstruct
the current state from a stack of amendments. A Trial ADR that carries
dated update paragraphs is the same failure — the record stops describing
one coherent decision and becomes a changelog of its own evolution.

## Decision

Code and documentation describe current state; history lives in git. The
rules:

1. **Code comments** earn their place by explaining surprising API
   behavior or particularly complex code — concise, precise, useful.
   They never carry issue/tracker references and no development history;
   git is the history. Commit messages may reference issues — that is the
   boundary.
2. **ADR references in code** appear only as `ADR NNNN — Title` at the
   end of a block comment — never inline, never a bare number.
3. **ADR records** are coherent current-state descriptions. A `Trial`
   ADR integrates changes into its Context/Decision/Consequences instead
   of appending dated update blocks; the record's evolution lives in git
   history.
4. **Documentation** describes current behavior; user-facing update
   actions belong to the changelog, not to doc sections. Audience docs
   follow the capability-first convention (ADR
   [0005](0005-documentation-structure-and-adr-citation.md)).

## Consequences

- Comments and docs stay true as the code changes around them; no stale
  issue numbers to chase.
- ADRs read as one decision each; superseding or genuinely new decisions
  get their own record instead of an amendment note.
- Rewriting a `Trial` ADR to current state is routine maintenance, not
  history loss — `git log` on the file preserves every intermediate shape.
