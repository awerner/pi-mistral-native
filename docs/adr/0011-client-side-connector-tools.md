# 0011. Client-side connector tools via the loader pattern

- **Status**: Trial
- **Date**: 2026-11-02

## Context

Mistral connectors support client-side execution — the same connectors
ADR [0007](0007-server-side-tools-as-opaque-content.md) exposes as
server-side `{type:"connector"}` chat-request entries. Live probes
against the Mistral API established the wire facts:

- Connectors expose an MCP-compatible tool interface: `GET /v1/connectors`
  (with `fetch_user_data=true`, keyset pagination via `items` +
  `pagination.next_cursor`), `GET /v1/connectors/{id}/tools?pretty=false`
  (real JSON Schema, including Mistral's `anyOf`-nullable idiom;
  `pretty=true` returns a compact summary shape), and
  `POST /v1/connectors/{id}/tools/{tool_name}/call` with `{arguments}`,
  returning `{content: [{type:"text", text}], metadata.mcp_meta.isError}`.
- Unauthenticated connectors answer list_tools with HTTP 401 "No
  credentials found" — a usable per-connector fallback signal.
- Live-verified on this account: 17 connectors visible; `outlook`
  (7 tools), `outlook_calendar` (12) and `sharepoint_mcp` (34) are
  authenticated. `is_authenticated` is only populated when
  `fetch_user_data=true`.
- pi 1.4.0 supports runtime tool registration (`registerTool`), passive
  exposure (`deferred`/`hidden` never auto-activate), and `setActiveTools`
  as the documented loader pattern ("Register every tool first, keep
  optional tools inactive, and use pi.setActiveTools() from a loader
  tool"). Tools cannot be unregistered; re-registering as `hidden` is the
  documented withdraw path. `namespace: {name, aliases, description}`
  groups tools the way MCP servers do.
- 53 authenticated connector tools would bloat the prompt if registered
  directly active — hence the loader pattern.

## Decision

Client-side connector tools load on demand via a loader tool
(implementation in `extensions/tools/loader.ts`; ADR
[0007](0007-server-side-tools-as-opaque-content.md) keeps the
server-side counterpart):

1. **Session start** (live fetch, consistent with the dynamic model
   catalog): list connectors with `fetch_user_data=true`, keep
   those with `supports_mcp !== false`, and determine the authenticated
   ones (`is_authenticated`; 401 on list_tools is the per-connector
   fallback signal). Register ONE loader tool, `mistral_connector_load`,
   whose description dynamically lists the authenticated connectors
   (name + description; no tool counts at session start).
2. **`mistral_connector_load(connector)`**: fetch the connector's tools
   raw-mode, register all with passive exposure (`deferred`, never
   auto-activated) under the namespace `mistral_cn_<connector>`
   (aliases: the connector name), then
   `setActiveTools([...current, ...new])`. The result text lists each
   loaded tool's name + one-line description — the running turn's
   declarations were fixed before the loader ran, so the agent learns
   availability from the result. Original tool names are kept; name
   collisions are resolved session-wide (another loaded connector OR an
   already-registered session tool — pi built-ins, MCP tools, other
   extensions' tools — disambiguate as `<original>__<connector>`, then
   `_2`, `_3`, … while the candidate is taken, so a connector tool named
   `read` can never shadow pi's built-in; re-loading the same connector
   stays idempotent). Loaded-tool state is cleared only when pi replaces
   the session (`session_start` reason `"new"`, i.e. `/new`); resume,
   fork and reload keep it so pending transcript tool names re-activate
   with stable renames.
3. **`mistral_connector_unload(connector)`**: re-register the connector's
   tools as `hidden` (the documented withdraw path) and
   `setActiveTools` without them.
4. **`mistral_connector_reload`**: re-fetch the connector list and
   refresh the loader description (covers `/reload` and
   session-resume staleness). Deliberate scope: reload refreshes the
   connector *list* (what can be loaded), not the tool schemas of
   already-loaded connectors — unload + load re-fetches those.
5. **Tool calls**: POST the call endpoint with `{arguments}` (the tool's
   inputSchema is pi's parameter schema), fold `{content:[...]}` text
   blocks to text (non-text blocks become placeholders), propagate
   `metadata.mcp_meta.isError`, and forward connector `annotations`
   (`readOnlyHint` etc.) to pi tool annotations.
6. **Config gating** via the `connectorTools` section of
   `mistral-native.json` (ADR
   [0010](0010-configuration-via-mistral-native-json.md)'s reserved
   section, now activated): `enabled` (default `true`;
   `MISTRAL_CONNECTOR_TOOLS` env override, with "0"/"false"/"off"
   disabling; the file wins over env per the ADR 0010 precedence chain)
   and `autoLoad` (connector names auto-registered + activated at
   session start, without a model-facing result).

## When client-side vs. server-side (ADR 0007)

The same connectors support two execution models:

| | Client-side (this ADR) | Server-side (ADR 0007) |
|---|---|---|
| Executor | pi, via the tool-call endpoint | Mistral, inside chat completions (`{type:"connector"}` entries) |
| Tool-schema visibility | Full — the agent sees names, descriptions, JSON Schemas | None — only the connector ref is declared |
| Provider | Model-agnostic — works with any provider, not just `mistral-native` chat | Model-locked to Mistral chat |
| Results | Structured pi tool results | Opaque assistant text (ADR 0007's forcing constraint: pi would re-execute any `toolCall` block client-side) |
| Prompt cost / round-trips | Managed by the loader pattern (one loader tool; extra loader round-trip) | Zero prompt declarations, zero client round-trips for execution |
| Permission gating | Permission extensions can gate on annotations | No per-tool permission gating |
| Credentials | Still live server-side at Mistral — pi never holds OAuth tokens (`connection_credentials` never exposed) | Same |

Recommendation: default to **client-side** (loader) when the agent should
reason about available tools, compose multi-step connector workflows, or
the session uses non-Mistral providers; default to **server-side** refs
for fire-and-forget retrieval-augmented answers on a Mistral model where
prompt economy matters. Both can coexist in one session (different
execution models, same connectors).

## Consequences

- The prompt stays lean: one loader tool instead of 53 declarations.
- Loaded tools are visible from the next model request (pi's
  `before_agent_start` re-declares active tools); the loader's result
  text carries the tool names for the running turn.
- Name collisions resolve via the `__<connector>` suffix within
  namespaces — checked session-wide (other loaded connectors, pi
  built-ins, MCP tools, other extensions' tools), so connector tools can
  never shadow a built-in like `read` (pi's registry replaces same-name
  custom registrations); original tool names are preserved otherwise.
- Unloaded tools stay registered as `hidden` (pi cannot unregister) — an
  accepted limitation.
- The loader description is a session-start snapshot; `mistral_connector_reload`
  refreshes it.
- Unauthenticated connectors are excluded (401 signal).
- Connector credentials stay on Mistral's side (ADR
  [0004](0004-api-key-credential-chain-without-mistral-oauth.md)
  unchanged); the cost is per-call latency — each tool call is an HTTP
  request from pi.
