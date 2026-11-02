# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-02

Initial public release: a native Mistral AI provider for the
[pi coding agent](https://github.com/earendil-works/pi) — chat with reasoning, knowledge/RAG, OCR,
connectors, server-side tools, a live model catalog with pricing, and regional
endpoints, all as first-class pi capabilities.

### Added

- **Native `mistral-native` provider with chat and reasoning.** Pick any
  `mistral-native/…` model and chat as usual: reasoning models stream their
  thinking into proper thinking blocks, tool calls execute (including
  parallel calls), and usage and cost are shown per response. Every
  content-chunk type the stream cannot map is rejected with a clear error —
  no content is ever silently dropped.
- **Guided API-key login.** `/login mistral-native` prompts for an API key
  and the API region in one flow; alternatively, export `MISTRAL_API_KEY`
  and the provider works with zero configuration.
- **Mistral connectors as pi tools.** Grant access once via
  `mistral_connector_auth_url`, then `mistral_connector_load` pulls a
  connector's MCP tools (Outlook, SharePoint, Notion, Google Drive, …) into
  the session as ordinary pi tools. Additional tools manage connectors:
  list, inspect tools, activate/deactivate, share/unshare, unload, reload.
- **Server-side tools mid-chat.** One setting lets Mistral search the web,
  generate images, or run code inside a streamed response — no client-side
  glue: `{ "serverTools": ["web_search", "image_generation", "code_interpreter"] }`
  or `MISTRAL_SERVER_TOOLS`.
- **Hosted agent mode.** `{ "agentId": "my-agent" }` routes requests to an
  agent configured on La Plateforme; its tool set executes on Mistral's side.
- **OCR for images and PDFs.** `mistral_ocr` returns per-page markdown from
  a screenshot, scan or PDF.
- **Document intelligence tools.** `mistral_moderate` (content-policy
  flags with scores), `mistral_embed` (embedding vectors) and
  `mistral_classify` (classification against your fine-tuned model's
  training-time targets).
- **Search your own documents (RAG).** Upload a file once
  (`mistral_document_upload`), then `mistral_document_query` answers
  questions with citations linking to the source passages — answers stream
  as they are produced. Supporting tools manage the document store: files,
  libraries, document status, signed download URLs, re-indexing.
- **A live model catalog with real prices.** The model list refreshes from
  Mistral's live catalog — new models appear and retired ones disappear
  without a package update — with every model priced from a sourced rate
  card so pi's cost display is meaningful. Offline startup restores the
  last fetched snapshot; `models.rateCard` overrides correct or extend
  any price without an update.
- **Region routing.** Route chat completions and the model catalog through
  the EU or US region for data residency — one setting
  (`{ "endpoint": { "region": "eu" } }`), one environment variable
  (`MISTRAL_REGION`), or one prompt during `/login`.
- **The `/mistral` command family.** `/mistral` shows every effective
  setting and where it comes from, `/mistral set <key> <value>` writes a
  user-scope key, `/mistral test` checks the live connection with a fix
  hint on failure.
- **Layered configuration.** An optional `mistral-native.json` file
  (user and project scope) plus environment variables cover behavioral
  settings: region endpoint, server-side tools, agent mode, RAG streaming,
  rate-card overrides and more.
- **Documentation website.** The repository docs are published as a
  static site on GitHub Pages, built and deployed automatically on every
  change.
- **Continuous integration.** A CI pipeline builds the package, runs the
  type check and the full test suite on every push and pull request.

### Fixed

- **Truthful maximum-output mapping.** The live catalog now derives each
  model's `maxTokens` from Mistral's documented facts instead of a fixed
  clamp: only prompt plus completion must fit the model's context window
  (the earlier 32768 cap contradicted the fallback catalog's own value
  for the same model). The only per-model output limits applied are those
  Mistral documents for hosted third-party models.
- **OCR local-path pre-check.** `mistral_ocr` rejects local file paths up
  front with a remedy (the API cannot read local files) instead of failing
  with an opaque API error; pass the file's base64, a data URL or an
  http(s) URL.
- **Configuration env hermeticity.** Environment reads in the
  configuration layer treat an empty string as unset (consistent with
  pi's provider-env convention), so a pinned empty value no longer falls
  through to the live process environment when resolving config paths,
  the region or RAG streaming.

## [0.1.1] - 2026-11-03

### Fixed

- **Truthful completion-token ceilings.** Chat requests against
  mistral-large-4 (and models with 1M contexts) failed with
  `400 invalid_request_max_tokens` (code 3058) because the catalog
  derived `maxTokens` from the full context window while the API enforces
  a per-model completion ceiling the model pages do not document (262144
  for mistral-large-4, wire-verified by probing). `maxTokens` is now
  `min(completion ceiling, context window)`, and the request path clamps
  to the ceiling too, so stale persisted snapshots from earlier versions
  cannot reproduce the 400 before the self-healing catalog refresh
  overwrites them.

## [unreleased]

Nothing yet beyond 0.1.1.

[unreleased]: https://github.com/awerner/pi-mistral-native/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/awerner/pi-mistral-native/releases/tag/v0.1.1
[0.1.0]: https://github.com/awerner/pi-mistral-native/releases/tag/v0.1.0
