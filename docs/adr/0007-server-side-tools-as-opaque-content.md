# 0007. Server-side tools as opaque content

- **Status**: Trial
- **Date**: 2026-10-30

## Context

Mistral's server-side tools — `web_search`, `web_search_premium`,
`image_generation`, `code_interpreter` — custom connectors and agent mode
(`/v1/agents/completions`) integrate into the native provider. Live
probes against the Mistral API established the wire facts this decision
builds on:

- pi's agent loop (pi-agent-core `agent-loop.js:161`) executes **every**
  `toolCall` block in an assistant message client-side, regardless of the
  message's stop reason. This is the forcing constraint: any server-side
  execution mapped to a pi `toolCall` block would be executed a second
  time, locally, against a tool that does not exist on the client.
- Server-side tool execution streams as **multi-message deltas inside one
  response**: first `delta.tool_calls[]` for the server-side call (e.g.
  name `generate_image`) carrying `metadata: {tool_type,
  integration_id, locale}`, often with `finish_reason: "tool_calls"` on
  that same chunk; then chunks with `delta.role: "tool"`, the
  `delta.tool_call_id`, the executed result as `delta.content` (a JSON
  string such as `{"url":"https://..."}` or plain error text) and
  `delta.metadata.tool_call_result: {type: "success"|"error", errors?}`;
  then assistant text deltas with a higher `delta.index`; a final chunk
  carries `finish_reason: "stop"`. Later finish_reason values overwrite
  earlier ones in the stream loop.
- Chat-request tool entries are `{type:"web_search"}`,
  `{type:"web_search_premium"}`, `{type:"image_generation"}`,
  `{type:"code_interpreter"}` and `{type:"connector", connector_id:"<id-or-name>"}`
  (CustomConnector), per the vendored spec (ADR
  [0003](0003-vendored-openapi-spec.md)); the optional `tool_configuration`
  field is omitted.
- `/v1/agents/completions` (AgentsCompletionRequest) is
  `additionalProperties: false` with required `messages` and `agent_id`;
  `model`, `temperature` and `stream_options` are **not** allowed fields.
- All replay strategies for folding the executed result back into the
  assistant turn were accepted by the live API.
- Per-endpoint server-tool support is asymmetric (wire-verified
  2026-11-03 on the chat completions endpoint, models mistral-large-4 and
  zai-glm-5-3): `web_search`, `web_search_premium` and `code_interpreter`
  entries return HTTP 400 code 1800 ("WebSearchTool connector is not
  supported" etc.) — per-endpoint support, not account/tier related
  (Mistral's docs mark them Conversations/Agents-API-only);
  `image_generation` and `{type:"connector"}` entries are accepted, and
  function tools work. Connector OAuth grants are stored server-side at
  Mistral; nothing is stored locally and `auth.json` stays untouched (ADR
  [0004](0004-api-key-credential-chain-without-mistral-oauth.md)).

## Decision

- **Server-side executions fold into opaque assistant text, never pi
  `toolCall` blocks.** Each executed call becomes its own text block via
  `formatServerToolReport` (`[Mistral server-side tool: <name> — executed
  by Mistral]\nArguments: …\nResult: …`), emitted with balanced
  text_start/text_delta/text_end events as soon as the result delta (or
  the finalization pass) completes it. A mid-stream
  `finish_reason: "tool_calls"` that belongs to a server execution is
  remapped to `stop` when the final message contains no pi `toolCall`
  blocks; `rawStopReason` keeps the wire value.
- **Client function calls still map to pi `toolCall` blocks.** In
  server-tools mode, `delta.tool_calls[]` entries are first accumulated as
  pending candidates (same index/id matching as the existing tool-call
  path). A result delta or server metadata (`tool_type`/
  `integration_id`) marks a candidate as server-executed and folds it;
  candidates without either are materialized as `toolCall` blocks at the
  finalization pass (toolcall_start, one toolcall_delta with the full
  arguments, toolcall_end); the arguments are re-parsed via the same
  salvage helper pi's built-in providers use (`parseToolCallArguments`), so
  truncated or invalid argument JSON follows that salvage behavior.
- **Enablement is environment-driven** with `options.env` (pi's
  ProviderEnv) taking precedence over `process.env`:
  `MISTRAL_SERVER_TOOLS` (comma/space separated; unknown values ignored,
  never thrown), `MISTRAL_CONNECTORS`, `MISTRAL_AGENT_ID`. With none set,
  the stream behaves byte-for-byte as before; the folding logic is
  entirely gated on `serverExecutionPossible`.
- **The chat-completions request path filters entries to the supported
  set and warns about the rest.** `chatCompletionsServerToolEntries`
  sends only `CHAT_COMPLETIONS_SERVER_TOOLS` (currently
  `image_generation`) plus connector entries; the configured-but-
  unsupported types (`unsupportedChatCompletionsServerTools`) are dropped
  from the request and surface a once-per-session warning naming them and
  pointing at the alternatives — web search via the model-callable
  `mistral_web_search` pi tool, code interpreter via hosted agent mode.
  Agent mode keeps the full tool set server-side and never drops or
  warns. Web search is no longer a chat-completions entry at all: it
  ships as the `mistral_web_search` pi tool (one-shot stateless
  Conversations backend; configured search model `mistral-small-latest`,
  because `mistral-large-4` refuses builtin connectors on
  `/v1/conversations` with error 3004). A forthcoming sibling ADR owns
  the search-tool design details. Code interpreter stays
  Conversations/Agents-only for now.
- **Agent mode posts a minimal body** to `{baseUrl}/agents/completions`:
  exactly `agent_id`, `messages`, `stream: true` and `max_tokens` (the
  context-clamped value). No model, temperature, stream_options, tools or
  sampling parameters are merged — the schema rejects them.
- **Connector management is exposed as seven pi tools**
  (`extensions/tools/connectors.ts`, registered after the knowledge
  tools): `mistral_connector_list`, `mistral_connector_tools`,
  `mistral_connector_auth_url`, `mistral_connector_activate`,
  `mistral_connector_deactivate`, `mistral_connector_share`,
  `mistral_connector_unshare`. The `auth_url` is treated as a bearer URL:
  it reaches the caller via `content` and `structuredContent` only, never
  `details` (the same content/details split as the signed URLs in ADR
  [0006](0006-knowledge-api-tools.md)); connector OAuth grants live on
  Mistral's side, `auth.json` is unchanged (ADR
  [0004](0004-api-key-credential-chain-without-mistral-oauth.md)).

## Consequences

- The transcript stays **portable**: a server-executed tool appears as
  ordinary assistant text, which replays cleanly through any provider
  and does not re-trigger pi's client-side execution loop. The trade-off
  is that the report format is prose, not structured tool-call data —
  programmatic consumers must parse the report text or use the wire
  events' `onProviderStreamEvent` hook.
- No client-side execution loop runs for server tools; the model's follow-up
  text arrives in the same response, so latency for e.g. image generation
  is one streamed request.
- Enabling server tools is a per-environment opt-in; nothing changes for
  existing users who set none of the three variables.
- Limitations: `web_search`, `web_search_premium` and `code_interpreter`
  are not sent to chat completions (HTTP 400 code 1800 there —
  Conversations/Agents-API-only, per-endpoint support verified on two
  models); their request declaration and folding paths remain covered by
  mocked tests modeled on the recorded `image_generation` wire shape.
  Web search moved to the `mistral_web_search` pi tool; code interpreter
  runs in hosted agent mode. Agent mode does not merge sampling
  parameters or reasoning effort — an agent's server-side configuration
  wins; revisit if the Agents API grows those fields. Connector tool
  *invocations* happen server-side inside chat completions
  (`{type:"connector"}` entries); the seven pi tools manage connectors
  only.

- The same connectors also have a **client-side execution model**
  (ADR [0011](0011-client-side-connector-tools.md)): the loader tool
  `mistral_connector_load` registers an authenticated connector's MCP
  tools as client-side callable pi tools. This ADR governs server-side
  refs (`{type:"connector"}` entries); ADR 0011 documents when each
  execution model is preferable.
