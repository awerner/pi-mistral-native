![pi-mistral-native — native Mistral AI provider for the pi coding agent](assets/banner.png)

# pi-mistral-native

A Mistral-specific, optimized integration for the
[pi coding agent](https://github.com/earendil-works/pi) — not just chat. pi-mistral-native is a pi
package that registers the native `mistral-native` provider and exposes
Mistral's full native feature surface as first-class pi capabilities:
a dynamically loaded model catalog with current pricing, knowledge/RAG,
OCR, connectors, server-side tools, and regional endpoints.

## Quickstart

Install the package, log in once, and pick a model:

```bash
pi install npm:pi-mistral-native
pi /login mistral-native
```

The guided login prompts for an
[API key](https://console.mistral.ai/api-keys) and the API region — and
that's it: the provider is registered, the model catalog refreshes from
Mistral's live model list, and the knowledge, OCR and connector tools are
available in every session. No configuration file is required.

## What you can do

Everything below works inside your normal pi session — no separate
client, no context switching.

**Chat with Mistral models — including reasoning.** Pick any
`mistral-native/…` model and chat as usual: thinking streams into
proper thinking blocks, tool calls execute, usage and cost are shown.
Quick way: nothing beyond the Quickstart — the models just appear.

**Use Mistral connectors — Outlook, SharePoint, Notion, Google Drive,
… — as tools.** Grant access once; the connector's MCP tools become
ordinary pi tools your agent can call. Quick way:
`mistral_connector_auth_url`, then `mistral_connector_load`.

**Generate images mid-chat — and search the web via a dedicated tool.**
One setting, no client-side glue:

```json
{ "serverTools": ["image_generation"] }
```

Web search ships as the model-callable `web_search` pi tool
(see [Server-side and client-side tools](docs/concepts/tools.mdx)) — registered by
default, running under a search model that defaults to
`mistral-small-latest` and is configurable via `knowledge.searchModel`.
The same Conversations-backed pattern powers the `mistral_code_interpreter`
pi tool, which runs Python server-side and returns captured output plus
generated files as download links (see
[the Tools reference](docs/reference/tools.mdx)).

**Extract text from images and PDFs (OCR).** Point the agent at a
screenshot, scan or PDF and get per-page markdown back.
Quick way: `mistral_ocr`.

**Search your own documents (RAG).** Upload a file once, then ask
questions about it — answers come back with citations linking to the
source passages. Quick way:
`mistral_document_upload` (once), then `mistral_document_query`.

**An always-current model list with estimated prices.** New and retired
Mistral models show up (or disappear) without a package update, each
priced from a sourced rate card so pi's cost display shows meaningful
catalog estimates (marked as estimates, never as billed totals).
Quick way: nothing — the catalog refreshes itself; `/mistral test`
checks the live connection on demand.

**Check and shape content.** Moderations (policy flags with scores),
embeddings, and classification against your fine-tuned models — all
as tools the agent can call.

**Route through the EU or US region.** Data-residency routing with
one key (or one prompt during `/login`):

```json
{ "endpoint": { "region": "eu" } }
```

**Configure everything without leaving pi.** `/mistral` shows every
effective setting and where it comes from, `/mistral set <key> <value>`
writes one, `/mistral test` checks the live connection.

Documentation is structured by Diátaxis — the website at
<https://mawoh.github.io/pi-mistral-native/> has [how-to
guides](https://mawoh.github.io/pi-mistral-native/how-to/change-a-setting/),
[reference pages](https://mawoh.github.io/pi-mistral-native/configuration/)
and [concept pages](https://mawoh.github.io/pi-mistral-native/concepts/config-layers/).

## Why not just the built-in Mistral provider?

pi ships a generic OpenAI-compatible Mistral provider; that path falls
short in four documented ways, each of which this package solves
natively:

- **Reasoning it can't parse** — Mistral streams thinking as block
  arrays the generic provider needs hand-patches for; here the wire
  format is native, and no content is ever silently dropped.
- **Static, hand-maintained model lists** — here the catalog refreshes
  from Mistral's live model list with sourced, auditable pricing.
- **Server-side conversation state you cannot trust** — the built-in
  path runs on the Beta Conversations API, where corrupted state can
  replay stale tool calls; here every request is stateless GA chat
  completions carrying the full history, so there is nothing to
  corrupt.
- **Chat only** — here the whole non-chat surface (knowledge/RAG, OCR,
  connectors, server-side tools) is exposed as pi tools.

The streaming and model-catalog behavior is explained in the concept
pages [How chat streaming works](docs/concepts/chat-streaming.mdx)
and [Models and cost estimates](docs/concepts/models-and-costs.mdx).

## Install

The package installs as a pi package:

```bash
pi install npm:pi-mistral-native
```

Node.js ≥ 22 is required. To try it from a local checkout without
installing:

```bash
npm run build                        # tsc to the git-ignored dist/
pi -e ./pi-mistral-native            # or: pi install ./pi-mistral-native
```

The manifest resolves the compiled `dist/extensions/` entry points, so
build first — before the build, `pi install`/`pi -e` against the
checkout silently loads no extension. During development the TypeScript
sources can load directly: `pi -e extensions/mistral.ts`.

## Configuration

Two API-key sources, checked in this order:

1. **`/login mistral-native`** — the provider's native guided flow: a
   secret prompt for an API key plus a region picker; pi stores the key
   in `~/.pi/agent/auth.json`.
2. **`MISTRAL_API_KEY`** — the zero-configuration default; export it and
   the provider works.

Credentials are scoped by provider id: an existing `mistral` entry in
`auth.json` belongs to a different provider — run
`/login mistral-native` for this one.

Behavioral settings (region endpoint, server-side tools, connectors,
rate-card overrides and more) live in the optional `mistral-native.json`
file or environment variables; the `/mistral` command family shows every
effective value and writes user-scope keys by default and project-scope
keys with `--project`. Full reference:
[Configuration keys](docs/configuration.mdx).

## Development

Build and test commands and the repository layout live in
[Development](docs/contributing/development.md).

## License

[MIT](LICENSE) — Copyright (c) 2026 MAWOH DevOps
