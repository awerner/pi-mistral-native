# 0015. Streaming RAG document query

- **Status**: Trial
- **Date**: 2026-10-31

## Context

ADR [0006](0006-knowledge-api-tools.md) implemented
`mistral_document_query` as a **non-streaming** `POST /v1/chat/completions`
call with the `document_library` tool. Long answers block the tool call
behind the complete completion; routing the RAG query through a
streaming request removes that block.

The decisive constraint is pi's tool contract. `AgentTool.execute` returns
**one** `AgentToolResult` message that becomes exactly one model-facing
tool result; there is no progressive model-facing output surface for tools
(verified against pi 1.4.0, `pi-agent-core/dist/types.d.ts` and the agent
loop). "Stream into the pi session as it generates" in the model-facing
sense is therefore **not possible without inventing API beyond pi's
contract**.

What pi 1.4.0 *does* offer:

- `AgentToolUpdateCallback` (the 4th `execute` parameter): a partial-result
  channel wired end-to-end through `tool_execution_update` events to the
  TUI, which renders partial results as a pending tool preview
  (`ToolExecutionComponent.updateResult(..., isPartial=true)`; calls after
  the tool promise settles are ignored by the runtime).
- A per-call `AbortSignal` (3rd parameter) the tool is expected to forward
  to its transport.
- `AgentToolResult.usage`: tool-execution usage that pi accounts in
  session statistics separately from main LLM context usage.

## Decision

1. **Streaming-over-one-shot for the RAG path.**
   `mistral_document_query` consumes a streaming
   `POST /v1/chat/completions` request (`stream: true`,
   `stream_options: {include_usage: true}`) with the same request mapping
   as before — the `document_library` tool declaration included. The SSE
   body is assembled internally; at stream end the complete
   chunks + citations mapping of ADR 0006 applies **unchanged** (one shared
   assembly function serves both paths, so their results are identical by
   construction). This stays inside the knowledge-tools client
   (`extensions/tools/mistral-client.ts`); the native `streamSimple`
   internals in `extensions/mistral.ts` are deliberately untouched — the
   RAG path needs its own thin SSE consumer, not the provider's
   message-replay machinery.

2. **The pi-tool constraint is recorded as scope, not worked around.**
   The model still receives one complete result. The honest statement is:
   streaming buys the tool (a) abort semantics — the per-call abort signal
   cancels the transfer mid-stream and the tool returns an error result,
   never a partial answer (two shapes are reachable and both are error
   results: the polite shape with `details.aborted` when the generator
   ends after abort, and the transport AbortError through the generic
   failure path when abort rejects an in-flight body read — which one
   appears is timing-dependent, by accepted design); (b) token usage from
   the stream's terminal chunk carried on `AgentToolResult.usage` — token
   counts only; the tool carries no cost model, so pi session statistics
   show the RAG query's tokens with zero cost, a deliberate bound (the
   one-shot path discarded usage entirely); (c) in-stream failures surface
   loudly: a `finish_reason: "error"` choice (vendored
   CompletionResponseStreamChoice enum) or an `error` object inside a 200
   SSE event fails the tool result — an API failure is never reported as
   an empty-but-successful retrieval; and (d) the verified `onUpdate`
   preview channel: the tool pushes growing partial text as plain partial
   results, so the session UI shows the answer while it generates. No API
   beyond pi's contract is invented.

3. **Abort forwards to the stream.** The tool's abort signal is passed
   into the SSE reader; on abort the body read is cancelled and the tool
   returns an `isError` result describing the abort (`details.aborted`),
   not the partial text.

4. **Config toggle, default on.** The reserved `knowledge`/`rag` config
   sections (ADR [0010](0010-configuration-via-mistral-native-json.md))
   become behavioral for one key: `rag.streaming` (project > user scope)
   wins over the broader `knowledge.streaming`, which wins over the
   `MISTRAL_RAG_STREAMING` env var (`0/false/off/no` = off), default `true`.
   Setting streaming off restores the exact one-shot request and behavior.

## Consequences

- Long RAG answers stop holding the tool call hostage to the full
  completion; aborts take effect mid-transfer and previews reach the
  session UI during generation.
- The model-facing result is unchanged: identical text + citations +
  `structuredContent.chunks` as the one-shot path — no provider- or
  model-visible behavior change, only transport. The shared assembly and
  render functions serve both paths so the mapping cannot drift.
- Tool usage token counts from RAG queries now show up in pi session
  statistics (previously invisible; the one-shot path discards the usage
  block). Cost is not computed on the tool result — the tool knows the
  token counts, not the model's price; a future per-model cost lookup
  could close that gap if session stats ever need RAG dollar costs.
- Two SSE consumers exist in the package (this one and the provider's
  `sseData`). Unifying them was rejected: the provider's consumer is
  entangled with message replay, retry and the block-event contract;
  the RAG consumer is ~80 lines over the knowledge client. The
  duplication is bounded and deliberately accepted.
- The `onUpdate` previews render only where pi renders them (TUI);
  RPC/JSON consumers see only the final result — the same partial-result
  channel pi itself uses for its tools, no custom protocol.
