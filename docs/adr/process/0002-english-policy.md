# 0002. English everywhere

- **Status**: Trial
- **Date**: 2026-10-30

## Context

The project is developed by AI agents on a German-language Forgejo host, for
an ecosystem (pi, npm, the pi package gallery) whose lingua franca is English.
Mixing languages — German issues and PRs on an English npm package, or
English code with German docs — invites friction in every hand-off: generated
release notes, package documentation, agent instructions, and public
visibility of the repository.

The user decided this up front; this ADR records it.

## Decision

All content in this repository is English: code, identifiers, comments,
commit messages (Conventional Commits), branch and issue titles, PR
descriptions, ADRs, agent docs and README. Forgejo auto-close keywords
(`Closes #N`) work in English only, which this policy makes natural.

## Consequences

- Issues, PRs and docs are readable by the pi/npm ecosystem audience without
  translation.
- Forgejo quirks that require English (auto-close keywords) cannot break the
  workflow by accident.
- The German-speaking owner accepts English as the working language here;
  other projects (e.g. IntraWeb) keep their own local policy.
