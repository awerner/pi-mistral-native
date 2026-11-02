# Knowledge tools

## What you can do

Everything below is a tool your agent can call directly — ask in plain
language ("OCR this screenshot", "search my docs library for X") and
the right tool runs.

**Ask questions about your own documents (RAG).** Upload a file once,
then query it — answers come back with citations linking to the
source passages.

```text
mistral_document_upload  (once per file — async processing, poll with
                          mistral_document_status)
mistral_document_query   (ask; answers stream with citations)
```

**Extract text from images and PDFs (OCR).** `mistral_ocr` returns
per-page markdown from a screenshot, scan or PDF.

**Check content policy, embed text, or classify with your own
fine-tuned model.** `mistral_moderate` (fixed policy categories with
scores), `mistral_embed` (vectors), `mistral_classify` (your model's
training-time targets).

**Manage the document store.** Create libraries, list documents, get
short-lived download URLs, re-index after fixing a source file:

```text
mistral_file_upload        mistral_library_create    mistral_library_list
mistral_document_list      mistral_document_status   mistral_document_signed_url
mistral_document_reprocess
```

No configuration needed — the tools register automatically.

*Decisions: [ADR 0005 — OCR, embeddings, moderations/classifications as pi tools](adr/0005-ocr-embeddings-moderations-as-pi-tools.md); [ADR 0006 — Knowledge API tools](adr/0006-knowledge-api-tools.md)*

## Tool reference

The extension registers **13 pi tools** covering Mistral's
knowledge-side APIs: the four document-intelligence tools (OCR,
embeddings, moderations, classifications) and the nine library/RAG
tools for files, libraries, documents and streaming RAG queries.

All tools resolve the API key per call through the chain in
[auth.md](auth.md) and stay on the **global** `api.mistral.ai`
endpoint regardless of the configured region (only chat completions
and the model catalog route regionally).

*Decisions: [ADR 0012 — Selectable region endpoint with per-family routing](adr/0012-selectable-region-endpoints.md)*

### Document-intelligence tools

| Tool | Purpose |
|---|---|
| `mistral_ocr` | Image or PDF → per-page markdown |
| `mistral_embed` | Texts → embedding vectors |
| `mistral_moderate` | Fixed moderation categories with flags/scores |
| `mistral_classify` | Score inputs against a fine-tuned model's training-time targets |

Key parameters:

- **`mistral_ocr`** — `image` (required): a data URL, an http(s) URL
  (image extensions like `.png`/`.jpg` route as an image, everything
  else as a document), or plain base64 (wrapped as a base64 PNG).
  Local file paths are rejected up front with a remedy (the API cannot
  read local files — read the file and pass its base64, or use a
  data:/http(s) URL). Optional: `model` (default `mistral-ocr-latest`), `pages` (e.g.
  `"0-5"`, `"0,2-4"`, 0-based), `include_image_base64` (also return
  extracted images as base64 — in `structuredContent` only, never in
  the model-facing text). Model-facing markdown is capped; full text
  and page metadata live in `structuredContent`.
- **`mistral_embed`** — `input` (required): at least one non-empty
  text. Optional `model` (default `mistral-embed`). Vectors are
  returned in `structuredContent` for programmatic use; the persisted
  `details` carry only 5-number previews to keep transcripts small.
- **`mistral_moderate`** — `input` (required): one text or a list.
  Optional `model` (default `mistral-moderation-latest`). Returns the
  server's fixed category flags and per-category scores; the summary
  names the flagged categories per input.
- **`mistral_classify`** — `model` (required): a fine-tuned classifier
  model id (its training-time targets are what get scored; callers
  cannot define custom criteria). `input`: one text or a list. Returns
  per-target score tables in `structuredContent`.

*Decisions: [ADR 0005 — OCR, embeddings, moderations/classifications as pi tools](adr/0005-ocr-embeddings-moderations-as-pi-tools.md)*

### Library / RAG tools

| Tool | Purpose |
|---|---|
| `mistral_file_upload` | Upload a local file to the files API (OCR, batch, fine-tune, agentic safety) |
| `mistral_library_create` | Create a document library for RAG indexing |
| `mistral_library_list` | List libraries, with search and pagination |
| `mistral_document_upload` | Upload a local file into a library (async processing) |
| `mistral_document_list` | List a library's documents, with search and pagination |
| `mistral_document_status` | Poll async processing status until `done`/`error` |
| `mistral_document_signed_url` | Short-lived (30 min) signed download URL |
| `mistral_document_reprocess` | Queue re-indexing (billed again) |
| `mistral_document_query` | RAG query over one or more libraries, with citations |

Key parameters:

- **`mistral_file_upload`** — `path` (required, local file);
  `purpose` (`ocr` default; `ocr`/`batch`/`fine-tune`/`agentic_safety`),
  `expiryHours` (1..168, auto-delete afterwards), `visibility`
  (`user` default — see below), `fileName` override.
- **`mistral_library_create`** — `name`, optional `description`.
- **`mistral_library_list`** — optional `search` (case-insensitive name
  filter), `pageSize` (1..100), `pageToken` (continuation from
  `nextPageToken`).
- **`mistral_document_upload`** — `libraryId`, `path`; optional
  `fileName`. Processing starts asynchronously; poll with
  `mistral_document_status`. Duplicate content returns the existing
  document. Billable.
- **`mistral_document_list`** — `libraryId`; optional `search`, `page`
  (0-based), `pageSize` (1..100), plus pagination metadata in the
  result.
- **`mistral_document_status`** / **`mistral_document_reprocess`** —
  `libraryId` + `documentId`; reprocessing is billed again.
- **`mistral_document_signed_url`** — `libraryId` + `documentId`;
  optional `kind` (`document` default, or `extracted-text`). The URL
  expires after 30 minutes.

*Decisions: [ADR 0006 — Knowledge API tools](adr/0006-knowledge-api-tools.md)*

### Streaming RAG queries

**`mistral_document_query`** — `libraryIds` (at least one), `query`;
optional `model` (default `mistral-large-4`), `maxTokens`. Runs a
**streaming** chat completion with the `document_library` tool: the
answer assembles as it generates, the session UI receives partial
previews, an abort cancels the transfer mid-stream, and the terminal
usage chunk is carried on the tool result. The model-facing result is
identical to the one-shot path: retrieved text chunks plus citations
(signed document URLs with names). Set `rag.streaming: false` (or
`MISTRAL_RAG_STREAMING=0`) to force the non-streaming request — see
[configuration.md](configuration.md).

*Decisions: [ADR 0006 — Knowledge API tools](adr/0006-knowledge-api-tools.md); [ADR 0015 — Streaming RAG document query](adr/0015-streaming-rag-document-query.md)*

## Security and privacy rules

- **Signed URLs are never logged**: they are returned to the caller via
  the model-facing `content` and `structuredContent.url`, but never
  placed in `details`, which pi persists to transcripts and logs. Every
  tool's `details` carry only identifiers and status.
- **The API key never appears in results or errors** — only on the
  outbound `Authorization` header.
- **`visibility=user` by default** on file uploads, overriding the
  API's server-side default of `workspace` so uploads stay private to
  the uploader unless `visibility=workspace` is passed explicitly.
  Privacy fails closed.

## Notes

- **Endpoint:** all knowledge tools deliberately stay on the
  **global** `api.mistral.ai` endpoint regardless of the configured
  region — the Files API is not available regionally (see
  [configuration.md](configuration.md) and
  [stream.md](stream.md)).
- **Tools, not classifiers:** the document-intelligence tools are pi
  tools, not pi classifiers: moderations return server-fixed
  categories and classifications score training-time targets, so
  neither fits pi's caller-defined-questions classifier contract. The
  chat variants (`/v1/chat/moderations`,
  `/v1/chat/classifications`) are deferred.
- **Implementation:** an injectable fetch implementation keeps the
  tools unit-testable against mocked HTTP; the shared HTTP client
  (`extensions/tools/mistral-client.ts`) implements the streaming RAG
  SSE path.
