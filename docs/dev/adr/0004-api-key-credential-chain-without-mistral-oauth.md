# 0004. API-key credential chain without Mistral OAuth

- **Status**: Trial
- **Date**: 2026-10-30

## Context

An OAuth `/login` flow for the `mistral-native` provider requires a
device-code or browser-redirect flow against Mistral's endpoints — or, if
Mistral does not offer a public OAuth flow, a documented fallback chain.
Research against upstream sources:

- The vendored OpenAPI spec
  ([0003](0003-vendored-openapi-spec.md)) is global `security: [ApiKey: []]`
  (HTTP bearer API key) with no OAuth2 security scheme, no device-authorization
  or token endpoints. The only "oauth2" occurrences concern *connectors*
  (third-party services Mistral calls out to), not client authentication
  against Mistral itself.
- Live probes: `https://api.mistral.ai/.well-known/openid-configuration`
  answers 404; there is no OAuth discovery document.
- Current upstream docs (<https://docs.mistral.ai>): developer quickstarts
  authenticate exclusively with API keys created in the Mistral console
  ("Activate Studio and generate an API key" quickstart, "Send your first API
  request" quickstart). SSO exists only as Enterprise-plan SAML SSO for the
  Mistral *console* ("Configure SSO and domain verification" admin quickstart)
  — it is not a client OAuth grant for the inference API.

Conclusion: Mistral does not offer a public OAuth/device-code/refresh flow for
API access. There is no endpoint to build a `login`/`refreshToken` flow
against; fabricating one would be dead code that can never work.

## Decision

Do not register a pi OAuth object. Mistral access is an API-key credential
resolved through the documented chain:

1. a stored `mistral-native` API-key credential in `~/.pi/agent/auth.json`
   (written by `/login`'s guided flow, `!command` resolution supported),
2. the `MISTRAL_API_KEY` environment variable.

The provider is registered as a full native pi-ai `Provider` whose
`ApiKeyAuth` (extensions/mistral/auth.ts) owns `login`, `resolve` and
`check`: `resolve()` natively implements the chain (returning `undefined`
when both sources are missing, per pi-ai's provider contract). Two edge
semantics match pi-ai's canonical `envApiKeyAuth`: (a) a stored
credential whose `key` is undefined or empty (a hand-edited auth.json
entry) falls through to the env var; (b) an unconfigured provider resolves
`undefined` instead of throwing a generic resolution error. The stored
credential's provider env (`credential.env`) propagates to request
`options.env`.

`/login mistral-native` runs a **guided flow** supplied by the extension:
a `secret` prompt for the API key, then a `select` prompt for the API
region. pi drives `/login` and `/logout` end-to-end and persists the
credential itself — only the prompts come from the extension. The region
selection writes `endpoint.region` to the user-scope
`mistral-native.json` (ADR [0012](0012-selectable-region-endpoints.md));
"global" writes nothing (the no-config default). `!command` auth.json
entries are resolved by pi before the credential reaches the extension's
`resolve()`.

Nothing in the extension performs interactive network auth, so there is
no login request to cancel — abort handling remains a `streamSimple`
responsibility. No tokens exist to log; tests must still verify that no
key material leaks into output.

If Mistral later publishes OAuth endpoints, the pi `oauth` registration
surface (`ProviderConfig.oauth`) remains available as a purely additive
extension change; this ADR gets superseded by a new one.

## Consequences

- `/login mistral-native` runs the extension's guided API-key flow and
  stores the key in `~/.pi/agent/auth.json`; `/logout` removes it.
- The env-var path stays as the zero-configuration default, and
  `!command` keys (secret managers) work through pi's native resolution.
- A live OAuth smoke test is impossible (nothing to test); verification is
  the mocked credential-chain test suite.
- Risk accepted: if Mistral ships OAuth, users must switch manually via a
  new extension version rather than getting it silently.
