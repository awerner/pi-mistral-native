# 0002. Mistral-native provider for pi

- **Status**: Trial
- **Date**: 2026-10-30

## Context

pi's built-in Mistral paths fall short in four documented ways: the generic
OpenAI-completions adapter cannot parse the block-array thinking content
that Mistral's chat-completions API streams, the Le Chat conversations API
runs on stateful beta conversation state, the model list is static and
hand-maintained, and none of Mistral's non-chat surface (knowledge/RAG,
OCR, connectors, server-side tools) is reachable. The interim fix in pi's
ecosystem was a hand-patch applied into `node_modules` — fragile and lost
on every pi update. pi's provider-extension API offers a supported native
path: a registered provider with a custom `api` string and its own
`streamSimple` wire handler.

## Decision

Ship this package as a Mistral-native provider extension for pi: a
Mistral-specific, optimized, full-feature-surface integration. The
extension registers a native pi-ai provider (`buildMistralNativeProvider`,
api `mistral-chat`) implementing the block-array chat-completions wire
format against the vendored OpenAPI spec
([0003](0003-vendored-openapi-spec.md)), with dynamic model-catalog
refresh and the whole non-chat surface exposed as pi tools. Distribute it
as a pi npm package (`pi install npm:pi-mistral-native`).

## Consequences

- Provider behavior survives pi updates (the extension is loaded, not
  patched in), and is versioned, reviewed and tested like any code.
- The wire format is our own implementation: it must be kept current with
  Mistral's spec ourselves and covered with tests.
- `streamSimple` owns request conversion, streaming events, usage and cost
  accounting, cancellation and error normalization per pi's
  custom-provider contract — more surface than delegating to a built-in
  API implementation, but no built-in implementation speaks the
  block-array chat-completions format with thinking content.
