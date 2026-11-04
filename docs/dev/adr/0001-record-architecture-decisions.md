# 0001. Record architecture decisions

- **Status**: Trial
- **Date**: 2026-10-30

## Context

pi-mistral-native is a greenfield repository whose architecture is shaped by
deliberate choices — a native provider extension instead of a dependency
patch, a vendored API spec, English-only content, a single integration
branch. Without durable records, the reasoning behind them would live only in
issues and commit messages, and both humans and AI coding agents would re-derive
or contradict it.

The project is developed almost entirely by AI agents, so a merged PR is a
machine's proposal, not a human's acceptance: an "accepted on merge" rule would
fake decisions nobody actually made.

## Decision

Record architecture decisions as lightweight ADRs in `docs/dev/adr/`, one file
per decision, numbered sequentially, following `docs/dev/adr/template.md`. Not
every change gets one — see the rule in `docs/dev/adr/README.md` (architecture
change, rejected alternative, or accepted risk). Routine version bumps and
bug fixes are just commits.

ADRs are born with status `Trial`. A `Trial` ADR is a proposal under
evaluation: agents may sharpen, rewrite, or discard it. Promotion
`Trial → Accepted` happens only by an explicit decision of the project
owner (the human); merging the introducing PR implies no acceptance. With
the first stable release, the plan is to promote all ADRs accumulated by
then to `Accepted` in one bulk pass.

Once accepted, an ADR is immutable: a changed decision gets a new ADR and
the old one's status becomes `Superseded by NNNN`.

No tooling is attached: no frontmatter, no generated index, no linter. The
index in `README.md` is kept by hand.

## Consequences

- Changes that touch architecture start with "does this need an ADR, and have
  I read the existing ones" instead of re-deriving context.
- Small overhead: an architecturally significant change has one more file to
  write, and the hand-kept index can drift if forgotten.
- The acceptance gate stays with the human: decisions only become binding
  once promoted, and the development phase stays flexible because `Trial`
  ADRs can be revised without supersede mechanics.
- Until the bulk promotion lands, every ADR's status encodes the same "in
  evaluation" state, so the status line carries no ranking information.
