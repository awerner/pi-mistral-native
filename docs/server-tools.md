# Server-side tools and connectors

## What you can do

**Let Mistral generate images or run connectors mid-chat — and search
the web via a dedicated tool — without any client-side glue.**
One setting, and the model can call these tools server-side during a
response:

```jsonc
// mistral-native.json (or env: MISTRAL_SERVER_TOOLS=image_generation)
{ "serverTools": ["image_generation"] }
```

```bash
MISTRAL_SERVER_TOOLS=image_generation pi -p "Generate an image summarizing the Mistral API changelog."
```

Web search stays available in the same release — as the model-callable
`mistral_web_search` pi tool (see below), not as a chat-completions
tool entry.

**Use Mistral connectors — Outlook, SharePoint, Notion, Google Drive,
… — as tools.** Grant access once; after that the agent can manage
connectors and pull their MCP tools into the session as ordinary pi
tools:

```text
mistral_connector_auth_url   (get the grant URL, open it in a browser)
mistral_connector_load       (the connector's tools become pi tools)
```

**Run a hosted Mistral agent in your session.** Point requests at an
agent you configured on La Plateforme:

```jsonc
{ "agentId": "my-agent" }
```

**Route through the EU or US region** with one key:
`{ "endpoint": { "region": "eu" } }` — or pick it during
`/login mistral-native`.

*Decisions: [ADR 0007 — Server-side tools as opaque content](adr/0007-server-side-tools-as-opaque-content.md); [ADR 0011 — Client-side connector tools via the loader pattern](adr/0011-client-side-connector-tools.md)*

## How it works

Mistral can execute tools **server-side** inside one streamed chat
response (image generation and custom connectors such as Notion or
Google Drive), can offer hosted **agents** whose tool set runs entirely
on Mistral's side, and — as of this release — exposes **web search** as a
model-callable pi tool. pi-mistral-native exposes all of these: configured
per session, folded into the chat stream as opaque content, and manageable
through connector tools.

Chat Completions supports only a subset of Mistral's server tools
(wire-verified 2026-11-03 on mistral-large-4 and zai-glm-5-3):
`image_generation` and `{type:"connector"}` entries are accepted;
`web_search`, `web_search_premium` and `code_interpreter` are rejected
with HTTP 400 code 1800 — Mistral marks them Conversations/Agents-API-only.
The request builder therefore filters entries to the supported set and,
when configured tools were dropped, surfaces a visible warning once per
session pointing at the alternatives (web search: the `mistral_web_search`
tool; code interpreter: hosted agent mode). Web search itself runs via
`mistral_web_search`/`mistral_web_search_premium` pi tools over one-shot
stateless Conversations calls: every request carries a fixed
`instructions` string steering the server-side agent to run the search
tool (a declared field of the Conversations request, wire-verified
effective on the live endpoint; hard forcing via `tool_choice` is
server-rejected 422 for builtin connectors). The tool result
nevertheless distinguishes a skipped search (no tool execution in the
response — reported as skipped, retry the query) from a genuinely
empty result (search executed, zero hits). Code interpreter stays
Conversations/Agents-only for now. The `mistral_web_search` tool is
registered by default (no configuration) and the search model is
configurable via `knowledge.searchModel`.

*Decisions: [ADR 0018 — Web search as a Conversations-backed tool](adr/0018-web-search-as-conversations-backed-tool.md)*

### Agent mode

`MISTRAL_AGENT_ID` switches requests to `POST /v1/agents/completions`
with a minimal body (`agent_id`, `messages`, `stream`, clamped
`max_tokens`) — the agent's tool set executes on Mistral's side.

### Enabling server-side tools

Enablement is env-driven or via
[mistral-native.json](configuration.md); pi's provider-scoped env
overrides take precedence over `process.env`:

- `MISTRAL_SERVER_TOOLS` — comma/space separated list of `web_search`,
  `web_search_premium`, `image_generation`, `code_interpreter`
  (unknown values are ignored). Only `image_generation` is sent to chat
  completions — `web_search`, `web_search_premium` and `code_interpreter`
  are not supported by that endpoint (HTTP 400 code 1800) and are dropped
  from requests with a visible once-per-session warning. Web search is
  available as the `mistral_web_search` pi tool instead; code interpreter
  runs in hosted agent mode
- `MISTRAL_CONNECTORS` — comma/space separated connector ids or names
  (e.g. `notion`); sent as `{type:"connector", connector_id:…}` entries
- `MISTRAL_AGENT_ID` — a non-empty value switches requests to agent mode
  (see above)

```bash
MISTRAL_SERVER_TOOLS=image_generation pi -p "Generate an image summarizing the Mistral API changelog."
```

### How executed calls appear

Executed server-side calls never become pi tool calls — pi would execute
those locally a second time. They fold into opaque assistant text blocks
(`[Mistral server-side tool: …]`) carrying the call, its arguments and
the executed result. Calls the model wants the *client* to run still
become normal pi tool calls, and a response that mixes both keeps its
stop reason `toolUse` only when a client call is actually pending.

*Decisions: [ADR 0007 — Server-side tools as opaque content](adr/0007-server-side-tools-as-opaque-content.md)*

### Connector management tools

Seven pi tools manage connectors; all stay on the **global** endpoint
regardless of the configured region:

- `mistral_connector_list` — list connectors (cursor pagination)
- `mistral_connector_tools` — list a connector's tools (requires
  authentication)
- `mistral_connector_auth_url` — OAuth authorization URL; open it in a
  browser to grant access (the grant is stored on Mistral's side;
  nothing is stored locally)
- `mistral_connector_activate` / `mistral_connector_deactivate` —
  activate/deactivate for a scope (user, workspace, organization)
- `mistral_connector_share` / `mistral_connector_unshare` — share
  with / unshare from the current workspace

*Decisions: [ADR 0007 — Server-side tools as opaque content](adr/0007-server-side-tools-as-opaque-content.md)*

### Client-side connector tools (loader pattern)

Connectors can also run **client-side**: the loader tool
`mistral_connector_load` registers an authenticated connector's MCP tools
as ordinary pi tools (namespaced `mistral_cn_<connector>`, kept inactive
until loaded), so the agent sees real tool schemas and can compose
multi-step connector workflows with any provider:

- `mistral_connector_load(connector)` — load a connector's tools; the
  result lists each tool's name and description
- `mistral_connector_unload(connector)` — withdraw a connector's tools
- `mistral_connector_reload` — refresh the loader's connector list
  (e.g. after `/reload`)

Gated by the `connectorTools` section of `mistral-native.json`
(`enabled`, default true, with `MISTRAL_CONNECTOR_TOOLS` env override;
`autoLoad`, a list of connectors registered and activated at session
start — see [configuration.md](configuration.md)).

*Decisions: [ADR 0011 — Client-side connector tools via the loader pattern](adr/0011-client-side-connector-tools.md)*

## Notes

- **Region routing:** server-execution surfaces (server-side tools,
  connectors, agent mode) and connector management post to the global
  `api.mistral.ai/v1` even when a region is configured — the Files,
  Agents and Batch APIs are not available regionally. Plain chat
  completions follow the configured region (see
  [stream.md](stream.md) and
  [configuration.md](configuration.md)). An explicit `endpoint.baseUrl`
  gateway override applies to every chat mode instead.
- **No local state:** connector grants live on Mistral's side; the
  loader exposes tools only within the session that loaded them.
