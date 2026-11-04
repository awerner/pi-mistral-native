# API-key authentication

## What you can do

- **Log in once** — run `/login mistral-native` in pi, paste an API
  key from [La Plateforme](https://console.mistral.ai/api-keys), pick
  a region — done. pi stores the credential; every session uses it.
- **Or skip login entirely** — export `MISTRAL_API_KEY` and it works
  with zero configuration.
- **Keep the key in your secret manager** — a `!command` entry in
  `auth.json` resolves the key from wherever you keep it.
- **Log out cleanly** — `/logout` deletes the stored credential and
  nothing else.

The rest of this page covers how resolution works, the login flow's
details, and the security guarantees.

## How it works

The provider registers **native API-key auth**: `/login` in pi runs
the extension's own guided flow, and an exported environment variable
works with zero configuration at all.

Two credential sources, checked in this order:

1. **Stored credential** — a `mistral-native` API-key entry in
   `~/.pi/agent/auth.json`, written by `/login`.
2. **Environment variable** — `MISTRAL_API_KEY`, the zero-configuration
   default: export the key and the provider works.

A `!command` entry in `auth.json` (e.g. resolving the key from a secret
manager) is also supported — pi resolves it itself, cross-platform.

### `/login mistral-native`

Run `/login mistral-native` in pi: the provider registers a **native
`ApiKeyAuth`**, so pi runs the extension's own guided flow —

1. a `secret` prompt for the API key (create one at
   <https://console.mistral.ai/api-keys>; no echo), then
2. a `select` prompt for the API region — **Global** (`api.mistral.ai`,
   default, full feature set), **EU** (`api.eu.mistral.ai`) or **US**
   (`api.us.mistral.ai`), each with data-residency routing and the +10%
   regional surcharge.

The API key goes **only** to `~/.pi/agent/auth.json` — pi persists it
itself; the config file never stores credentials. A non-global region
selection writes `endpoint.region` to the user-scope
`mistral-native.json`. `/logout` deletes the stored credential (the
region selection stays). pi also forwards the typed prompts to RPC
clients, so remote sessions get the same guided flow.

### Provider-id scoping

Credentials are scoped by provider id. An existing `mistral` entry in
`~/.pi/agent/auth.json` belongs to a *different* provider and does
**not** apply to `mistral-native` — run `/login mistral-native` to
store a key for this provider.

## Security guarantees

- The key is only ever placed on the outbound `Authorization: Bearer …`
  header. It is never logged, never embedded in error messages, and
  never written into tool results or `details`.
- Error paths surface server-supplied text only (status plus a
  size-capped body excerpt); request headers are never included.
- The extension contains **no logging sinks** at all — pinned by a
  static guard in the test suite, so no code path can print key
  material.

## Advanced: why API-key only

Mistral offers **no OAuth flow for API access** — no device-code grant,
no browser redirect, no token endpoints (verified against the vendored
spec's security schemes and live probes; the only "oauth2" occurrences
concern *connectors*, third-party services Mistral calls out to). The
provider therefore registers API-key auth only. If Mistral ever
publishes OAuth endpoints, the provider's additive `oauth` registration
surface remains available and the API-key-only decision gets
superseded.

## Notes

- The credential chain order is exported as
  `AUTH_FALLBACK_CHAIN = ["auth-json", "env"]` for tests and
  documentation; the provider's native `ApiKeyAuth.resolve` implements
  it. The knowledge tools (see [knowledge-tools.md](knowledge-tools.md))
  resolve their key per call through the same chain: first the
  `mistral-native` provider's registered key via
  `ctx.modelRegistry.getApiKeyForProvider()`, then `MISTRAL_API_KEY`.
- An auth.json entry whose `key` is empty (e.g. a hand-edited
  auth.json) carries no usable key material and falls through to the
  env var, matching pi-ai's canonical `envApiKeyAuth`. The `!command`
  resolution is synchronous and bounded by a 10s timeout.
- Caveat: a **project-scope** `endpoint.region` still wins over the
  login's user-scope write (project > user), so in a project that sets
  its own region the login selection appears ineffective.
