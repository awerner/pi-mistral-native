# 0017. Documented max-output mapping over fixed clamp

- **Status**: Trial
- **Date**: 2026-11-03

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
deepseek-v4-1-flash-1017).

Wire probing (2026-11-03) then revealed a constraint the model pages do
not document at all: the API ALSO enforces per-model completion-token
ceilings. A live request against mistral-large-4 failed with
`400 invalid_request_max_tokens` (code 3058): "This model supports at most
262144 completion tokens". The 262144 figure for mistral-large-4 —
previously not Mistral-documented — is wire-enforced fact, not display
parity with pi-ai's built-in catalog. "Documented facts" for this mapping
now means documented **or wire-enforced** limits.

Probe method (so future models can be sourced): send a
`POST /v1/chat/completions` request with an oversized `max_tokens`
(e.g. 9999999) and a 1-token prompt; the `400` response (code 3058,
`invalid_request_max_tokens`) message names the true ceiling ("supports at
most N completion tokens"). Verify N by an accepted N and a rejected N+1
probe when feasible (for mistral-large-4: `max_tokens` 262144 is accepted,
262145 is rejected).

## Decision

`maxTokens` derives from documented or wire-enforced facts only, in one
shared mapping (`documentedMaxTokensForModel` +
`API_ENFORCED_COMPLETION_CEILINGS` in `extensions/mistral.ts`):

1. **Wire-enforced ceiling capped at the context window by default:** for
   models without a documented output limit, `maxTokens` is
   `min(completionCeiling(id), contextWindow)`. The completion-ceiling
   table (`API_ENFORCED_COMPLETION_CEILINGS`, checked most-specific-first,
   mirroring the rate card of ADR
   [0013](0013-rate-card-sourced-prices.md)) holds only wire-verified
   ceilings; today that is mistral-large-4 → 262144 (verified by the probe
   method above, 2026-11-03).
2. **Documented overrides win:** a small sourced table
   (`DOCUMENTED_OUTPUT_LIMITS`) pins the documented 128k output limits for
   the hosted `zai-glm` and `deepseek` models — documented limits are the
   tighter, sourced facts; each entry carries a source URL and
   last-verified date as a code comment.
3. **Conservative fallback for unknown models:** ids without a
   wire-verified entry get a conservative fallback
   (`COMPLETION_CEILING_FALLBACK`, 262144) capped at the context window —
   an oversized value hard-fails requests with 400 code 3058, while a
   conservative one merely caps output.

The request path keeps clamping `max_tokens` against the estimated
transcript (pi-ai's clamp) and additionally applies the completion
ceiling, so STALE persisted snapshots from earlier versions (v0.1.0-era
`maxTokens: 1048576` values) cannot reproduce the 400 before the
self-healing catalog refresh overwrites them. The static fallback catalog
(`MODELS`) follows the same mapping — mistral-large-4 carries
`maxTokens = 262144` — so the fallback and the live path never contradict
each other.

## Consequences

- No fixed 32768 clamp and no context-window overshoot: `maxTokens` is now
  a wire-accurate ceiling — the request path can never send a
  `max_tokens` the API rejects with 400 code 3058, and mistral-large-4's
  row no longer over-reports its usable output budget by 4×.
- Unknown models may be conservatively under-reported until probed: the
  fallback caps output below what a model might actually support. A
  too-small value merely caps output; a too-large one hard-fails requests.
- The ceiling table is hand-curated and needs the same dated
  re-verification process as the rate card (`API_ENFORCED_COMPLETION_CEILINGS`
  mirroring `DEFAULT_RATES`); the update path is identical (probe method +
  last-verified date per entry).
- Where Mistral publishes per-model output limits later, the tables grow
  one entry per family; where the API grows a max-output field, the table
  defers to it.
- Display parity with pi-ai's built-in Mistral catalog is deliberately
  not a goal: this catalog reports Mistral's documented and wire-enforced
  facts.
