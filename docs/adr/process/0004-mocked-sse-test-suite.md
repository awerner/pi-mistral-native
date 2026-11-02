# 0004. Mocked-SSE test suite and user docs

- **Status**: Trial
- **Date**: 2026-11-01

## Context

pi's custom-provider checklist demands integration coverage of the
provider contract — streaming events, tool calls, usage, abort, overflow,
malformed streams, auth. Live-API testing is impossible in CI: it needs a
real Mistral API key (never available to CI), network access (varies), and
a deterministic upstream — none of which hold. The wire-format behaviors
under test (block-array thinking content, split tool-call deltas) were
verified against the live API before being pinned in mocks.

## Decision

All provider-stream tests run against a **mocked SSE/fetch layer** — no
network, no real keys. Test doubles inject `fetch` (the provider's
`streamSimple` and every tool client accept a fetch implementation) and feed
hand-built `text/event-stream` bodies that mirror the vendored spec (ADR
[0003](../0003-vendored-openapi-spec.md)). The test files map:

| File | Covers |
|---|---|
| `test/mistral.test.ts` | chat stream (block thinking, tool calls, usage/cost, overflow, abort, unicode, retries, malformed streams) + model catalog (`mapModelList`, `refreshModels` phases) |
| `test/auth.test.ts` | the 3-layer auth chain: pi composer resolution, the documented fallback chain, `!command` credentials — plus static guards (no OAuth remnants, no logging sinks) |
| `test/knowledge.test.ts` | the four architecture ADR 0005 tools (OCR, embeddings, moderations, classifications) with mocked HTTP |
| `test/knowledge-tools.test.ts` | the nine architecture ADR 0006 library/RAG tools with mocked HTTP |
| `test/integration.test.ts` | gap scenarios from pi's custom-provider checklist (e.g. image input, image tool results, orphaned tool calls, cross-provider handoff, the max_tokens context clamp) not covered above |

User documentation ships alongside: a README plus one concise feature page
per area under `docs/`, linking the ADRs. CI runs `npm run check`
(`tsc --noEmit`) and `npm test` (build + `node --test`); tests are compiled to
`dist/test/` and run from there.

## Consequences

- Live behavior is verified **manually**; CI proves only what the mocks pin.
- Wire-format drift is caught only when the vendored spec or the tests are
  updated — the mocked layer encodes today's spec, not Mistral's actual
  behavior.
- The mocked SSE/fetch layer pins Node/undici `Response` semantics (body
  readers, signal propagation), so runtime changes in Node's fetch can fail
  tests that are not provider regressions.
- No secrets ever enter the suite: key values in tests are synthetic, and
  static guards assert the compiled extension contains no logging sinks.
