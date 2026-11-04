# 0010. Configuration via mistral-native.json

- **Status**: Trial
- **Date**: 2026-10-31

## Context

pi-mistral-native's configuration lives in a JSON file layer.
pi's own `settings.json` schema is closed — extensions cannot register
settings pages or keys in it (verified against pi-coding-agent 1.4.0: no
extension hook exists in `ExtensionAPI`) — so each pi package owns a
JSON file in the agent dir. The ecosystem pattern was researched and
verified live against installed pi packages (pi-web-access,
pi-permission-system, billion-context):

1. pi's settings.json schema is closed → each package owns a JSON file
   in the agent dir.
2. pi-web-access precedent: a multi-path resolution chain
   (`PI_CODING_AGENT_DIR` → XDG → legacy paths) with first-existing-file
   wins and strict validation whose errors name the exact file and key.
3. A credential-syntax protocol for config values (`$VAR`, `${VAR}`,
   `!command`, `$$`/`$!` escapes) — the semantics of pi's own
   `resolveConfigValue`, which pi does not export through its package
   root, so the protocol is implemented locally.
4. Environment variables as an override layer keep the ADR-0007 env-first
   default intact: the zero-config `MISTRAL_API_KEY` setup must keep
   working unchanged when no file exists.

## Decision

Configuration lives in `mistral-native.json` with user scope (resolution
chain modeled on pi-web-access: `$PI_CODING_AGENT_DIR` →
`$XDG_CONFIG_HOME/pi` → `<agent-dir>` → legacy `~/.pi/`) and project
scope (`<cwd>/.pi/mistral-native.json`, loaded only with active project
trust). Precedence, highest wins: **project JSON > user JSON >
environment variables > defaults**; project wins per key over user with
key-by-key merging inside section objects. The API key itself NEVER moves
into this file — it stays in pi's auth chain (`auth.json` credential via
`/login mistral-native`, or `MISTRAL_API_KEY`, ADR 0004).

The schema is complete in one pass, including **reserved-and-parsed**
sections: `endpoint`, `connectorTools`, `models`, `knowledge`/`rag`,
`ocr` are strictly validated and
exposed on the resolved config, but no behavior derives from them yet —
files written today keep validating when those features land.

- **Strict validation with named-path errors** (the
  pi-web-access pattern): `unknown field "X" in <exact path>; known
  fields: …`, invalid values name key, file and valid options.
- **Never crash**: no file → defaults + env (today's behavior);
  malformed/invalid file → ignored (env-only degraded mode), error
  surfaced as a warning via `ctx.ui.notify` on `session_start`.
- **Config-value protocol** for the credential-adjacent fields
  (`agentId`, `endpoint.baseUrl`): `$VAR`/`${VAR}` interpolation,
  `!command` execution (10s timeout, trimmed stdout), `$$`/`$!`
  escapes; a referenced-but-unset env var or failed command resolves to
  unset; resolved values are never logged.
- **Deliberately no `misc` grab-bag section**: strict validation argues
  for explicit sections; an unknown key must fail loudly, and a
  grab-bag would defeat that.

## Consequences

- **Easier:** complete schema up front (later changes extend behavior,
  not schema); env-only setups unchanged; validation errors name the
  exact file and key, so hand-edited files fail with guided fixes.
- **Harder:** users who set both JSON and env for the same key must know
  JSON wins (documented as the migration note in
  docs/configuration.md); strict unknown-field rejection can annoy
  forward-compat expectations — acceptable for a v1 config surface; the
  file is extension-owned and documented as such.
- **Known risk accepted:** the config-value protocol is a local mirror
  of pi's `resolveConfigValue` semantics; if pi ever exports the real
  one, the local implementation should be replaced (behavior is pinned
  by tests). The mirror also omits pi's win32 configured-shell fallback
  (pi tries the user's configured shell before falling back to
  `execSync` on Windows), so `!command` values on Windows run through
  the default shell, which may differ from pi's own auth-file
  `!command` handling for shell-specific syntax.

The user-scope file is authored by hand or created by an explicit first
`/mistral set` or by the guided `/login` region picker (ADR
[0016](0016-mistral-command-family.md)); it is never created
speculatively — with no `set`, the no-file env-first default is
unchanged. The `/mistral` command family writes user scope only; the
project scope stays hand-authored (trust boundary — it travels with the
repo).
