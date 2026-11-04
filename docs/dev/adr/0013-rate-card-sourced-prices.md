# 0013. Per-family rate card with sourced prices and visible fall-through

- **Status**: Trial
- **Date**: 2026-10-31

## Context

`GET /v1/models` returns no prices: `BaseModelCard` (vendor
OpenAPI spec, ADR [0003](0003-vendored-openapi-spec.md)) has no price fields,
only a billing label (`billing_model_name`). No public machine-readable
pricing source exists. `/v1/admin/usage` returns the org's actual price
catalog, but it requires an **AdminApiKey** (Enterprise plans only,
org-scoped, `beta.admin.billing` per the vendored spec) — it is not a general
pricing source for a published plugin, and the plugin cannot detect
admin-key credentials from the pi credential chain. An earlier rate card
therefore used a flagship fall-through for unpriced families: wrong costs
for most families (e.g. ministral, pixtral, open-mistral) and silent
approximation with no way for the user to tell.

## Decision

Hand-curated **per-family rate card** (`DEFAULT_RATES` in
`extensions/mistral.ts`) — zero new runtime dependencies (ADR
[0008](0008-direct-fetch-over-vendor-sdk.md)): each entry carries a source
URL and last-verified date as a code comment, most-specific-first ordering
(`pixtral-large` before `pixtral`), and a `""` catch-all mirroring the
flagship rates. The **update process** is: verify against the official
family pricing table (<https://docs.mistral.ai/inference/pricing>) at
implementation time and record source + date per rate. Each verification records
source and date, so price changes supersede earlier entries through this
dated process.

Configuration overrides (ADR
[0010](0010-configuration-via-mistral-native-json.md)): `mistral-native.json`
`models.rateCard` entries are checked **first** — a config entry with the
same `match` as a built-in shadows it, and new match strings work;
precedence chain project JSON > user JSON > env > built-in defaults (there
is no rateCard env var). `models.fallThrough: false` gives unpriced models
a zero-cost placeholder instead of the catch-all rates.

**Fall-through stays visible:** `refreshMistralModels` computes the
fall-through ids once per refresh cycle (not per model call) via the pure
helper `fallThroughModelIds` and records them in a module-state notice
(`lastFallThroughNotice()`); the extension's `session_start` handler
surfaces the notice at most once per notice via `ctx.ui.notify` — the same
channel as config warnings. The extension itself performs no logging (ADR
0004 no-logging invariant). Ids that hit the catch-all are flagged
approximate so cost display can mark them.

The admin-key `/v1/admin/usage` option is **deferred** as future work:
org-scoped, Enterprise-only, admin-key-gated — not generalizable to plugin
users. If Mistral ever publishes a machine-readable pricing endpoint, a
later change can source the card from it.

All dynamic-catalog costs resolve through the single documented point
`ratesAndFallThroughForModel` / `effectiveRatesForModel`: the region-surcharge
multiplier (×1.1 for EU/US regional endpoints,
<https://docs.mistral.ai/inference/regional-inference>) will apply there.

## Consequences

The card can lag published prices between updates; the dated sources make
drift auditable rather than silent. Fall-through ids show approximate costs
until curated (zero-cost with `fallThrough: false`) — the once-per-refresh
notice names them. Deprecated/retired families stay priced so gateway ids
still resolve. A mid-session network refresh surfaces its notice at the
next `session_start`, not immediately. The region surcharge (ADR 0012)
multiplies rates at the single hook in the rate mapping, keeping the
rate-card core cohesive.
