# 0005. OCR, embeddings, moderations/classifications as pi tools

- **Status**: Trial
- **Date**: 2026-10-30

## Context

Mistral's knowledge-side APIs — `/v1/ocr`, `/v1/embeddings`,
`/v1/moderations` (and `/v1/chat/moderations`), `/v1/classifications`
(and `/v1/chat/classifications`) — can be exposed through pi either as
pi tools (`pi.registerTool()`) or as pi classifier implementations
(`classifiers: { "<api>": { classify } }`, reachable via codemode).
pi's classifier contract
(`ClassifierContext`: caller-supplied `state` plus per-question
`type: choice|score|bool` with caller-defined `criteria` labels; answers
with probabilities) assumes an *arbitrary-label* classifier the caller can
question about anything. Mistral's two families differ:

- **Moderations** returns server-fixed categories (`sexual`,
  `hate_and_discrimination`, …) with boolean flags and per-category scores.
  There is no way for a caller to define custom questions or labels.
- **Classifications** score inputs against *training-time* targets of a
  fine-tuned model (labels fixed at training, per
  `ClassifierTargetResult`). The request (`ClassificationRequest`) carries
  only `model` + `input`; callers cannot express custom criteria either.

Neither fits pi's `classify()` contract: the question labels would have to
be invented by the adapter rather than chosen by the caller, and score
semantics differ (per-category probability vs expected-level index).
Faking a `classify()` implementation over them would misrepresent the
APIs and produce meaningless confidences. OCR and embeddings have no
classifier analog at all (OCR is document→markdown; embeddings are raw
vectors, which pi's classifier contract cannot express).

## Decision

Expose all four families as **pi tools** registered by the extension:

| API | pi surface | Tool | Why |
|---|---|---|---|
| `/v1/ocr` | pi tool | `mistral_ocr` | File/image → per-page markdown + structured JSON (`outputSchema`); no classifier analog |
| `/v1/embeddings` | pi tool | `mistral_embed` | Input texts → vectors; raw vectors fit a tool's `structuredContent`, not `ClassifierResult`; useful for RAG |
| `/v1/moderations` | pi tool | `mistral_moderate` | Fixed server categories cannot express caller-defined questions; tools return the raw category flags/scores |
| `/v1/classifications` | pi tool | `mistral_classify` | Training-time labels cannot express caller-defined criteria; tools take the model id + input and return per-target scores |

The chat variants (`/v1/chat/moderations`, `/v1/chat/classifications`)
take **message arrays** (`ChatModerationRequest`), which the tools' plain
string inputs cannot express; they are **deferred** until chat-shaped
transcript input is available. The plain endpoints cover the same
categories/targets.

No `classifiers:` implementations are registered for this provider: pi's
classifier contract does not fit. All tools resolve the API key through
pi's provider auth (`ctx.modelRegistry`, per
`docs/custom-provider.md` "Provide authentication"), fall back to
`$MISTRAL_API_KEY`, and share one Mistral HTTP client module with mocked-HTTP
tests. Wire formats follow the vendored spec (ADR 0003).

## Consequences

- The model reaches the APIs directly as tools (no codemode round-trip);
  results are structured (`structuredContent`), which codemode scripts can
  also consume.
- Moderations/classifications cannot back `models.classify()`; if pi ever
  relaxes the classifier contract toward fixed-label servers, revisit.
- Tool surfaces are additive: the library/RAG tools reuse
  `mistral_embed` for document embeddings (ADR 0006).
