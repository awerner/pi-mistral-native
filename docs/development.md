# Development

This is the developer and contributor document for pi-mistral-native:
build commands, repository layout, and where everything lives. The
project's documentation is structured in four layers:

- `README.md` — the user landing page (features, status, install,
  configuration)
- `docs/*.md` — user-facing feature docs (behavior, usage, limits)
- `docs/development.md` (this page) and `docs/testing.md` — developer
  docs for contributors and agents
- `docs/adr/` — architecture decision records (process series:
  `docs/adr/process/`)

`AGENTS.md` remains the agent entry point; `.pi/*.md` hold working
instructions, not audience documentation.

*Decisions: [ADR 0005 — Documentation structure and ADR citation convention](adr/process/0005-documentation-structure-and-adr-citation.md)*

## Commands

```bash
npm install        # dev dependencies (typescript, @types/node)
npm run check      # tsc --noEmit
npm test           # build + node --test
npm run build      # tsc to dist/ (git-ignored)
```

## Branching

`main` is the integration branch; feature branches
`<issue-nr>-<slug>`; PRs target `main`.

*Decisions: [ADR 0003 — `main` as the integration branch](adr/process/0003-main-as-integration-branch.md)*

## Layout

| Path | Contents |
|---|---|
| `extensions/mistral.ts` | The provider extension: `pi.registerProvider("mistral-native", …)` with the native `mistral-chat` `streamSimple` (issue #1); catalog refresh with #5; registers the knowledge tools (issues #2/#6) and connector tools (issue #3) |
| `extensions/mistral/` | Shared modules: `api.ts` (Mistral knowledge-API HTTP client + wire types), `knowledge.ts` (OCR/embeddings/moderation/classification pi tools), `server-tools.ts` (server-side tools/connector/agent-mode config and request helpers) |
| `extensions/tools/` | Library/RAG and connector tools: `mistral-client.ts` (shared HTTP client), `knowledge.ts` (9 pi tools for files, libraries, documents, RAG query), `connectors.ts` (7 connector management pi tools), `loader.ts` (client-side connector tool loader — mistral_connector_load/unload/reload) |
| `test/` | `node --test` suites |
| `vendor/mistral-openapi.yaml` | Vendored Mistral OpenAPI spec — wire-format reference, never edit by hand |
| `docs/` | Feature pages: [stream.md](stream.md), [catalog.md](catalog.md), [auth.md](auth.md), [knowledge-tools.md](knowledge-tools.md), [configuration.md](configuration.md), [testing.md](testing.md), [publishing.md](publishing.md); developer docs: [development.md](development.md) (this page), [testing.md](testing.md) |
| `docs/adr/` | Decision records — indexes: [adr/README.md](adr/README.md) (architecture) and [adr/process/README.md](adr/process/README.md) (process) |
| `.pi/` | pi project configuration (loads only after project trust) |
| `.pi/settings.json` | Project model defaults (`mistral-native/mistral-large-4`) |
| `.pi/workflow.md` | Workflow reference (roles, stages, never-list) |
| `.pi/forgejo-tools.md` | Forgejo tool reference, label IDs, REST fallback |
| `.pi/pi-herdsman/roles/` | Role-profile overlays for herdsman (`manager`, `managed-lead`) |

*Decisions: [ADR 0003 — Vendored OpenAPI spec](adr/0003-vendored-openapi-spec.md); [ADR 0005 — OCR, embeddings, moderations/classifications as pi tools](adr/0005-ocr-embeddings-moderations-as-pi-tools.md); [ADR 0006 — Knowledge API tools](adr/0006-knowledge-api-tools.md); [ADR 0007 — Server-side tools as opaque content](adr/0007-server-side-tools-as-opaque-content.md); [ADR 0011 — Client-side connector tools via the loader pattern](adr/0011-client-side-connector-tools.md); [ADR 0015 — Streaming RAG document query](adr/0015-streaming-rag-document-query.md)*
