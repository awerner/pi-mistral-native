# 0003. `main` as the integration branch

- **Status**: Trial
- **Date**: 2026-10-30

## Context

This is a small library package with a short release path (npm publish),
a single maintainer, and CI on every push and PR. A `develop`/`main` split
buys release isolation for products with staged deploys; here it would add
a branch, a second merge step and a protection-rule set without a
corresponding benefit.

The user decided this up front; this ADR records it.

## Decision

`main` is the integration branch: feature branches `<issue-nr>-<slug>` branch
off it, PRs target it, and nobody commits directly on it. Releases are npm
publishes from `main`. CI runs `npm ci`, build and test on every push and PR.

## Consequences

- One merge step per change; `main` is always releasable.
- `git describe`-style release tooling and branch protection stay simple
  (protect `main` against direct pushes and require CI).
- No pre-release isolation: if a release train ever needs stabilization, a
  temporary release branch can be cut — a new ADR would record that if it
  becomes permanent.
