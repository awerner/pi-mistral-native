# 0021. Cost estimates marked as not provider-billed

- **Status**: Trial
- **Date**: 2026-11-03

## Context

pi-ai 1.5 distinguishes billed from estimated costs on the usage cost
block: `cost.totalFromProvider?: boolean` — `true` means the provider
reported the billed total, `false` (or absent) means the total is a
local catalog estimate. Mistral's chat-completions and Conversations
wire formats report **token counts only** (`UsageInfo`); billed totals
live behind the admin-only `/v1/admin/usage` endpoint, which is
Enterprise/org-scoped and admin-key-gated (ADR 0013 — Per-family rate
card with sourced prices and visible fall-through). So every cost this
extension computes is a catalog estimate, and without an explicit flag
the host cannot tell the two apart.

## Decision

Every cost block the extension emits sets the pi-ai cost flag
`totalFromProvider: false` explicitly:

- `zeroUsage()` and `parseUsage()` in `extensions/mistral.ts` (chat
  streams — chunk-level usage, choice-level usage, and the zero-usage
  fallback all flow through these two functions);
- `parseSearchUsage()` in `extensions/tools/web-search.ts` and
  `parseRagUsage()` in `extensions/tools/knowledge.ts` (tool-result
  usage).

The flag is set on a **local cost-block type** (`CostBlock`) that adds
the optional field on top of the host `Usage["cost"]` type, because the
dev-locked pi-ai 1.4.0 types predate the field while the peer range is
`"*"` — the package keeps type-checking and passing its suite against
both 1.4.x and 1.5.0 hosts. In `parseUsage()` the flag is set both
before and after `calculateCost()` so it survives regardless of whether
the host's `calculateCost` sets it (pi-ai 1.5 sets it to `false`; 1.4
does not touch it).

The **`connector_tokens` cost-0 path is deliberate**: web-search usage
reports cost 0 (marked as an estimate) because pay-per-use connector
tokens are not priceable locally. No admin-usage-backed billed mode is
added — deferred per ADR 0013 (admin-key-gated, not generalizable to
plugin users).

## Consequences

Cost display in pi 1.5+ hosts can correctly show estimates as estimates
instead of presenting them as billed amounts; on 1.4.x hosts the extra
field is inert. Tool-result usage (web search, RAG) stays cost-0 by
design, now visibly marked as an estimate. If Mistral ever exposes a
billed total on the chat wire format (or a non-admin pricing endpoint),
a later change can flip the flag to `true` for that path only.

## Record discipline

- The record describes the **current state** of the decision. Never append
  dated update blocks; integrate changes into the sections above (the
  evolution lives in git history).
- Self-contained: no issue/tracker references — the
  Context/Decision/Consequences must stand alone.
- Cross-ADR references cite number and title: `ADR NNNN — Title`.
