# 0014. Content chunk coverage: map or reject, never drop

- **Status**: Trial
- **Date**: 2026-10-31

## Context

Mistral's chat-completions `ContentChunk` union (vendored
[OpenAPI spec](../../../vendor/mistral-openapi.yaml), ADR
[0003](0003-vendored-openapi-spec.md)) has nine wire types: `text`,
`image_url`, `document_url`, `reference`, `file`, `thinking`,
`input_audio`, `resource`, `resource_link`. The stream's delta mapping
covered only `text` and `thinking`; every other type was silently dropped.
The governing principle: **no silent content loss** — every chunk type is
either mapped into pi's content model or rejected with a clear error
naming the type.

pi 1.4.0's content model is the boundary that decides what can be mapped:
pi's input surface is exactly `TextContent | ImageContent` for user
messages (and tool results), assistant content is
`TextContent | ThinkingContent | ToolCall` — verified against
`pi-ai/dist/types.d.ts` and
`pi-coding-agent/dist/core/extensions/types.d.ts`. There is no audio
input modality (`ModelInputModalitySchema` is `["text", "image"]`), no
`AudioContent` block, and no attachment surface that could produce audio.

## Decision

Per-type decision table (delta/replay side unless noted):

| Wire type | Decision | Reasoning |
|---|---|---|
| `text` | **Mapped** | Existing text-block handling. |
| `thinking` | **Mapped** | Existing thinking-block handling; nested parts: text joins the thinking text, `reference` becomes a citation marker, anything else (e.g. `tool_reference`) is rejected loudly. |
| `reference` | **Mapped** | Output citation marker (`reference_ids` index the client-supplied references mapping in tool-result content, docs.mistral.ai citations flow). Text is pi's only assistant expression surface, so the marker `[0, 1]` is appended to the current text block — citation information is preserved losslessly. An empty `reference_ids` array is a legitimate empty carrier (no marker); a present-but-non-array `reference_ids` is a malformed wire shape and rejects loudly. |
| `image_url` | **Rejected loudly** | Assistant-image output has no pi surface (assistant content is text/thinking/toolCall). |
| `document_url` | **Rejected loudly** | Same — no pi surface; the documented input path (`document_url` on user content) is equally unreachable because pi user input is text/image only. |
| `file` | **Rejected loudly** | Same; the documented chat path for uploaded files is upload → signed URL → `document_url`, and pi cannot produce either. |
| `input_audio` | **Rejected loudly (blocked-on-pi)** | Wire-valid for Voxtral Small per Mistral docs (`{type:"input_audio", input_audio:"<base64>"}`, same chat-completions endpoint), but pi 1.4.0 has no audio content surface — no synthetic input path is invented. The error names pi as the blocker. |
| `resource` | **Rejected loudly** | In the OpenAPI union but undocumented for chat completions (only the MCP/agents `EmbeddedResource` schema resembles it) — ambiguous, and pi has no surface regardless. |
| `resource_link` | **Rejected loudly** | Spec-only like `resource`; no pi surface. |
| unknown/missing `type` | **Rejected loudly** | Same rule for future or malformed wire shapes. |

Request side (pi → wire): user `text` and `image` blocks map as before
(images still gated on the model's vision capability — a tested, explicit
drop of *known* input, not silent loss of unknown input). Any other pi
block type — unreachable with pi 1.4.0 — throws a clear error naming the
type and role (user, tool-result and assistant content alike) instead of
falling through silently; assistant `thinking` blocks remain a documented
skip, not replayed to the wire.

Errors name the chunk type and never embed the payload (data URLs and
base64 bodies must not leak into error text). Both throws propagate to
the stream body's existing catch → `error` event with `errorMessage` and
stop reason `error`.

## Consequences

- **Easier:** a future chunk type or a gateway quirk surfaces as a
  readable error instead of silently corrupted output; citation-bearing
  responses (citations flow, RAG) replay with their markers intact.
- **Harder:** a model streaming e.g. an assistant image kills the turn
  with an error rather than degrading gracefully — accepted: pi has no
  consumer for such content, and a silent drop would hide real data loss.
- **Blocked-on-pi:** `input_audio` cannot be exercised end-to-end until
  pi grows an audio input surface; the wire shape is implemented and
  documented, but no request-side mapping or synthetic test path exists.
  When pi adds audio, this ADR is revisited.
