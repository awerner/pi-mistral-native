# 0006. Knowledge API tools

- **Status**: Trial
- **Date**: 2026-10-30

## Context

Mistral's knowledge APIs — files, libraries, documents and RAG
retrieval — are exposed as model-callable pi tools next to the provider
extension itself (ADR
[0002](0002-mistral-native-provider-for-pi.md)). pi's
`pi.registerTool()` surface takes TypeBox parameter schemas and returns
model-facing `content`, log-persistent `details`, and an optional
`outputSchema`/`structuredContent` pair for programmatic callers. The wire
formats (multipart uploads, offset/token pagination, the `document_library`
chat-completions tool with `text`/`document_url` content chunks, signed-URL
bodies that may be JSON-quoted strings) are verified against the vendored
spec (ADR [0003](0003-vendored-openapi-spec.md)).

Signed URLs grant download access for their lifetime and pi persists tool
`details` in transcripts and logs, so the surface must separate what the
caller receives from what gets logged.

## Decision

Expose exactly nine tools, registered by `extensions/tools/knowledge.ts`
via `registerKnowledgeTools(pi)` from the provider extension's default
factory:

| Tool | Endpoint |
|---|---|
| `mistral_file_upload` | `POST /v1/files` |
| `mistral_library_create` | `POST /v1/libraries` |
| `mistral_library_list` | `GET /v1/libraries` |
| `mistral_document_upload` | `POST /v1/libraries/{id}/documents` |
| `mistral_document_list` | `GET /v1/libraries/{id}/documents` |
| `mistral_document_status` | `GET .../status` (+ `GET .../documents/{doc}` for metadata) |
| `mistral_document_signed_url` | `GET .../signed-url` or `.../extracted-text-signed-url` |
| `mistral_document_reprocess` | `POST .../reprocess` |
| `mistral_document_query` | `POST /v1/chat/completions` with the `document_library` tool |

Supporting decisions:

- A small shared HTTP client (`extensions/tools/mistral-client.ts`) owns
  auth headers, JSON/multipart bodies and error mapping; its `fetch`
  implementation is injectable so every tool is unit-tested against a
  mocked fetch, with no network and no real keys.
- The API key is resolved lazily per execute call: first the
  `mistral-native` provider's registered key via
  `ctx.modelRegistry.getApiKeyForProvider()`, then `MISTRAL_API_KEY`. The
  key is never logged or embedded in results or errors.
- Signed URLs are returned to the caller via `content` (model-facing) and
  `structuredContent.url`, but never appear in `details`, which pi persists
  to transcripts/logs. Each tool's `details` carries only identifiers and
  status, never secrets or bearer URLs.
- File uploads send `visibility=user` by default, overriding the API's
  server-side default of `workspace`, so an upload stays private to the
  uploader unless the model explicitly passes `visibility=workspace`.
- The RAG query is a chat completion with a `document_library` tool and
  the user's question as the message. `text` chunks map to retrieved
  text, `document_url` chunks to citations (URL + optional document
  name); plain string content maps to a single text chunk. The request
  streams (ADR [0015](0015-streaming-rag-document-query.md)); config can
  force the one-shot form.
- Library-scoped tool references for the streaming chat path are future
  work; they will reuse the same client rather than duplicating HTTP
  logic.
- The files-API signed URL (`GET /v1/files/{file_id}/url`) is out of
  scope: the document signed URLs cover the retrieval path (original and
  extracted text).

## Consequences

- The model can upload, index, inspect and query Mistral knowledge
  without the user leaving pi; billing-relevant side effects (upload,
  reprocess) are stated in the tool descriptions.
- Nine more tools are always declared once the extension is active; tool
  exposure control (`exposure`, `setActiveTools`) can reduce the surface
  later if the default set feels noisy.
- Signed URLs remain a security consideration: the URL necessarily ends
  up in the model-facing `content` tool result, which is persisted in the
  session transcript. The content/details split keeps the URL out of the
  `details` rendering/log path only — it does not keep it out of
  transcripts; anyone with transcript access must treat it as a bearer
  URL until it expires. The split is still worth it because `details` is
  the path tools commonly write into logs and structured state.
- The `visibility=user` default diverges from the API's own default
  (`workspace`): users who relied on uploads being workspace-visible must
  now pass `visibility=workspace` explicitly. Privacy fails closed here.
- The RAG query streams by default (ADR
  [0015](0015-streaming-rag-document-query.md)); the non-streaming one-shot
  is available by config. Long retrievals no longer block the tool call
  behind the complete completion.
