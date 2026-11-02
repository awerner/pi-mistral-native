# Publishing

Runbook for publishing `pi-mistral-native` to npm (issue #9). The package
publishes as version `0.1.0`; the goal is a minimal-surface tarball: only
the compiled extension, README, and license (decision below), with
`pi-package` in `keywords` so pi's package gallery can list it.

Hosting is two-phase (issue #26, ADR
[0006](adr/process/0006-two-phase-package-hosting.md)): pre-release versions
publish to the **Forgejo npm registry** under the scoped name
`@agentic/pi-mistral-native` — that flow lives in
[hosting.md](hosting.md). The steps below cover packing, inspection and
tagging, which both phases share, and the **npmjs.org publish itself,
which is Phase 2** (first stable release, owner-declared).

## Tarball surface (manifest decision)

The `files` array ships `dist/extensions`, `README.md`, `LICENSE`, and the
`pi` manifest points at the built entry points
(`pi.extensions: ["dist/extensions/*.js"]`):

- pi resolves package resources via the `pi` manifest, paths relative to
  the package root, globs included — built JavaScript works and is what
  `npm test` actually verified.
- Shipping the compiled `dist/` keeps the published artifact identical to
  the tested artifact and does not rely on pi's TypeScript transpilation in
  foreign installs; shipping `extensions/*.ts` sources instead would work
  too (pi loads TS directly) but duplicates the runtime artifact next to
  `main` and leaves the tarball's entry points untested-by-build.
- `files` names `dist/extensions`, not `dist`, so the compiled test suite
  (`dist/test/*.test.js`, used by `npm test`) stays out of the tarball.
- `exports` is deliberately absent: pi resolves the package via the `pi`
  manifest, not the Node module resolution of consumers; `main` remains as
  a conventional pointer for humans.
- `peerDependencies` stay at `"*"` for `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, and `typebox`; host packages are never
  bundled. The `prepack` script runs the build so the tarball cannot ship
  stale or missing `dist/` output.

*Decisions: [ADR 0009 — Ship built dist as the tarball surface](adr/0009-ship-built-dist-as-tarball-surface.md)*

## Steps

1. **Preconditions** — on `main`, clean working tree, all checks green:

   ```bash
   npm run check
   npm test
   npm pack --dry-run     # verify the file list before packing
   ```

2. **Registry / login check** — never publish from CI or with a token
   committed to the repository. Phase 2 (npmjs.org):

   ```bash
   npm whoami             # must print the intended npm account
   ```

   Phase 1 (Forgejo registry) has no `npm whoami` (as of the current
   Gitea version; the endpoint is announced for Gitea 29.0.0); the
   `~/.npmrc` scope mapping and token from [hosting.md](hosting.md)
   replace the login.

3. **Pack and inspect** — `npm pack` (the `prepack` script rebuilds
   `dist/`); open the tarball if anything looks off:

   ```bash
   npm pack
   tar -tzf agentic-pi-mistral-native-0.1.0.tgz
   ```

4. **Publish** — public access, no provenance/attestations required yet.
   This is the **Phase 2** npmjs.org publish; for the current Phase 1
   (Forgejo registry, scoped name) use the publish command in
   [hosting.md](hosting.md#publish-owner-only) instead:

   ```bash
   npm publish agentic-pi-mistral-native-0.1.0.tgz --access public   # Phase 2 only
   ```

   Do not bump versions ahead of time; the version in `package.json` is the
   published version.

5. **Smoke test the published package** — fresh scratch directory, no local
   checkout in scope. `pi -e npm:…` loads the package for one invocation
   without touching `~/.pi/agent/settings.json`:

   ```bash
   mkdir /tmp/pi-mistral-smoke && cd /tmp/pi-mistral-smoke
   pi -e npm:pi-mistral-native --list-models   # provider appears once a credential resolves
   rm -rf /tmp/pi-mistral-smoke
   ```

   During Phase 1 the smoke test uses the scoped form against the Forgejo
   registry — see the
   [verify flow in hosting.md](hosting.md#verify-the-install-path-after-the-first-publish);
   the command above is the Phase 2 form. For a persistent install
   (`pi install npm:pi-mistral-native`, personal scope), clean up with
   `pi remove npm:pi-mistral-native` afterwards.

6. **Tag and release** — after the publish PR merges to `main`:

   ```bash
   git tag -a v0.1.0 -m "pi-mistral-native v0.1.0" && git push origin v0.1.0
   ```

   Optionally create a Forgejo release for `v0.1.0` on
   `https://git.techlex.space/agentic/pi-mistral-native` with the tarball
   attached.

## Local install verification (without publishing)

pi install accepts npm registry, git, or a local directory as sources —
a raw tarball is not one (pi registers only the path string and the reload
fails on `.tgz`). Verify from a packed tarball by unpacking it into a
scratch directory and pointing pi at that directory (equivalent to what
npm publishes):

```bash
npm pack                                          # produces agentic-pi-mistral-native-0.1.0.tgz
mkdir /tmp/pi-mistral-verify && cd /tmp/pi-mistral-verify
tar -xzf /path/to/agentic-pi-mistral-native-0.1.0.tgz     # unpacks into ./package
MISTRAL_API_KEY=… pi -e ./package --list-models | grep mistral-native
rm -rf /tmp/pi-mistral-verify
```

The provider appears in `--list-models` only once pi can resolve a
credential for it (`MISTRAL_API_KEY` or a stored `mistral-native` API key).
Note the same silent-failure mode as in a local checkout: if the manifest
glob matches no file (e.g. a stale tarball without `dist/extensions/`), pi
loads nothing and only the missing provider in `--list-models` hints at it.

## Never

- Never publish from a branch other than `main` post-merge, and never with
  `npm run check` or `npm test` failing.
- Never commit an `.npmrc` with a registry token; use `npm whoami` /
  environment-level login state.
- Never add the SDK or other runtime dependencies: the minimal surface is
  the point.

*Decisions: [ADR 0008 — Direct fetch over vendor SDK](adr/0008-direct-fetch-over-vendor-sdk.md)*
