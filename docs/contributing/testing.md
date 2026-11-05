# Testing

All tests run offline against mocked HTTP layers — no network access, no
real API keys (the literal `test-key` only). The provider stream is tested
against a mocked SSE (`text/event-stream`) harness, which drives the six
recorded Mistral streaming scenarios this extension replaces.

```bash
npm run check      # tsc --noEmit — type check
npm test           # build + node --test dist/test/*.test.js
```

CI (`.github/workflows/ci.yml`) runs the same two commands on every push
and pull request.

## Suites

| Suite | Scope |
|---|---|
| `test/mistral.test.ts` | The native `mistral-chat` stream: the six ported repro scenarios (block-array thinking, string regression, empty-thinking skip, tool-call regression, same-delta thinking+text, signature), pi's custom-provider event protocol, usage/cost, abort (incl. mid-tool-call and stalled transport), overflow normalization, malformed/truncated streams, Unicode boundaries, retry, request mapping, the dynamic catalog (`refreshModels` phases, rate card, filtering), and region routing/surcharge (per-family chat URLs incl. gateway/`model.baseUrl` precedence, provider-scoped `MISTRAL_REGION`, regional catalog fetch, +10% cost mapping, and the session-start region notice). |
| `test/integration.test.ts` | The custom-provider checklist gaps: image input and image tool results, orphaned tool calls after an abort, cross-provider session handoff (foreign-api assistant turns and tool results replay), capability-gated image support on text-only models, thinking-block replay suppression, zeroed usage without a usage chunk, gateway choice-level usage, and the `max_tokens` context clamp. |
| `test/auth.test.ts` | The API-key credential chain in three layers: the real extension registration, pi's real provider composer (precedence, `/login` flow), and contract pins of the documented fallback chain; plus static guards over the compiled extension (no OAuth remnants, no logging sinks). |
| `test/knowledge.test.ts` | The four knowledge tools (OCR, embeddings, moderations, classifications): request mapping, result shaping, error paths, abort forwarding, auth precedence. |
| `test/knowledge-tools.test.ts` | The nine library/RAG tools: multipart uploads, pagination, status enrichment, signed URLs (never logged), reprocess, RAG query mapping, error bodies, API-key absence. |
| `test/config.test.ts` | The `mistral-native.json` configuration layer: user-scope resolution chain (each hop, first existing wins), project scope and project-over-user merge, JSON-over-env precedence, config-value protocol (`$VAR`, `${VAR}`, `!cmd`, escapes), strict validation with named-path errors (loader warns, never throws), reserved-and-parsed sections incl. `MISTRAL_REGION`, region resolution and the surcharge multiplier (`resolveMistralRegionBaseUrl` precedence incl. empty/whitespace values, `MISTRAL_REGION_BASE_URLS` mapping, `applyRegionSurcharge` purity/rounding), and stream integration with an injected file config. |
| `test/commands.test.ts` | The `/mistral` command family: status-card provenance, scope-aware `set` (user scope default, `--project` with trust refusal), atomic write-then-verify with validation refusals, list `+`/`-` mutation, value completion with full-argument item values, and the real pi-tui autocomplete provider driven for natural-typing and forced-Tab regression (applying a suggestion never drops preceding tokens). |

*Decisions: [ADR 0004 — API-key credential chain without Mistral OAuth](adr/0004-api-key-credential-chain-without-mistral-oauth.md); [ADR 0005 — OCR, embeddings, moderations/classifications as pi tools](adr/0005-ocr-embeddings-moderations-as-pi-tools.md); [ADR 0006 — Knowledge API tools](adr/0006-knowledge-api-tools.md); [ADR 0010 — Configuration via mistral-native.json](adr/0010-configuration-via-mistral-native-json.md); [ADR 0012 — Selectable region endpoint with per-family routing](adr/0012-selectable-region-endpoints.md); [ADR 0016 — `/mistral` command family: show, set, test](adr/0016-mistral-command-family.md); [ADR 0022 — Project-scope writes and list mutation for `/mistral set`](adr/0022-mistral-set-scope-and-list-mutation.md)*

## Custom-provider checklist coverage

pi's `custom-provider.md` ("Test the integration") lists the scenarios a
provider must cover; the two stream suites map to it as follows:

| Scenario | Where |
|---|---|
| Ordinary text responses | `mistral.test.ts` — "plain-string content still parses (regression)" |
| Empty text responses | `mistral.test.ts` — "empty response content produces an empty message with stop reason" |
| Tool calls and tool results | `mistral.test.ts` — streaming assembly, split deltas, parallel calls, replay; `integration.test.ts` — orphaned calls, foreign-provider round-trip |
| Image input (when supported) | `integration.test.ts` — user image blocks → data-URL parts; dropped on text-only models |
| Image tool results (when supported) | `integration.test.ts` — following user message with `image_url` parts; placeholder on the tool message |
| Usage and cost accounting | `mistral.test.ts` — cached-token usage and cost; `integration.test.ts` — zeroed usage without a usage chunk, gateway choice-level usage |
| Abort behavior | `mistral.test.ts` — abort → aborted result, mid-tool-call scratch stripping, stalled transport |
| Context overflow | `mistral.test.ts` — `context_length_exceeded` normalization (+ rate-limit negative) |
| Malformed or partial streams | `mistral.test.ts` — malformed JSON, missing `finish_reason`, truncated body |
| Unicode boundaries | `mistral.test.ts` — emoji surrogates across chunk boundaries |
| Cross-provider session handoff | `integration.test.ts` — foreign-api assistant + tool results replay |
| Authentication refresh and cancellation | N/A — the provider is API-key only (`test/auth.test.ts` covers the chain, `mistral.test.ts` covers abort of the model-catalog refresh). Live OAuth semantics do not exist for Mistral's API. |

*Decisions: [ADR 0004 — API-key credential chain without Mistral OAuth](adr/0004-api-key-credential-chain-without-mistral-oauth.md)*

## Live verification

The mocked suite pins the wire format against the vendored OpenAPI spec;
live-API behavior (actual
Mistral streaming quirks, rate limits, catalog contents) is verified
manually — CI never contacts `api.mistral.ai`.

*Decisions: [ADR 0003 — Vendored OpenAPI spec](adr/0003-vendored-openapi-spec.md)*

## Live smoke test

`scripts/smoke-test.mjs` runs the four live checks end-to-end against the
locally built package and reduces every result to a pass/fail line (exit 0/1):

```bash
npm run build                              # dist/ must exist
node scripts/smoke-test.mjs                # all four scenarios
node scripts/smoke-test.mjs --skip=rag     # subset; comma-separated
```

| Scenario | What it proves |
|---|---|
| `stream` | `pi -p --provider mistral-native --model mistral-large-4 --thinking high` streams clean text, executes a bash tool call in the same turn, and never leaks `[object Object]` |
| `rag` | A throwaway file is uploaded to a fresh library; `mistral_document_query` (streaming default) retrieves the planted phrase through the model; the library is deleted afterwards |
| `catalog` | `pi --list-models` lists the live `mistral-native` catalog (≥ 5 models; the static fallback is 1) and `GET /v1/models` answers 200 |
| `ocr` | One live `mistral_ocr` call on a tiny embedded PNG fixture returns the planted marker |

Key requirements (the script reads neither key material nor raw responses
into its output):

- A working Mistral API key available to pi: a stored `mistral-native`
  credential in `~/.pi/agent/auth.json` (via `/login`) or `MISTRAL_API_KEY`
  in the environment. With neither, the script fails fast.
- The key is passed only to pi child processes and the `Authorization` header;
  it is never printed, logged, or committed.
- The RAG scenario creates real Mistral-side artifacts (library + document)
  and deletes the library in a `finally` block; run it only against an
  account whose quota/billing tolerates a few billable OCR and
  document-indexing calls.
