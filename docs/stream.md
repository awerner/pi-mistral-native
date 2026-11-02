# Chat streaming (`mistral-chat`)

## What you can do

- **Chat with any Mistral model** — pick a `mistral-native/…` model in
  pi and talk to it; everything else works as with any pi model.
- **Reason with full visibility** — reasoning models stream their
  thinking into pi's thinking blocks, so you see the reasoning process
  unfold, collapsible, next to the answer.
- **Use tools mid-chat** — function/tool calls assemble reliably,
  including parallel calls; results feed straight back into the
  conversation.
- **See what it costs** — usage and cost are accounted per response,
  priced from the model catalog's current rates (see
  [catalog.md](catalog.md)).
- **Trust cancellation and limits** — abort a generation and the
  partial answer stays; overflowing the context window triggers
  compaction instead of a cryptic error; transient server failures
  retry automatically.

No configuration needed — the Quickstart in the
[README](../README.md#quickstart) is all it takes.

*Decisions: [ADR 0014 — Content chunk coverage: map or reject, never drop](adr/0014-content-chunk-coverage.md)*

## How it works

The provider registers a custom pi API id, `mistral-chat`, and
implements it natively: pi's chat runs directly against Mistral's
chat-completions streaming endpoint, with full support for reasoning
models, tool calls, usage and cost accounting.

### Reasoning: thinking and text as proper content blocks

Mistral's reasoning models stream their content as a **typed block
array** — `thinking` and `text` entries mixed in one delta — instead of
a plain string. The stream handles both shapes: a plain string appends
to the text; array entries route by type, thinking entries join a
single thinking block, text entries append to the text block, and
reference entries append citation markers (the docs.mistral.ai
citations flow). The assembled message exposes pi's `thinking` and
`text` content blocks; empty parts never create stray blocks.

Every other content-chunk type — and any unknown type — is rejected
with a clear error naming the type: no silent content loss.

*Decisions: [ADR 0014 — Content chunk coverage: map or reject, never drop](adr/0014-content-chunk-coverage.md)*

### Tool calls

`delta.tool_calls` entries arrive incrementally: a first delta carries
the call `id` and function `name`, subsequent deltas only argument
fragments. Calls are assembled by stream `index`, the partial JSON
arguments accumulate per block, and the completed tool-call block at
the end of the stream carries parsed arguments. Parallel calls
interleave safely. Finish reasons map onto pi's stop reasons
(`content_filter` becomes an error stop, and so on).

### Usage and cost

Each stream carries a usage object that maps to pi's `Usage` — input
tokens excluding cached tokens, output, cache reads/writes and
reasoning tokens — and cost is computed from the model's rate card
(see [catalog.md](catalog.md)).

### Context overflow

When a request exceeds the model's context window, the stream
normalizes Mistral's varying error wording into the
`context_length_exceeded` marker, so pi reliably detects the overflow
and triggers compaction. Rate limits and other transient failures
deliberately do not match.

### Aborts and retries

Cancellation never depends on the server closing the connection: an
abort fires the terminal error event with stop reason `aborted`, keeps
the partial message, and a stalled transport can never hang the
consumer. Transient failures (timeouts, 429s, 5xx, network errors)
retry with interruptible exponential backoff honoring `retry-after`,
mirroring pi's built-in provider policy.

## Advanced: why the stateless GA endpoint (not the Conversations API)

pi's built-in Mistral provider runs on the stateful Conversations API,
where the conversation history lives server-side; Mistral classifies
that API as Beta/Public Preview — no stability commitment on its
server-side state. Two independent documented incidents on that path
share one fingerprint: mid-session, the server begins replaying
**stale tool calls** — a fresh, unique tool-call ID and response ID
(a new provider response, not a client-side retry), but the *verbatim
name and argument bytes of a retired call from an earlier turn* —
while the surrounding thinking blocks regenerate fresh and correct. In
one incident the replayed calls re-emitted a previously-posted comment
body character-for-character while the model's own reasoning planned an
unrelated action, producing duplicated side effects; in the other,
retired arguments arrived 24 times in one response and were stopped
only by an external guard layer.

The evidence places the corruption server-side, beyond any client
parser: the client cannot fabricate old argument bytes (the deltas
arrived on the wire), and the token profile shows tiny per-request
input (a few hundred tokens) alongside cache reads of up to ~225k —
the conversation history demonstrably lived on the server, so a
corrupted state/prefix-cache segment there is what re-emits the stale
call. The bug is conversations-API-generic, not model-specific: it
recurred under two different model families, so switching models does
not avoid it.

pi-mistral-native therefore runs agent sessions on the stateless GA
`/v1/chat/completions` endpoint, sending the full history in every
request: there is no server-side conversation state to corrupt, and
nothing stale to replay. Billing is identical — the same rate card
applies, and cached input is billed at ~10% of the input rate on both
paths.

Operational rule of thumb: on a stateful conversation path, tiny
per-request input combined with a huge cache read means the history
lives server-side — duplicated side effects there are provider-state
corruption, not an agent bug.

*Decisions: [ADR 0008 — Direct fetch over vendor SDK](adr/0008-direct-fetch-over-vendor-sdk.md)*

## Advanced: request shape

Requests are `POST {baseUrl}/chat/completions` with `stream: true` and
`stream_options: { include_usage: true }`, authenticated with a
`Bearer` API key (see [auth.md](auth.md)). Deltas arrive as
server-sent events; each `data:` payload is a `CompletionChunk`
terminated by the `data: [DONE]` sentinel.

*Why no official Mistral SDK?* The stream deliberately uses direct
`fetch`/SSE instead of `@mistralai/mistralai`: pi's provider contract
needs the raw SSE events the SDK's `AsyncIterator` abstraction hides,
the block-array thinking mapping is this package's core
differentiator, and a plugin that installs into foreign pi sessions
carries zero transitive dependencies as a feature (supply-chain
exposure included).

*Decisions: [ADR 0008 — Direct fetch over vendor SDK](adr/0008-direct-fetch-over-vendor-sdk.md)*

## Advanced: event protocol

The stream follows pi's custom-streaming contract exactly:

1. one `start` event carrying the partial assistant message (after
   authentication and request building succeeded),
2. balanced block events — `text_start/delta/end`,
   `thinking_start/delta/end`, `toolcall_start/delta/end` — each
   referencing a `contentIndex` and carrying the *updated* partial
   message,
3. exactly one terminal event: `done` (with the final message) or
   `error`.

A stream that ends without a `finish_reason` fails with an error
rather than silently truncating, and malformed SSE data throws (never
yields a half-parsed message).

## Advanced: thinking-block details

The provider signature, when present, is carried onto the thinking
block; nested thinking parts map the same way inside the thinking
text; a single delta may contain thinking and text parts in any order.
The chat variants (`image_url`, `document_url`, `file`, `input_audio`,
`resource`, `resource_link`) are the chunk types rejected loudly.

## Advanced: usage mapping details

The usage object is read from the chunk or the choice (some gateways
use the latter); `input` excludes cached tokens (`prompt_tokens` minus
cached/read and cache-write tokens, read defensively from
`prompt_tokens_details` or the Mistral-gateway field variants); cost is
computed with pi's `calculateCost`.

## Advanced: overflow and retry details

Matching error patterns include "too large for model", "maximum context
length", "exceeds the context window/length/size"; unrecognized finish
reasons map to an `error` stop reason (`stop`/`end`→stop,
`length`/`model_length`→length, `function_call`/`tool_calls`→toolUse,
`content_filter`→error). Every body read races against the caller's
abort signal, the body is cancelled when it fires, and per-attempt
timeouts abort only the attempt. Retries cover 408/409/429/5xx and
network errors.

## Advanced: compat flags and reasoning effort

`mistral-large-4`'s static catalog entry declares Mistral's wire
differences via `compat`:

- `supportsDeveloperRole: false` — no developer role in messages,
- `supportsStore: false` — no `store` request field,
- `supportsMidConvoSystemMessages: false` — system messages are
  collapsed to a single leading one (the transcript is normalized with
  `resolveTranscript` accordingly).

pi's thinking levels map to Mistral's `reasoning_effort` request field
via the model's `thinkingLevelMap` (e.g. `off` → `"none"`, `high` →
`"high"`); unsupported levels are clamped by pi-ai, unmapped levels
fall back to the server default. `reasoning_effort` is only sent for
models flagged `reasoning`.

## Notes

- **Wire-format reference:** the wire format is implemented against the
  vendored OpenAPI spec, the authoritative reference for every type
  named in this document.
- **Server-side tools, agent mode, region:** server-side tools
  (`serverTools`, `connectors`) and agent mode (`agentId`, configured
  via [mistral-native.json](configuration.md)) ride along on the
  chat-completions request; their configuration is resolved per call
  from the effective config. Region-wise, plain chat routes to the
  configured regional endpoint, while **server-execution surfaces are
  global-only** — server-side tools, connectors and agent mode post to
  the global `api.mistral.ai/v1` when a region is configured (the
  Files, Agents and Batch APIs are not available regionally), as do the
  knowledge APIs and connector management. An explicit
  `endpoint.baseUrl` (gateway escape hatch) applies to every chat mode
  instead. A regional setting warns once per session start about this
  split (see [configuration.md](configuration.md) and
  [server-tools.md](server-tools.md)).

*Decisions: [ADR 0007 — Server-side tools as opaque content](adr/0007-server-side-tools-as-opaque-content.md); [ADR 0012 — Selectable region endpoint with per-family routing](adr/0012-selectable-region-endpoints.md)*
