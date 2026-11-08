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
call. The same probing also established the forcing lever: the top-level
`instructions` string field — declared in the vendored spec's
ConversationRequestBase — is wire-verified accepted and effective on the
live Beta endpoint, while hard forcing is unavailable —
`completion_args.tool_choice`
"any" is 422-rejected (`Input should be 'auto', 'none' or 'required'`;
the live endpoint is narrower than the vendor spec's ToolChoiceEnum) and
"required" is 422-rejected (`Can't set 'tool_choice' to 'required' when
using built in connectors.`). The server-side agent also sometimes
silently skips executing the search connector: `outputs[]` then carries
only the `message.output` entry, with no `tool.execution` — on the wire
indistinguishable from zero hits. The model matrix is asymmetric:
`mistral-small-latest`, `mistral-medium-latest` and
`magistral-medium-latest` run the search tool on `/v1/conversations`,
while `mistral-large-4` refuses builtin connectors there (400
`invalid_request_error`, code 3004).

The provider's chat path stays on stateless GA Chat Completions by design
(ADR [0002](0002-mistral-native-provider-for-pi.md)) — the Beta
Conversations API's server-side conversation state is exactly what the
native provider avoids. So web search cannot ride the chat stream, and it
cannot reuse the chat model either.

## Decision

Web search ships as one client-side pi tool, `web_search`
(`extensions/tools/web-search.ts`), running **stateless one-shot
Conversations calls**: a fresh `POST /v1/conversations` with
`inputs: [{role:"user", content: <query>}]`, `tools:
[{type:"web_search"}]`, `stream: false`, `store:
false` and a fixed top-level `instructions` string — "Always use the
<tool> tool to search the web before answering. Never answer from
memory." with the tool type substituted. Since `tool_choice` hard
forcing is 422-rejected for builtin connectors, `instructions` is the
only lever to make the server-side agent run the search; it is
probabilistic (LLM instruction-following), not a guarantee. The
returned `conversation_id` is discarded — the tool never continues a
conversation.

- **Parsing**: the `tool.execution` entry's `info.result` JSON string is
  parsed defensively; the hit map's values map to `{url, title,
  description (omitted when null), snippets[]}` in the tool result
  (structured `hits`). The `message.output` entry is discarded — only the
  hits are the tool's payload. The two empty outcomes are distinct
  result texts: a missing `tool.execution` entry means the backend
  skipped the search and yields an ok result whose text reports the skip
  (retry-worthy, never "no results found"), while a `tool.execution`
  entry with an empty hit map is a genuinely executed search with zero
  hits and keeps the "returned no results" ok result. Neither is an
  error. Usage maps onto the tool result like the RAG path; cost stays
  0.
- **Search model**: separate from the chat model, configurable via the
  `knowledge.searchModel` config key; the default is
  `mistral-small-latest`. A 400 with code 3004 (the refusal of
  models without builtin-connector support) maps to a friendly error
  naming the key and the default, not a raw dump — warn-on-unknown model
  ids happens at use time, not at config validation.
- **Premium as a separate tool**: superseded — premium search quality
  is now a boolean `premium` parameter of the single `web_search` tool
  (default `false`), routing to the `web_search_premium` tool type per
  call; see ADR [0024](0024-web-search-canonical-name-and-premium-flag.md).
  The deliberate opt-in is preserved: the pay-per-use cost warning
  appears in both the tool description and the `premium` parameter
  description. Both variants share the exact same request and parsing
  path; only the tool type differs.
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
- Forcing the search is probabilistic: the `instructions` string steers
  the server-side agent but cannot guarantee execution, so the skip
  detection (the distinct skipped-search result) remains the safety net —
  a caller can tell a retry-worthy skip from a genuinely empty result.
- The Conversations call is Beta-endpoint usage — but stateless and
  one-shot (`store: false`, conversation discarded), so no server-side
  conversation state can corrupt anything.
- Future: the `code_interpreter` analog can follow the same
  stateless one-shot Conversations shape (the remaining
  Conversations/Agents-only tool).
