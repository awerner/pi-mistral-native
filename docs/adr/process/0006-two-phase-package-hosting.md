# 0006. Two-phase package hosting: Forgejo npm registry pre-release, public at first stable

- **Status**: Trial
- **Date**: 2026-11-01

## Context

The package ships as `0.1.0` and pre-stable versions, and the project
does not want public npm exposure while the API surface is still moving.
The pi package gallery (reached via the `pi-package` keyword) is a Phase 2
goal, not a first-publish one.

Two hosting forces are in tension. Pre-release versions should be cheap to
cut, readable only by the owner's machines, and never squatted or cached on
a public registry that is hard to walk back (unpublishing from npmjs.org is
restricted). Public hosting at `0.1.0` would spend that one-shot openness on
a version nobody should depend on yet. The git.techlex.space Forgejo
instance serves an npm registry at
`https://git.techlex.space/api/packages/agentic/npm/`, so a
private-but-real npm publish target exists without any new infrastructure.

The registry choice interacts with the package name. npm routes a package
by name: an unscoped name always uses the default registry unless every
machine overrides it, while a scoped name can map its scope to exactly one
extra registry with one `~/.npmrc` line and leave the npmjs default
untouched.

## Decision

1. **Phase 1 — publish pre-release versions to the Forgejo npm registry**
   of git.techlex.space, not to npmjs.org. Phase 1 is effective now; the
   flow is documented in [docs/hosting.md](../hosting.md) (the Forgejo
   section extends the existing runbook in
   [docs/publishing.md](../publishing.md)).
2. **Publish under the scoped name `@agentic/pi-mistral-native`.** The
   `package.json` `name` field changes accordingly; the unscoped name
   `pi-mistral-native` stays reserved as the public Phase 2 candidate.
3. **Phase 2 — at the first stable release** (owner-declared, planned
   together with the ADR bulk promotion) publish to npmjs.org under
   the unscoped name and mirror the repository to GitHub; the scoped name
   on the Forgejo registry remains the internal pre-release channel
   afterwards. GitHub-only as a git source is the documented fallback, not
   the plan.

The scoped name is chosen only because it was verified implementable, not
assumed: pi 1.4.0 parses scoped npm sources (`npm:@scope/name@version`,
`parseNpmSpec`) and delegates installs to the real npm CLI, which honors
per-scope registry mappings. `pi install npm:@agentic/pi-mistral-native`
was exercised against the live Forgejo registry and reached it (expected
auth failure with a placeholder token).

The unscoped alternative — keep `pi-mistral-native` and override the
default registry per machine — is rejected as the primary path: it makes
every other `npm install` on that machine hit the Forgejo registry first,
and one missing override silently fails or, worse, resolves against
npmjs.org where the package does not exist. It remains the documented
fallback should scoped installs break.

## Consequences

- **Pre-release privacy by default.** The Forgejo instance is
  sign-in-gated for anonymous clients (anonymous registry requests get
  401), so pre-release packages are effectively token-protected even
  though the `agentic` organization is public: every `pi install` reader
  needs the registry token in their `~/.npmrc`, not just the publisher.
  This is the conservative pre-release default; making the
  instance anonymous-readable is a server-side decision, not ours.
- **Credentials stay with the owner.** The Forgejo publish token is
  owner-only; this repository ships runbooks with placeholders, never
  tokens. Until the first real publish happens, the runbook is validated
  structurally only (registry reachability and `pi install` routing were
  verified; no publish is performed by agents).
- **The public name is now split across two fields of record.** Phase 2
  uses the unscoped name while Phase 1 ships the scoped one, so the
  migration step must change `package.json` back and re-verify the
  gallery keyword still applies. The stable-release step must re-check
  npmjs.org name availability before publishing.
- **`pi -e npm:pi-mistral-native` from the old runbook stops being the
  Phase 1 smoke test.** The Forgejo-phase smoke test is the scoped form
  (`pi -e npm:@agentic/pi-mistral-native`); `docs/hosting.md` is the
  authoritative flow and `docs/publishing.md` points into it.
- **npmjs.org stays untouched and clean.** No public name squat, no
  cached 0.1.0 tarball, and the scoped name keeps the internal channel
  from colliding with the future public package of the same name.
