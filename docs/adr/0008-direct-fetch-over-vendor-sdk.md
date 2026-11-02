# 0008. Direct fetch over vendor SDK

- **Status**: Trial
- **Date**: 2026-10-31

## Context

Mistral's official documentation uses the vendor SDK
(`@mistralai/mistralai`) in most code examples, and the question arose
whether this package should adopt it as a runtime dependency instead of the
direct `fetch`/SSE implementation. The SDK (v2.7.0 at the time of the
review) is ESM-only and pulls in Zod v4 as a transitive dependency. The
review concluded against adoption, for five reasons:

1. **pi's provider contract needs low-level stream control.** `streamSimple`
   must emit pi's raw event protocol (a `start` event, block events carrying
   the updated partial message, a `done`/`error` terminal, plus
   `onProviderStreamEvent` and `onPayload` callbacks), keep content blocks
   updated before each emission, and guarantee abort determinism through
   `reader.cancel()`.
   The SDK abstracts SSE into an `AsyncIterator` of assembled chunks — it
   hides exactly the events the provider contract must emit. Adopting it
   would mean working against the abstraction, not with it.
2. **Block-array thinking content is this package's core differentiator**
   (ADR [0002](0002-mistral-native-provider-for-pi.md) —
   the reason it exists). The SDK types `delta.content` generically and does
   not expose the block-array/thinking mapping pi requires; the block-array
   thinking mapping would still be unsolved with the SDK.
3. **Footprint and supply chain.** The package installs into foreign pi
   sessions (`pi install npm:pi-mistral-native`). Zero transitive
   dependencies is a feature there; the SDK adds Zod v4 and its tree. The
   May 2026 npm supply-chain attack against the Mistral SDK packages
   (advisory MAI-2026-002: malicious `@mistralai/mistralai`
   2.2.2–2.2.4 published May 11, 2026, as part of the wider "Mini
   Shai-Hulud" campaign; the PyPI counterpart `mistralai` 2.4.6 actively
   stole credentials) is a documented risk factor for plugin-style
   consumers — every runtime dependency widens the blast radius of such
   incidents.
4. **Wire stability.** The chat-completions API is OpenAI-compatible and
   stable; drift is covered by the vendored OpenAPI spec (ADR
   [0003](0003-vendored-openapi-spec.md)) and the mocked-SSE test suite
   (ADR [0004](process/0004-mocked-sse-test-suite.md)).
5. **Escape hatch.** If Mistral adds endpoints where the SDK would be
   materially more convenient (batch, realtime, multipart upload), that
   decision is made per endpoint — see the rule below.

## Decision

Keep the direct `fetch`/SSE implementation against the vendored OpenAPI
spec; do **not** adopt `@mistralai/mistralai` as a runtime dependency. All
Mistral endpoints this package talks to are implemented as plain `fetch`
requests with hand-rolled SSE parsing and wire types verified against
`vendor/mistral-openapi.yaml`.

The SDK question is decided **per endpoint, not wholesale**: adopting the
SDK for a future endpoint requires that (a) pi's provider/tool contract does
not need the raw events the SDK would hide, and (b) the endpoint's
convenience gain outweighs the added dependency footprint in foreign pi
sessions. If that ever happens, write a new ADR superseding the affected
part of this one.

## Consequences

- **Easier:** zero runtime/transitive dependencies in the published package;
  full control over SSE events, abort semantics, and wire types; supply-chain
  exposure limited to Node's built-in `fetch`; wire drift caught by the
  vendored spec and test suite.
- **Harder:** every Mistral wire change must be implemented and typed by
  hand here first, instead of arriving with an SDK update; SDK-only
  endpoints (batch, realtime, multipart upload) start as fetch work when
  adopted.
- **Known risk accepted:** if Mistral ships a breaking chat-completions
  change without OpenAPI-spec-visible notice, this package reacts via the
  vendored-spec refresh and test suite rather than waiting for an SDK
  release. The per-endpoint escape hatch above bounds this commitment.
