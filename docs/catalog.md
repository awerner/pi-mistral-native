# Dynamic model catalog

## What you can do

- **Use every current Mistral model** — the model list refreshes from
  Mistral's live catalog, so newly released models appear (and retired
  ones disappear) without any package update. Just pick a
  `mistral-native/…` model in pi.
- **See real costs** — every model carries current pricing, so pi's
  usage and cost display is meaningful out of the box.
- **Work offline** — startup works without network; the last fetched
  catalog snapshot restores automatically (a static fallback applies
  on the very first start).
- **Check the connection on demand** — `/mistral test` runs a live
  catalog check with a fix hint on failure. The live catalog check
  requires the extension to be loaded (`pi -e <path>` or a registry
  install); a bare `pi --list-models` without the extension loaded
  shows no mistral-native rows.
- **Fix prices yourself if needed** — `models.rateCard` overrides in
  `mistral-native.json` let you correct or extend any price without
  waiting for a package update:

  ```json
  { "models": { "rateCard": [
      { "match": "mistral-large", "rates": { "input": 0.7, "output": 2.1, "cacheRead": 0.07, "cacheWrite": 0 } }
  ] } }
  ```

No configuration needed — the catalog maintains itself.

*Decisions: [ADR 0003 — Vendored OpenAPI spec](adr/0003-vendored-openapi-spec.md)*

## How it works

The provider registers a `refreshModels` handler so pi's model catalog
always reflects Mistral's live model list — while offline startup still
works — and prices every model from a sourced family rate card, so
pi's cost display stays truthful.

### Live refresh, offline startup

pi calls `refreshModels` in two phases:

1. **Offline phase** (at startup, no network): the persisted catalog
   snapshot restores from pi's model store without any network access.
   When no snapshot exists yet, a static fallback catalog
   (mistral-large-4) applies.
2. **Network phase** (when allowed): the live model list is fetched
   from `GET /v1/models` and persisted, so the next offline startup
   restores it.

The fetched endpoint is region-aware: `context.baseUrl` (pi's own
`models.json` override) wins, otherwise the resolved region endpoint
applies — `api.eu.mistral.ai` / `api.us.mistral.ai` when the effective
config selects a non-global region. Model availability differs per
region, so a regional catalog may legitimately contain fewer models.

Failure behavior is deliberately conservative: an auth failure throws
a clean error so pi surfaces it in the UI; network unavailability,
server errors or malformed bodies keep the **last-known list**; a
successful fetch mapping to an **empty catalog** also keeps the
last-known list; an abort returns it quietly; an unconfigured provider
returns an empty list without any fetch.

*Decisions: [ADR 0012 — Selectable region endpoint with per-family routing](adr/0012-selectable-region-endpoints.md)*

### Pricing: the family rate card

`GET /v1/models` does not return prices, so costs come from a family
rate card checked **most-specific-first**: the first entry whose
`match` string is a substring of the model id applies, with a final
catch-all entry so every id gets a price. Units are USD per million
tokens (input/output/cacheRead/cacheWrite). Every entry carries a
source URL and a last-verified date, so drift stays auditable; the
update process is to re-verify against
[the family pricing table](https://docs.mistral.ai/inference/pricing)
and record source + date per rate.

| Family | Input | Output | Cache read |
|---|---|---|---|
| mistral-large | 0.70 | 2.10 | 0.07 |
| mistral-medium | 1.50 | 7.50 | 0.15 |
| mistral-small | 0.15 | 0.60 | 0.015 |
| magistral | 2.00 | 5.00 | 0.20 |
| codestral | 0.30 | 0.90 | 0.03 |
| ministral | 0.15 | 0.15 | 0.015 |
| pixtral-large | 2.00 | 6.00 | 0.20 |
| pixtral | 0.15 | 0.15 | 0.015 |
| devstral | 0.40 | 2.00 | 0.04 |
| open-mistral | 0.15 | 0.15 | 0.015 |
| catch-all | 0.70 | 2.10 | 0.07 |

Last verified: **2026-10-31** against Mistral's per-model pricing
pages; retired models without published prices fall through to the
catch-all.

Config overrides: `mistral-native.json` `models.rateCard` entries are
checked **before** the built-in card — a config entry with the same
`match` shadows the built-in, and new match strings work. A config entry
with `match: ""` prices the entire catalog and marks every cost
approximate. Precedence chain: project JSON > user JSON > env >
built-in defaults.

Model ids that hit the catch-all (or match nothing) get fall-through
pricing and are flagged approximate; the extension surfaces a
once-per-notice warning at the next session start, and
`models.fallThrough: false` swaps the catch-all rates for a zero-cost
placeholder (still flagged approximate).

*Decisions: [ADR 0010 — Configuration via mistral-native.json](adr/0010-configuration-via-mistral-native-json.md); [ADR 0013 — Per-family rate card with sourced prices and visible fall-through](adr/0013-rate-card-sourced-prices.md)*

### Regional pricing

Regional endpoints (EU/US) carry a **+10% price premium** on eligible
input, output and cached-token rates. Whenever the effective region is
not `global`, every resolved cost is multiplied by the surcharge factor
inside the single rate-resolution point, so pi's cost display stays
truthful; the rate cards themselves are never mutated.

*Decisions: [ADR 0012 — Selectable region endpoint with per-family routing](adr/0012-selectable-region-endpoints.md)*

### Which models appear

Model cards from `/v1/models` are mapped to pi chat-model configs with
these rules: keep only **chat-capable** models; drop **internal** and
**archived** models; drop **deprecated** models — but ignore the
deprecation filter when that would drop every eligible model (a
deprecated-only catalog is still better than none); sort the result by
id. Vision-capable models accept image input; reasoning-capable models
expose pi's thinking levels (see
[stream.md](stream.md)); `max_context_length` becomes the context
window; costs come from the effective family rate card above.

#### Max output tokens

`maxTokens` follows Mistral's documented facts: the API returns no
per-model max-output field, and Mistral-native model pages document no
output limit — the only documented constraint is that prompt plus
completion tokens must fit `max_context_length`. So `maxTokens` is the
context window by default, with one override table for the models where
Mistral documents an explicit output token limit (checked
most-specific-first, mirroring the rate card):

| Model family | Documented output limit | Context |
|---|---|---|
| zai-glm (zai-glm-5-3, zai-glm-5-3-flash) | 128k | 1M |
| deepseek (deepseek-v4-1-flash-1017) | 128k | 1M |

The static fallback catalog follows the same mapping, so the fallback and
the live path never contradict each other.

Last verified: **2026-11-02** against the model pages on
[docs.mistral.ai](https://docs.mistral.ai/models); re-verify per entry
when updating the override table.

*Decisions: [ADR 0017 — Documented max-output mapping over fixed clamp](adr/0017-documented-max-output-mapping.md)*

## Advanced: refreshModels implementation

- **Snapshot fidelity:** the offline restore preserves optional fields
  like `thinkingLevelMap`, `promptCache`, `inputLimits`, `headers`,
  `samplingParams` and `compat`, so a restore round-trip loses no model
  fidelity. The network phase persists the full chat model objects via
  `context.publish({ persist: … })` so the next offline phase can
  restore them; the handler is `refreshMistralModels` in
  `extensions/mistral.ts`.
- **Wire shapes:** `BaseModelCard`, `FTModelCard` and `ModelList` follow
  the vendored OpenAPI spec, which is the authoritative reference.
- **Regional surcharge mechanics:** the surcharge
  (`MISTRAL_REGION_SURCHARGE`, 1.1, rounded to 4 decimals) applies to
  config `models.rateCard` entries and built-in family rates alike, at
  catalog-mapping time — the static `MODELS` fallback and restored
  snapshots keep global rates until the next successful regional
  refresh. The single rate-resolution point is `resolveRates`; rate
  cards are never mutated.
- **Fall-through notice mechanics:** `refreshMistralModels` computes
  the fall-through ids **once per refresh cycle** (not per model call)
  and records them in a module-state notice readable via
  `lastFallThroughNotice()` (`{ ids, at }`); the extension surfaces it
  via `ctx.ui.notify(..., "warning")` on the next `session_start`
  (the extension itself performs no logging).

*Decisions: [ADR 0013 — Per-family rate card with sourced prices and visible fall-through](adr/0013-rate-card-sourced-prices.md); [ADR 0012 — Selectable region endpoint with per-family routing](adr/0012-selectable-region-endpoints.md)*
