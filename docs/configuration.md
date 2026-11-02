# Configuration

pi-mistral-native reads an optional JSON configuration file,
`mistral-native.json`, with **user** and **project** scope. The file layer
sits BELOW the environment overrides:

**Precedence (highest wins): project JSON > user JSON > environment
variables > defaults.**

The API key is **not** configured in this file — see
[auth.md](auth.md) for the credential chain (`/login mistral-native` or
the `MISTRAL_API_KEY` environment variable).

*Decisions: [ADR 0004 — API-key credential chain without Mistral OAuth](adr/0004-api-key-credential-chain-without-mistral-oauth.md); [ADR 0010 — Configuration via mistral-native.json](adr/0010-configuration-via-mistral-native-json.md)*

## File locations

### User scope

The **first existing file wins**:

1. `$PI_CODING_AGENT_DIR/mistral-native.json`
2. `$XDG_CONFIG_HOME/pi/mistral-native.json` — falling back to
   `~/.config/pi/mistral-native.json` when `XDG_CONFIG_HOME` is unset
3. `<agent-dir>/mistral-native.json` where agent-dir is
   `PI_CODING_AGENT_DIR` if set, else `~/.pi/agent`
4. legacy `~/.pi/mistral-native.json`

Steps 1 and 3 collapse when `PI_CODING_AGENT_DIR` is set — that is fine;
the chain is kept as ordered.

### Project scope

`<cwd>/.pi/mistral-native.json`, where cwd is the pi session's working
directory. The project file is loaded **only when project trust is active**
(consistent with `.pi/settings.json`). The extension refreshes the project
scope on every `session_start`.

### Writing the file

The file is authored by hand or written by `/mistral set` (see
[the command family](#mistral-command-family)); the guided `/login`
region picker creates the user-scope file — only when no file exists
anywhere in the chain — with just `endpoint.region`. A write never
touches an existing file's other content.

*Decisions: [ADR 0016 — `/mistral` command family: show, set, test](adr/0016-mistral-command-family.md)*

### Merging

Project wins per key. Nested section objects merge key-by-key: a project
key wins, user keys survive otherwise. Environment variables apply for
every key the merged file leaves unset.

## Schema

All sections and keys are optional. An absent key means "unset" (the
value falls through to lower-precedence layers). JSON `null` is a
validation error, not "unset".

```jsonc
{
  // Enabled Mistral built-in server-side tools, by name.
  "serverTools": ["web_search", "web_search_premium", "image_generation", "code_interpreter"],
  // Connector ids or names whose tools are sent with every request.
  "connectors": ["notion", "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f"],
  // Agent id that switches chat requests to Mistral's Agents API.
  "agentId": "my-agent",

  // Client-side connector tools: "enabled" toggles the tool loader
  // (default true), "autoLoad" names connectors registered and
  // activated at session start.
  "connectorTools": { "enabled": true, "autoLoad": ["notion"] },
  // Cost overrides for the model catalog: "rateCard" entries match
  // model ids by substring (the "match" string contained in the model
  // id) and price them per million tokens (checked
  // before the built-in rate card); "fallThrough" controls what
  // unpriced models cost (true: catch-all rates, false: zero-cost
  // placeholder, still flagged approximate).
  "models": {
    "rateCard": [
      { "match": "mistral-large", "rates": { "input": 0.7, "output": 2.1, "cacheRead": 0.07, "cacheWrite": 0 } }
    ],
    "fallThrough": true
  },
  // "streaming" toggles the streamed RAG answer path for knowledge
  // queries; applied per tool family.
  "knowledge": { "streaming": true },
  // RAG document queries: "streaming" (default true) switches the query
  // tool between the streaming path and the legacy one-shot request;
  // "defaultLibraryId" is reserved.
  "rag": { "streaming": true, "defaultLibraryId": "lib-id" },
  // Reserved: validated and exposed, no behavior yet.
  "ocr": { "defaultModel": "mistral-ocr-latest" }
}
```

"Reserved-and-parsed" sections are strictly validated and exposed on the
resolved config, but **no behavior derives from them yet** — they are
reserved for upcoming features. A file written today keeps validating
when those features land.

Five sections are **behavioral** now:

- The `models` section drives the dynamic catalog's rate card —
  `rateCard` entries are checked **before** the built-in family rates
  (a config entry with the same `match` shadows the built-in; new match
  strings work), and `fallThrough` switches unpriced models from the
  catch-all rates to a zero-cost placeholder (still flagged approximate;
  see [catalog.md](catalog.md#family-rate-card-default_rates)).
- The `knowledge`/`rag` streaming toggles: `rag.streaming`
  (default `true`) switches `mistral_document_query` between the
  streaming RAG path and the legacy one-shot request; `rag.streaming`
  wins over `knowledge.streaming`, which wins over
  `MISTRAL_RAG_STREAMING`.
- The `endpoint` section: `region`/`baseUrl` route chat completions and
  the model catalog to the regional endpoint — knowledge APIs,
  server-side tools, agent mode and connectors stay on the global
  endpoint (those services are not available regionally), and regional
  token rates carry a +10% surcharge (details in
  [Region endpoints](#region-endpoints)).
- The `connectorTools` section: `enabled` toggles the client-side
  connector tools loader (default true), `autoLoad` lists connectors
  registered and activated at session start.

There is deliberately no `misc` grab-bag section: strict validation
argues for explicit sections — an unknown key must fail loudly, and a
grab-bag would defeat that.

### Key reference

| Key | Type | Default | Description | Env override |
|---|---|---|---|---|
| `serverTools` | string[] | unset | Enabled Mistral built-in server-side tools; one of `web_search`, `web_search_premium`, `image_generation`, `code_interpreter` (behavioral now) | `MISTRAL_SERVER_TOOLS` |
| `connectors` | string[] | unset | Enabled connector ids or names, sent as `{type:"connector"}` entries (behavioral now) | `MISTRAL_CONNECTORS` |
| `agentId` | string | unset | Agent id switching requests to `/v1/agents/completions`; trimmed, empty-after-trim = unset (behavioral now) | `MISTRAL_AGENT_ID` |
| `endpoint.region` | `"global"` \| `"eu"` \| `"us"` | `"global"` (effective) | Mistral region: routes chat completions and the model catalog; unset in the file when the key is absent | `MISTRAL_REGION` — applies only when no JSON sets `region` |
| `endpoint.baseUrl` | string | unset | Explicit API base URL for chat/catalog; wins over the region mapping; supports the config-value protocol | — |
| `connectorTools.enabled` | boolean | unset | Client-side connector tools loader toggle; effective default `true` | `MISTRAL_CONNECTOR_TOOLS` — "0"/"false"/"off" (case-insensitive) disables; the file wins over env |
| `connectorTools.autoLoad` | string[] | unset | Connectors auto-registered and activated at session start | — |
| `models.rateCard` | `[{match, rates:{input,output,cacheRead,cacheWrite}}]` | unset | Per-family cost overrides, USD per million tokens (behavioral); entries are checked **before** the built-in rate card — a same-`match` entry shadows the built-in, new match strings work; a `""` match applies to every model id and marks all costs approximate (use it deliberately as a full-card override); entry shape aligned with the built-in rate card in `extensions/mistral.ts` | — |
| `models.fallThrough` | boolean | unset | Unpriced models fall through to the catch-all rate (behavioral); `false` gives them a zero-cost placeholder instead — still flagged approximate | — |
| `knowledge.streaming` | boolean | unset | Knowledge tool streaming; applies to the RAG query when `rag.streaming` is unset (behavioral for RAG; other knowledge tools still one-shot) | — |
| `rag.streaming` | boolean | `true` (effective) | RAG query streaming: `false` forces the legacy one-shot request | `MISTRAL_RAG_STREAMING` (`0`/`false`/`off`/`no` = off; applies only when neither JSON key is set) |
| `rag.defaultLibraryId` | string | unset | Default library for RAG queries (RESERVED) | — |
| `ocr.defaultModel` | string | unset | Default OCR model (RESERVED) | — |

*Decisions: [ADR 0011 — Client-side connector tools via the loader pattern](adr/0011-client-side-connector-tools.md); [ADR 0012 — Selectable region endpoint with per-family routing](adr/0012-selectable-region-endpoints.md); [ADR 0013 — Per-family rate card with sourced prices and visible fall-through](adr/0013-rate-card-sourced-prices.md); [ADR 0015 — Streaming RAG document query](adr/0015-streaming-rag-document-query.md)*

## Region endpoints

The `endpoint` section selects Mistral's API region: `global`
(`api.mistral.ai`), `eu` (`api.eu.mistral.ai`) or `us`
(`api.us.mistral.ai`), each with the `/v1` suffix baked in. `MISTRAL_REGION`
is the env fallback (it applies only when no JSON file sets `region`); an
explicit `endpoint.baseUrl` (gateway/proxy escape hatch, config-value
protocol allowed) wins over the region mapping. With no file and no env
variable, the region is `global`.

The region routes **per API family**, not as a global switch — regional
endpoints support only chat completions and function calling, while the
Files, Agents and Batch APIs are global-only:

| API family | Region-aware | Behavior |
|---|---|---|
| Chat-completions stream | yes | posts to the resolved region endpoint |
| Model catalog (`refreshModels`) | yes | fetches the region's model list (model availability differs per region); pi's own `models.json` override still wins |
| Rate card | yes | token rates carry the **+10% regional surcharge** whenever the region is not `global` — config `models.rateCard` entries and built-in family rates alike (cost display stays truthful for catalog-fetched models; the static fallback and restored snapshots keep global rates until the next successful regional refresh) |
| Knowledge APIs (files, libraries, documents, OCR, embeddings) | no | stay on `api.mistral.ai` |
| Server-side tools and agent mode | no | stay on `api.mistral.ai` (the Agents API is not available regionally — even agent-mode chat requests post globally) |
| Connectors | no | stay on `api.mistral.ai` |

**Chat precedence:** with no endpoint configuration at all, the model's
registered `baseUrl` applies (pi's `models.json` model-level overrides
keep working). An explicit
`endpoint.baseUrl` (gateway) applies to **all** chat requests, including
server-tools and agent-mode chat. A bare non-global region routes only
plain chat regionally; server-side tools, connectors and agent mode post
to the global endpoint. `MISTRAL_REGION` provided through pi's
provider-scoped env routes the chat stream; the session-start notice and
the catalog refresh read the file and process-env layers only.

When a non-global region is active, the extension emits **one warning per
session start** (not per call) naming the split and the surcharge.

**Honest data-residency caveat:** regional inference covers model inputs,
outputs and processing; control-plane data (account configuration, API
keys, billing, access management, analytics) may still be handled outside
the selected geography.

*Decisions: [ADR 0012 — Selectable region endpoint with per-family routing](adr/0012-selectable-region-endpoints.md)*

## Config-value protocol (credential-adjacent fields)

`agentId` and `endpoint.baseUrl` are the designated credential-adjacent
fields (gateway base URLs can embed access tokens; agent ids can come
from secret-managed provisioning). Their string values support pi's
resolveConfigValue protocol:

- `$VAR` / `${VAR}` — interpolate an environment variable
- `!command` — execute a shell command (10s timeout); the trimmed stdout
  is the value; empty output resolves to unset; each command runs at
  most once per process (the result is cached)
- `$$` → `$` and `$!` → `!` escapes
- otherwise the value is a literal

A referenced-but-unset environment variable, or a failing command,
resolves the whole value to **unset** (never an error, never logged).
Resolved values are never logged. The API key itself is **not** a
config-file field (see [auth.md](auth.md)).

*Decisions: [ADR 0004 — API-key credential chain without Mistral OAuth](adr/0004-api-key-credential-chain-without-mistral-oauth.md)*

```jsonc
{
  "agentId": "$MISTRAL_AGENT",
  "endpoint": { "baseUrl": "!pass show mistral/gateway-url" }
}
```

## `/mistral` command family

`/mistral` shows a status card with every key's effective value and its
provenance; `/mistral set <key> <value>` writes one key to the **user
scope** (atomic, merge-preserving, validated before the write, verified by
re-reading; the project scope stays hand-edited — it travels with the
repo); `/mistral test` runs a live `GET /v1/models` check naming the
failing step (auth / network / http) with a fix hint. Every key in the
table is settable except `models.rateCard` (hand-edit the file). Within
the command family, only `set` writes: the first `set` creates the
user-scope file (the env-first default stands).

*Decisions: [ADR 0010 — Configuration via mistral-native.json](adr/0010-configuration-via-mistral-native-json.md); [ADR 0016 — `/mistral` command family: show, set, test](adr/0016-mistral-command-family.md)*

## Advanced

### Strict validation

Validation is strict: unknown fields and invalid values are errors, and
errors name the exact file path, the key's section-qualified name and
the valid options:

- Unknown top-level field (known fields alphabetical):

  ```
  unknown field "serverToolss" in ~/.pi/agent/mistral-native.json; known fields: agentId, connectorTools, connectors, endpoint, knowledge, models, ocr, rag, serverTools
  ```

- Unknown key inside a section:

  ```
  unknown field "endpoint.regiion" in ~/.pi/agent/mistral-native.json; known fields: baseUrl, region
  ```

- Invalid value:

  ```
  field "endpoint.region" in ~/.pi/agent/mistral-native.json must be one of: "global", "eu", "us"; got "moon"
  field "serverTools" in ~/.pi/agent/mistral-native.json must be an array of strings; known tools: web_search, web_search_premium, image_generation, code_interpreter
  field "models.rateCard[0].rates.input" in ~/.pi/agent/mistral-native.json must be a non-negative number
  ```

- Malformed JSON:

  ```
  failed to parse ~/.pi/agent/mistral-native.json: Expected double-quoted property name in JSON at position 16
  ```

The provider **never crashes** on a bad file:

- no file → defaults + env;
- malformed or invalid file → the file is **ignored** (env-only degraded
  mode) and the error is surfaced as a warning via pi's UI
  (`ctx.ui.notify`) when the session starts.

Validation is pure and synchronous; loaders never throw to callers.

### Scope loading behavior

| | User scope | Project scope |
|---|---|---|
| Path | resolution chain above (first existing wins) | `<cwd>/.pi/mistral-native.json` |
| Loaded | module load + re-read on every `session_start` | on `session_start`, only with active project trust |
| Merge | base layer | wins per key over user scope |
| Typical use | machine-wide defaults | per-repo overrides (e.g. a project agent id) |
