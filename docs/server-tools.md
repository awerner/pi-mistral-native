# Server-side tools and connectors

## What you can do

**Let Mistral search the web, generate images or run code mid-chat —
without any client-side glue.** One setting, and the model can call
these tools server-side during a response:

```jsonc
// mistral-native.json (or env: MISTRAL_SERVER_TOOLS=web_search,image_generation)
{ "serverTools": ["web_search", "web_search_premium", "image_generation", "code_interpreter"] }
```

```bash
MISTRAL_SERVER_TOOLS=web_search,image_generation pi -p "Search the web for the Mistral API changelog, then generate an image summarizing it."
```

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
response (web search, image generation, code interpreter), can call
**custom connectors** (e.g. Notion, Google Drive), and offers hosted
**agents** whose tool set runs entirely on Mistral's side.
pi-mistral-native exposes all three: configured per session, folded into
the chat stream as opaque content, and manageable through connector
tools.

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
  (unknown values are ignored)
- `MISTRAL_CONNECTORS` — comma/space separated connector ids or names
  (e.g. `notion`); sent as `{type:"connector", connector_id:…}` entries
- `MISTRAL_AGENT_ID` — a non-empty value switches requests to agent mode
  (see above)

```bash
MISTRAL_SERVER_TOOLS=web_search,image_generation pi -p "Search the web for the Mistral API changelog, then generate an image summarizing it."
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
