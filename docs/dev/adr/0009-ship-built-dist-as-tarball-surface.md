# 0009. Ship built dist as the tarball surface

- **Status**: Trial
- **Date**: 2026-10-31

## Context

The npm packaging and the `pi` package manifest have to settle what the
published tarball ships and what the `pi` manifest points at. A manifest
that declared `pi.extensions: ["extensions/*.ts"]` while `files`
excluded `extensions/` entirely — the published package would have loaded
nothing. Two minimal-surface options existed: ship the TypeScript sources
(`extensions/` in `files`, manifest unchanged) or ship the compiled output
(`dist/extensions` in `files`, manifest pointing at
`dist/extensions/*.js`). pi resolves both: the `pi` manifest supports
globs relative to the package root, and pi transpiles TypeScript entry
files directly.

## Decision

Ship the compiled output: `files: ["dist/extensions", "README.md",
"LICENSE"]`, `pi.extensions: ["dist/extensions/*.js"]`, and a `prepack`
script (`npm run build`) so the tarball can never ship stale or missing
`dist/` output.

- The published artifact is identical to the artifact `npm test` verified;
  it does not depend on pi's TypeScript transpilation in foreign installs.
- `files` names `dist/extensions`, not `dist`, so the compiled test suite
  (`dist/test/*.test.js`) stays out of the tarball; npm nullifies
  `.gitignore` for packed paths when `files` is present, so the
  git-ignored `dist/` still ships.
- `exports` stays absent: pi resolves the package via the `pi` manifest,
  not Node module resolution; `main` remains a conventional pointer.
- Development against the TypeScript sources keeps working without a
  build via the single-file entry point (`pi -e extensions/mistral.ts`).

Known trade-off accepted: in a fresh local checkout, `pi install`/`pi -e`
against the package root silently loads no extension until `npm run build`
has produced `dist/` (the manifest glob matches no file). This is
documented in the README and `docs/dev/publishing.md`.

## Consequences

- **Easier:** one runtime artifact (the tested build); no transpiler
  version drift between local checkout and published package; smaller
  review surface for the tarball contents.
- **Harder:** local package-root installs (`pi install ./pi-mistral-native`)
  require `npm run build` first, and fail silently when it is skipped.
- **Known risk accepted:** the manifest no longer exercises pi's
  TypeScript entry loading in the published flow; that path remains
  covered by the development flow above.
