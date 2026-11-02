# Package hosting

Two-phase hosting strategy for the package (issue #26, ADR
[0006](adr/process/0006-two-phase-package-hosting.md)):

- **Phase 1 (effective now):** pre-release versions (`0.1.x`) publish to
  the Forgejo npm registry of git.techlex.space under the scoped name
  **`@agentic/pi-mistral-native`**.
- **Phase 2 (at the first stable release):** publish to npmjs.org under
  the unscoped name `pi-mistral-native` and mirror the repository to
  GitHub — see the [Phase 2](#phase-2--public-migration-at-first-stable)
  section.

The general pack/inspect/tag steps stay in
[publishing.md](publishing.md); this document owns the registry choice,
the `~/.npmrc` setup, the name decision, and the per-phase flows.

## Name decision: scoped internally

| | Scoped `@agentic/pi-mistral-native` | Unscoped `pi-mistral-native` |
|---|---|---|
| Registry mapping | One `~/.npmrc` line maps the scope; npmjs default registry untouched | Default registry must be overridden on every machine |
| Footgun | None — only `@agentic/*` routes to Forgejo | Every `npm install` on that machine hits the Forgejo registry first; one missing override silently resolves against npmjs.org |
| Phase 2 | Public name stays clean; package.json rename back to unscoped is a deliberate migration step | Same name moves registries; old internal installs can shadow the public package |
| pi support | Verified: pi 1.4.0 parses scoped specs and delegates to npm, which honors scope mappings | Works without any scoped-name handling |

The registry pattern behind the scoped mapping: npm routes a package by
its name — an unscoped name always goes to the default registry, a scoped
name goes to the registry mapped for its scope. Phase 1 uses that per-scope
mapping; npmjs.org stays the default for everything else on the machine.

## Phase 1 — Forgejo npm registry

The git.techlex.space Forgejo instance serves an npm registry at

```text
https://git.techlex.space/api/packages/agentic/npm/
```

(`has_packages: true` on the instance; the registry pattern from the
Forgejo docs is `/api/packages/{owner}/npm/`, owner here is the
organization `agentic` — the same owner as the repository). Reachability
was verified without publishing: an unauthenticated package GET returns
**401**, proving the endpoint exists and demands auth; with a valid token a
GET for the not-yet-published package returns **404**.

### Registry setup (once, per machine)

Create a token in Forgejo: **Settings → Applications**, scoped to
**read/write: Packages** (publishing machines) or read-only Packages
(reader machines). Then add a scope mapping plus the token to `~/.npmrc`:

```ini
@agentic:registry=https://git.techlex.space/api/packages/agentic/npm/
//git.techlex.space/api/packages/agentic/npm/:_authToken=<forgejo-packages-token>
```

Notes on the token line, per the Forgejo npm docs:

- **Placeholders only** — never a real token, never in any committed file.
  `~/.npmrc` is machine-local; nothing in this repository carries it.
- The token key **omits the `https:` scheme** — it must read
  `//git.techlex.space/…`, not `https://git.techlex.space/…`.
- `npm config set` can write both lines (`npm config set @agentic:registry
  https://…` and `npm config set -- '//git.techlex.space/…/:_authToken'
  "<token>"`) if hand-editing is undesirable.

The scope mapping routes only `@agentic/*` packages to the Forgejo
registry; every other package on the machine keeps resolving against
npmjs.org. This is why the package name changed to
`@agentic/pi-mistral-native` (see the [name decision](#name-decision-scoped-internally)).

### Publish (owner only)

Publishing uses the pack/inspect steps from
[publishing.md](publishing.md) (preconditions, `npm pack`, tarball
inspection); only the publish target differs:

```bash
npm publish --registry=https://git.techlex.space/api/packages/agentic/npm/
```

The `--registry` flag is belt-and-braces: with the `@agentic` scope
mapping in `~/.npmrc`, npm already routes the scoped package correctly.
`--access public` is not used — on the Forgejo registry every package is
owned by the `agentic` organization; access follows the registry's
visibility rules, not npm's public/private flag.

The Forgejo token is **owner-only**. Agents never publish; they prepare
this runbook and verify everything short of the publish itself.

### Verify the install path (after the first publish)

Fresh scratch directory, no local checkout in scope, machine prepared as
above:

```bash
mkdir /tmp/pi-mistral-smoke && cd /tmp/pi-mistral-smoke
pi -e npm:@agentic/pi-mistral-native --list-models | grep mistral-native
rm -rf /tmp/pi-mistral-smoke
```

For a persistent install (personal scope), clean up afterwards:

```bash
pi install npm:@agentic/pi-mistral-native
pi --list-models | grep mistral-native
pi remove npm:@agentic/pi-mistral-native
```

The provider appears in `--list-models` only once pi can resolve a
credential (`MISTRAL_API_KEY` or a stored `mistral-native` API key). pi
honors the `~/.npmrc` scope mapping because it delegates npm installs to
the real npm CLI; this routing was verified against the live registry
(`pi install npm:@agentic/pi-mistral-native` reaches the Forgejo
registry, failing only on the expected auth step with a placeholder
token).

### Unpublish / iterate

Forgejo does not allow overwriting a published version:

```bash
npm unpublish @agentic/pi-mistral-native@0.1.0 --registry=https://git.techlex.space/api/packages/agentic/npm/
```

Bump the version in `package.json` for every publish instead of
unpublish-republish cycles; `npm unpublish` is for mistakes. Note that
npm requires `--force` client-side when unpublishing the only remaining
version of a package.

## Pre-release visibility (Phase 1)

Pre-release packages on the Forgejo registry are **token-protected for
every reader**, not just the publisher:

- Forgejo access rules for packages: read access follows the owner — a
  public organization's packages are readable by everyone *unless* the
  instance restricts them. This instance answers anonymous registry
  requests with **401** and anonymous API access with **403**
  (`REQUIRE_SIGNIN_VIEW`-style gating), so anonymous `pi install` fails.
- Consequence: every machine that runs `pi install
  npm:@agentic/pi-mistral-native` needs the `~/.npmrc` scope mapping
  **and a Forgejo token with package read access**. Distributing that
  token is an owner decision; for pre-release that is the conservative
  default the issue asked for.
- If the owner later wants anonymous internal reads, that is a
  **server-side setting** (instance sign-in-view or a package-visibility
  change in a future Forgejo version with finer-grained package
  visibility) — nothing in this repository controls it.

## Phase 2 — Public migration at first stable

Trigger: the owner declares the first stable release (planned together
with the ADR bulk promotion, issue #24 context). The full decision record
is ADR [0006](adr/process/0006-two-phase-package-hosting.md); the migration plan:

1. **Name check on npmjs.org** — re-verify availability immediately
   before publishing. Both names were free as of 2026-10-31 (live checks
   against registry.npmjs.org: `pi-mistral-native` 404, scoped 404); if
   the unscoped name is taken at that point, publish scoped or pick a
   free name — decide before the stable tag.
2. **Hosting decision (a)/(b)**, decided with the owner at stable time:
   - **(a) npmjs.org publish + GitHub repository mirror** — the working
     assumption: required for **pi package gallery eligibility** (the
     `pi-package` keyword in `package.json` lists the package on
     pi.dev/packages discovery, which reads npmjs.org), semver, and the
     natural `pi install npm:pi-mistral-native` flow.
   - **(b) GitHub-only as a git source** (`pi install
     git:github.com/…`) — no gallery eligibility, no npm account, manual
     dependency resolution; documented fallback if (a) is rejected.
3. **Migration mechanics**: rename `package.json` `name` back to the
   unscoped `pi-mistral-native` (undoing the Phase 1 scoped rename),
   bump to stable semver, publish to npmjs.org per
   [publishing.md](publishing.md), mirror the repository to GitHub
   (Actions CI parity is optional — decide then). The Forgejo registry
   stays the internal pre-release channel for any post-stable
   pre-releases.
