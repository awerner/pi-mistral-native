# NNNN. Title

- **Status**: Trial | Accepted | Superseded by NNNN
- **Date**: YYYY-MM-DD

Pick the series by the taxonomy (process
[0007](process/0007-adr-taxonomy.md)): architecture (`docs/adr/`) for
decisions about the shipped software's shape and behavior; process
(`docs/adr/process/`) for decisions about how the project is developed.
Number sequentially within the series and add the record to that series'
index.

Status legend:

- `Trial` — birth state of every ADR: agent-authored proposal in evaluation;
  may be sharpened, rewritten, or discarded.
- `Accepted` — promoted only by an explicit human (project-owner) decision;
  from here on immutable.
- `Superseded by NNNN` — an accepted ADR replaced by ADR NNNN.

## Context

What is the situation forcing a decision? What forces (technical,
organisational, hosting, etc.) are in tension?

## Decision

What did we decide to do?

## Consequences

What becomes easier or harder as a result? What did we knowingly give up or
accept as risk?

## Record discipline

- The record describes the **current state** of the decision. Never append
  dated update blocks; integrate changes into the sections above (the
  evolution lives in git history). Reference discipline: process
  [0008](process/0008-reference-discipline.md).
- Self-contained: no issue/tracker references, no "see issue #N" — the
  Context/Decision/Consequences must stand alone.
- Cross-ADR references cite number and title: `ADR NNNN — Title`.
