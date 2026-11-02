# 0017. Documented max-output mapping over fixed clamp

- **Status**: Trial
- **Date**: 2026-11-02

## Context

The live catalog maps every `GET /v1/models` card to a pi chat-model
config, which requires a `maxTokens` value (maximum completion tokens).
Mistral's model cards expose no max-output field at all: `BaseModelCard` /
`FTModelCard` (ADR [0003](0003-vendored-openapi-spec.md)) carry only
`max_context_length`, whose OpenAPI schema default is 32768 — a default for
an absent context length, not a completion cap. The original mapping read
that schema default as a cap (`maxTokens = min(32768, contextWindow)`),
which clashed with the static fallback catalog (262144 for
mistral-large-4, mirroring pi-ai's built-in catalog) — an 8×
self-contradiction for the same model.

Research against docs.mistral.ai (2026-11-02): Mistral-native model pages
document **no per-model output limit** — the only documented constraint on
completions is that prompt plus completion tokens must fit
`max_context_length` (Chat Completions `max_tokens` description; the
known-limitations page adds that exceeding the context window returns
`400`). The hosted third-party models are the only ones with a documented
output token limit (128k for zai-glm-5-3, zai-glm-5-3-flash and
deepseek-v4-1-flash-1017). The 262144 figure for mistral-large-4 is not
Mistral-documented today; it originates from pi-ai's own catalog. The
owner decision for this mapping is **upstream wins**: the mapping follows
Mistral's documented facts, not display parity with pi-ai's built-in
catalog.

## Decision

`maxTokens` derives from documented facts only, in one shared mapping
(`documentedMaxTokensForModel` + `DOCUMENTED_OUTPUT_LIMITS` in
`extensions/mistral.ts`):

1. **Context window by default:** for models without a documented output
   limit (all Mistral-native families), `maxTokens` is the card's
   `max_context_length` — the only documented bound on completions.
2. **Documented overrides:** a small sourced table (checked
   most-specific-first, mirroring the rate card of ADR
   [0013](0013-rate-card-sourced-prices.md)) pins the documented 128k
   output limits for the hosted `zai-glm` and `deepseek` models; each entry
   carries a source URL and last-verified date as a code comment.
3. **Context-capped:** the override is capped at the context window, so a
   stale table entry can never exceed it.

The request path keeps clamping `max_tokens` against the estimated
transcript (pi-ai's clamp), so the mapping is a ceiling, not a promise of
room. The static fallback catalog (`MODELS`) follows the same mapping —
mistral-large-4 carries `maxTokens = contextWindow` — so the fallback and
the live path never contradict each other.

## Consequences

- No fixed 32768 clamp: mistral-large-4's live row no longer under-reports
  its usable output budget by 8×; conversely, `maxTokens` may now exceed
  what the model will actually generate in practice — it is a documented
  ceiling, not a guaranteed budget, and Mistral may end completions early
  by its own discretion.
- The override table is hand-curated and needs the same dated re-verification
  process as the rate card; the update path is identical (source URL +
  last-verified date per entry).
- Where Mistral publishes per-model output limits later, the table grows
  one entry per family; where the API grows a max-output field, the table
  defers to it.
- Display parity with pi-ai's built-in Mistral catalog is deliberately
  not a goal: this catalog reports Mistral's documented facts.
