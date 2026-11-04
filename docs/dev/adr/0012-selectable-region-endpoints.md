# 0012. Selectable region endpoint with per-family routing

- **Status**: Trial
- **Date**: 2026-11-05

## Context

Mistral offers selectable API regions ("global", "eu", "us"):
the chat-completions and models endpoints exist regionally
(`api.eu.mistral.ai`, `api.us.mistral.ai`), but not every Mistral surface
does. The Files, Agents and Batch APIs — the backbone of the knowledge
tools (ADR 0006), server-side tools/connectors (ADR 0007) and agent
mode — are global-only. Mistral also prices regional processing at a
+10% token-rate premium over the global rate card. The config layer
(ADR 0010) already parses `endpoint: { region, baseUrl }`, with
`MISTRAL_REGION` as the env fallback.

## Decision

Route per family instead of switching the provider wholesale:

- **Chat completions and the model catalog** follow the effective
  region: an explicit `endpoint.baseUrl` (config-value protocol allowed)
  wins over the region mapping, which wins over the global default.
  With **no endpoint configuration** (region "global", no explicit
  `baseUrl`), the stream posts to the model's registered `baseUrl` —
  pi's `models.json` model-level overrides keep working, byte-for-byte the
  no-config behavior. An explicit `endpoint.baseUrl` applies to **every
  chat mode** — the user declared "my Mistral API lives there" — while a
  bare non-global region routes only plain chat regionally:
  server-execution surfaces (server-side tools, connectors, agent mode)
  post to the global endpoint, because those services are not available
  regionally. Catalog refresh resolves the same way; pi's own
  `context.baseUrl` override still wins over both, and the persisted
  models carry the resolved regional base URL.
- **Knowledge APIs, server-side tools, connectors and agent mode stay on
  the global endpoint** — those services are not available regionally.
  Registration-time constants stay global too: the provider is not
  re-registered at `session_start` (pi's runtime re-merge is undocumented
  behavior); the stream reads the config dynamically per call instead.
- **Rates**: every resolved cost — config `models.rateCard` entries and
  built-in family rates alike — is multiplied by `MISTRAL_REGION_SURCHARGE`
  (+10%, rounded to 4 decimals) inside the single rate-resolution point
  (the `resolveRates` hook, ADR 0013) whenever the effective region is
  not "global".
- A one-time `session_start` warning notifies the user when a non-global
  region is active, including the note that control-plane data (account,
  billing, analytics) may still be handled outside the region.

## Consequences

- **Easier:** env-only setups stay byte-for-byte unchanged (default
  "global"); one knob (`endpoint.region` or `MISTRAL_REGION`) moves every
  regionally available surface; knowledge/agent features keep working
  under a regional setting instead of breaking.
- **Harder:** cost transparency — the surcharge is applied by
  configuration, so the numbers differ from Mistral's published global
  rate card; users must rely on the session-start warning. Regional
  endpoints gain features over time, so the per-family split needs
  revisiting when Mistral regionalizes more APIs (each would become a
  scoped change behind the same `resolveMistralRegionBaseUrl` resolution).
- **Accepted risk (notice):** the notice is recomputed inside
  `session_start` after the config refresh, so project-scoped regions
  warn from the session that activates them. The remaining gap: a
  `MISTRAL_REGION` provided through pi's provider-scoped env
  (`options.env`) routes the chat stream but is invisible to the notice
  and the catalog refresh, which read the file/process-env layers only.
- **Accepted risk (rates):** the surcharge applies at catalog-mapping
  time only; the static `MODELS` fallback and restored snapshots keep
  global rates until the next successful regional refresh
  (offline/regional-switch windows show global rates) — accepted pending
  the rate card builds on the same hook.
