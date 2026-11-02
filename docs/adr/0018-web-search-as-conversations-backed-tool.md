# 0018. Web search as a Conversations-backed tool

- **Status**: Trial
- **Date**: 2026-11-03

## Context

Chat Completions supports only a subset of Mistral's server tools
(wire-verified 2026-11-03): `web_search`, `web_search_premium` and
`code_interpreter` are rejected there with HTTP 400 code 1800 — Mistral
marks them Conversations/Agents-API-only. Requesting web search through a
configured `serverTools` entry therefore failed every chat request. The
owner's decision: web search must work. The same probing session fixed the
request facts for the Conversations endpoint: the request body uses
`inputs[]` (the endpoint rejects `messages` as `extra_forbidden`), a
response carries `outputs[]` with a `tool.execution` entry (whose
`info.result` is a JSON string of hits keyed by opaque ids) plus a
`message.output` entry, and `store: false` yields a stateless one-shot
call. The model matrix is asymmetric: `mistral-small-latest`,
`mistral-medium-latest` and `magistral-medium-latest` run the search tool
on `/v1/conversations`, while `mistral-large-4` refuses builtin
connectors there (400 `invalid_request_error`, code 3004).

The provider's chat path stays on stateless GA Chat Completions by design
(ADR [0002](0002-mistral-native-provider-for-pi.md)) — the Beta
Conversations API's server-side conversation state is exactly what the
native provider avoids. So web search cannot ride the chat stream, and it
cannot reuse the chat model either.

## Decision

Web search ships as two client-side pi tools,
`mistral_web_search` and `mistral_web_search_premium`
(`extensions/tools/web-search.ts`), each running a **stateless one-shot
Conversations call**: a fresh `POST /v1/conversations` with
`inputs: [{role:"user", content: <query>}]`, `tools:
[{type:"web_search"|"web_search_premium"}]`, `stream: false` and
`store: false`. The returned `conversation_id` is discarded — the tool
never continues a conversation.

- **Parsing**: the `tool.execution` entry's `info.result` JSON string is
  parsed defensively; the hit map's values map to `{url, title,
  description (omitted when null), snippets[]}` in the tool result
  (structured `hits`). The `message.output` entry is discarded — only the
  hits are the tool's payload. A missing `tool.execution` entry or zero
  hits (the backend decided not to search) is an ok result with
  `hits: []`, never an error. Usage maps onto the tool result like the
  RAG path; cost stays 0.
- **Search model**: separate from the chat model, configurable via the
  `knowledge.searchModel` config key; the default is
  `mistral-small-latest`. A 400 with code 3004 (the refusal of
  models without builtin-connector support) maps to a friendly error
  naming the key and the default, not a raw dump — warn-on-unknown model
  ids happens at use time, not at config validation.
- **Premium as a separate tool**: `mistral_web_search_premium` exists so
  the caller opts in deliberately — its description states the premium
  quality is pay-per-use. Both variants share the exact same request and
  parsing path; only the tool type differs.
- The chat path is untouched: Chat Completions requests never declare
  web search (ADR
  [0007](0007-server-side-tools-as-opaque-content.md) filters the
  unsupported entries with a visible warning), and the client-side loader
  pattern (ADR
  [0011](0011-client-side-connector-tools.md)) is not used — the search
  tools are static, registered unconditionally.

## Consequences

- Web search works on every model the chat stream can use: the search
  runs under the search model's capabilities, not the chat model's.
- Search cost is **pay-per-use via `connector_tokens`** — not priceable
  in the local cost display (the tool-result cost stays 0; the token
  counts are surfaced). Premium search costs extra per call.
- The search model intentionally differs from the chat model: on
  `mistral-large-4` sessions the search still runs
  (`mistral-small-latest` by default) even though the chat model refuses
  builtin connectors.
- The Conversations call is Beta-endpoint usage — but stateless and
  one-shot (`store: false`, conversation discarded), so no server-side
  conversation state can corrupt anything.
- Future: the `code_interpreter` analog can follow the same
  stateless one-shot Conversations shape (the remaining
  Conversations/Agents-only tool).
