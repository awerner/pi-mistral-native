# 0024. Web search canonical name and premium flag

- **Status**: Trial
- **Date**: 2026-11-08

## Context

Web search shipped as two client-side pi tools,
`mistral_web_search` and `mistral_web_search_premium`
(ADR 0018 — Web search as a Conversations-backed tool), differing only in
the Conversations tool type they request. Two observations drove a
reconsideration:

- `web_search` is the canonical tool name throughout the ecosystem: Mistral's
  own connector is named `web_search`, and pi-ecosystem tool inventories and
  allowlists match on the bare name. The `mistral_` prefix broke pre-defined
  tool allowlists that reference the canonical name — users had to know and
  allowlist the prefixed variant instead.
- Two tools for one capability doubled the tool inventory for the same
  functionality; the premium variant existed solely to make the pay-per-use
  cost an explicit opt-in.

The provider's other model-callable tools (code interpreter, knowledge and
document tools, connector tools, OCR/embeddings/moderations/classify) also
carry the `mistral_` prefix, but no ecosystem allowlist pressure exists for
them: they are not Mistral connector names, and renaming them is not
warranted at this stage. The pre-stable 0.1.x phase allows a breaking rename
while the stored-session surface is still small.

## Decision

Web search ships as **one client-side pi tool named `web_search`**
(`extensions/tools/web-search.ts`), keeping the stateless one-shot
Conversations design of ADR 0018 unchanged:

- Parameters: `query` (string, required) and `premium` (optional boolean,
  default `false`). `premium: true` routes the call to the
  `web_search_premium` Conversations tool type (pay-per-use premium search
  quality); `premium: false` (or absent) requests the standard `web_search`
  tool type. The Mistral-side tool type names are unchanged.
- The pay-per-use cost warning appears in **both** the tool description and
  the `premium` parameter description, preserving the deliberate opt-in that
  the separate premium tool carried: the model sees the cost at the point of
  choice, not only when browsing the tool list.
- Output schema, parsing (hits plus the optional `skipped` marker), usage
  mapping and error handling (including the 3004 refusal mapping) are
  unchanged from ADR 0018. The tool's result `details` carry `premium: true`
  when the premium variant ran — the tool name no longer encodes the
  variant, so the persisted details keep it for diagnostics.
- The server-side tools config surface
- The server-side tools config surface (`serverTools` values `web_search` /
  `web_search_premium` in chat-completions requests) is a different surface
  and keeps its wire names.
- The other `mistral_*` tools keep their names. Where an allowlist needs the
  canonical form for those, explicit allowlist configuration is the
  warranted path; no further renames are planned.

## Consequences

- Pre-defined tool allowlists matching the canonical `web_search` name work
  without extension-specific entries.
- The tool inventory halves: one tool covers standard and premium search.
- **Breaking for stored sessions**: transcripts recorded with
  `mistral_web_search` / `mistral_web_search_premium` tool calls no longer
  resolve the tool by name on replay. Accepted pre-stable (0.1.x); the
  changelog notes it.
- The premium opt-in moves from tool selection to parameter choice: the
  cost warning in the parameter description is the guard that keeps the
  pay-per-use variant deliberate.
- ADR 0018's "premium as a separate tool" decision is superseded; its
  current-state sections point here.

## Record discipline

- The record describes the **current state** of the decision. Never append
  dated update blocks; integrate changes into the sections above (the
  evolution lives in git history).
- Self-contained: no issue/tracker references, no "see issue #N" — the
  Context/Decision/Consequences must stand alone.
- Cross-ADR references cite number and title: `ADR NNNN — Title`.
