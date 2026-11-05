# Development

This is the developer and contributor document for pi-mistral-native:
build commands, repository layout, and where everything lives. The
project's documentation follows the Diátaxis structure (ADR 0023):

- `README.md` — the user landing page (features, status, install,
  configuration)
- `docs/get-started/`, `docs/how-to/`, `docs/reference/`,
  `docs/concepts/` — user-facing pages, one Diátaxis type per section
- `docs/contributing/` — developer docs for contributors (this page,
  testing, publishing, hosting, design-tokens, internals)
- `docs/dev/adr/` — architecture decision records

`AGENTS.md` remains the agent entry point; `.pi/*.md` hold working
instructions, not audience documentation.

## Commands

```bash
npm install        # dev dependencies (typescript, @types/node)
npm run check      # tsc --noEmit
npm test           # build + node --test
npm run build      # tsc to dist/ (git-ignored)
```

## Branching

`main` is the default branch; PRs target `main`.

## Layout

| Path | Contents |
|---|---|
| `extensions/mistral.ts` | The provider extension: `pi.registerProvider("mistral-native", …)` with the native `mistral-chat` `streamSimple`, dynamic model-catalog refresh, the knowledge tools and the connector tools |
| `extensions/mistral/` | Shared modules: `api.ts` (Mistral knowledge-API HTTP client + wire types), `knowledge.ts` (OCR/embeddings/moderation/classification pi tools), `server-tools.ts` (server-side tools/connector/agent-mode config and request helpers) |
| `extensions/tools/` | Library/RAG and connector tools: `mistral-client.ts` (shared HTTP client), `knowledge.ts` (9 pi tools for files, libraries, documents, RAG query), `connectors.ts` (7 connector management pi tools), `loader.ts` (client-side connector tool loader — mistral_connector_load/unload/reload) |
| `test/` | `node --test` suites |
| `vendor/mistral-openapi.yaml` | Vendored Mistral OpenAPI spec — wire-format reference, never edit by hand |
| `docs/` | User pages: [get-started](../get-started/first-session.mdx), [how-to](../how-to/change-a-setting.mdx), [reference](../reference/tools.mdx), [concepts](../concepts/config-layers.mdx), [Configuration keys](../configuration.mdx) |
| `docs/contributing/` | Developer docs: [Development](development.md) (this page), [Testing](testing.md), [Publishing](publishing.md), [Website hosting](hosting.md), [Design tokens](design-tokens.mdx), [Internals](internals.mdx) |
| `docs/dev/adr/` | Decision records — index: [Architecture Decision Records](../dev/adr/README.md) |
| `.pi/` | pi project configuration (loads only after project trust) |
| `.pi/settings.json` | Project model defaults (`mistral-native/mistral-large-4`) |
| `.pi/workflow.md` | Workflow reference (roles, stages, never-list) |

*Decisions: [ADR 0003 — Vendored OpenAPI spec](../dev/adr/0003-vendored-openapi-spec.md); [ADR 0005 — OCR, embeddings, moderations/classifications as pi tools](../dev/adr/0005-ocr-embeddings-moderations-as-pi-tools.md); [ADR 0006 — Knowledge API tools](../dev/adr/0006-knowledge-api-tools.md); [ADR 0007 — Server-side tools as opaque content](../dev/adr/0007-server-side-tools-as-opaque-content.md); [ADR 0011 — Client-side connector tools via the loader pattern](../dev/adr/0011-client-side-connector-tools.md); [ADR 0015 — Streaming RAG document query](../dev/adr/0015-streaming-rag-document-query.md); [ADR 0023 — Documentation structured by Diátaxis](../dev/adr/0023-documentation-structured-by-diataxis.md)*
