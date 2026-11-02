# 0007. ADR taxonomy: architecture vs. process records

- **Status**: Trial
- **Date**: 2026-11-07

## Context

The ADR series originally recorded every decision — software architecture
and development process alike — in one numbered sequence. Process records
(platform choice, language policy, branching, testing, documentation,
hosting) describe how the project is developed, not what the built
software is; mixing them into the architecture series made the
architecture index harder to read and invited misclassification.

## Decision

Decisions are recorded in two series, each with fresh sequential numbering
and its own index:

- **Architecture** (`docs/adr/`): decisions about the target architecture
  of the shipped software — components, data and wire models, provider and
  tool surfaces, packaging and distribution of the artifact.
- **Process** (`docs/adr/process/`): decisions about how the project is
  developed — the agent platform, language policy, branching model, test
  strategy, documentation conventions, release and hosting process.

The classification test: a record is **process** if it would still be true
had the software been built differently; a record is **architecture** if it
describes the shape or behavior of the artifact this repository ships. A
decision about *how* releases are published is process even though it
touches the package; a decision about *what* the tarball contains is
architecture.

Classification happens when the ADR is written; the two indexes link to
this record for the rules. A misclassified ADR is moved (and, in the early
project, renumbered) in the change that notices it. Both series share the
lifecycle: born `Trial`, owner-only promotion, immutable once `Accepted`.

## Consequences

- Each index answers one question: "what is the software?" or "how is it
  developed?"
- Cross-series references are just links; numbers are only unique within a
  series, so citations name number and title.
- A decision spanning both worlds (e.g. the test suite: strategy vs.
  wire-contract pinning) is classified by its dominant force and may cite
  the other series.
