# Publishing

Runbook for publishing `pi-mistral-native` to npmjs.org (public, owner-executed).
The package publishes under the unscoped name `pi-mistral-native` with a
minimal-surface tarball: the compiled extension, README, changelog, banner
image, and license, with `pi-package` in `keywords` so pi's package gallery
can list it.

Publishing is an owner action. Agents and CI never publish; they document
this runbook, keep the pipeline green, and verify everything short of the
publish itself.

## Tarball surface (manifest decision)

The `files` array ships `dist/extensions`, `assets/banner.png`, `README.md`,
`CHANGELOG.md`, `LICENSE`, and the `pi` manifest points at the built entry
points (`pi.extensions: ["dist/extensions/*.js"]`):

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
- `CHANGELOG.md` ships because pi shows package changelogs under
  "Extension Updates" after an update, reading them from the package root;
  without the file in the tarball users see nothing after upgrading.
- `assets/banner.png` ships so the README's relative banner image resolves
  in every renderer that serves the readme from the package (registry
  previews read the shipped files, not the repository). `pi.image` in the
  `pi` manifest additionally gives the pi gallery a preview image; the
  gallery does not render SVG, hence the PNG (the animated SVG stays in
  the repository for contexts that render it well).
- `exports` is deliberately absent: pi resolves the package via the `pi`
  manifest, not the Node module resolution of consumers; `main` remains as
  a conventional pointer for humans.
- `peerDependencies` stay at `"*"` for `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, and `typebox`; host packages are never
  bundled. The `prepack` script runs the build so the tarball cannot ship
  stale or missing `dist/` output.

*Decisions: [ADR 0009 — Ship built dist as the tarball surface](../dev/adr/0009-ship-built-dist-as-tarball-surface.md)*

## Steps

1. **Preconditions** — on `main`, clean working tree, all checks green:

   ```bash
   npm run check
   npm test
   npm pack --dry-run     # verify the file list before packing
   ```

2. **Login check** — never publish from CI or with a token committed to the
   repository:

   ```bash
   npm whoami             # must print the intended npm account
   ```

3. **Versioning** — releases follow semantic versioning. Bump the version
   with `npm version` (which also tags the commit), not by hand:

   ```bash
   npm version patch      # or minor / major / prerelease
   ```

   When the bump already landed via a release branch (as in a chore wave),
   `npm version` cannot be used — it would bump past the shipped version.
   Create the tag explicitly at the publish point instead:

   ```bash
   git tag v<version> && git push origin v<version>
   ```

   Do not bump versions ahead of time; the version in `package.json` is the
   published version. npmjs does not allow overwriting a published version
   — see [Unpublish](#unpublish) below — so every publish needs its own
   version.

4. **Pack and inspect** — `npm pack` (the `prepack` script rebuilds
   `dist/`); open the tarball if anything looks off:

   ```bash
   npm pack
   tar -tzf pi-mistral-native-<version>.tgz
   ```

5. **Publish** — public access from the repository root:

   ```bash
   npm publish --access public
   ```

   If the publishing account has two-factor authentication enabled, npm
   requires an OTP for the publish:

   ```bash
   npm publish --access public --otp=<one-time-password>
   ```

6. **Smoke test the published package** — fresh scratch directory, no local
   checkout in scope. `pi -e npm:…` loads the package for one invocation
   without touching `~/.pi/agent/settings.json`:

   ```bash
   mkdir /tmp/pi-mistral-smoke && cd /tmp/pi-mistral-smoke
   pi -e npm:pi-mistral-native --list-models   # provider appears once a credential resolves
   rm -rf /tmp/pi-mistral-smoke
   ```

   For a persistent install (personal scope), clean up with
   `pi remove npm:pi-mistral-native` afterwards.

   **The smoke test must go through the npm registry.** Installing from a
   local tarball (`pi install <path-to-tarball>`) is *not* a valid smoke
   test for an npm-published package: a local tarball does not exercise the
   npm registry resolution path, so it can pass even when the published
   package is broken or stale. The only valid check that the package
   actually arrived on npmjs is `pi install npm:pi-mistral-native` (or the
   `pi -e` one-shot form above), run after a real `npm publish`. This was
   learned the hard way: a local-tarball install verifies packing, not
   publishing.

7. **Tag and release** — `npm version` already created the tag; push it and
   optionally create a GitHub release for `v<version>` on
   `https://github.com/mawoh/pi-mistral-native` with the tarball attached:

   ```bash
   git push origin main --follow-tags
   ```

## Unpublish

npmjs does not allow overwriting a published version. If a publish turns
out to be broken:

- Within **72 hours** of publishing, `npm unpublish pi-mistral-native@<version>`
  can remove a single broken version without special conditions.
- After that window, unpublishing is restricted by npm policy: removing the
  package entirely requires `npm unpublish pi-mistral-native --force`, and
  npm may still serve the cached content for a while. Unpublished versions
  cannot be reused for a different tarball.
- The practical rule: bump the version and publish a fixed release rather
  than unpublish-republish cycles; `npm unpublish` is for mistakes.

## Local install verification (without publishing)

pi install accepts npm registry, git, or a local directory as sources —
a raw tarball is not one (pi registers only the path string and the reload
fails on `.tgz`). Verify from a packed tarball by unpacking it into a
scratch directory and pointing pi at that directory (equivalent to what
npm publishes):

```bash
npm pack                                          # produces pi-mistral-native-<version>.tgz
mkdir /tmp/pi-mistral-verify && cd /tmp/pi-mistral-verify
tar -xzf /path/to/pi-mistral-native-<version>.tgz     # unpacks into ./package
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
- Never commit an `.npmrc` with a registry token or OTP; use `npm whoami` /
  environment-level login state.
- Never add the SDK or other runtime dependencies: the minimal surface is
  the point.
- Never publish with agent-controlled credentials: npm credentials stay
  with the owner, on the owner's machine; agents document and verify only.

*Decisions: [ADR 0008 — Direct fetch over vendor SDK](../dev/adr/0008-direct-fetch-over-vendor-sdk.md)*
