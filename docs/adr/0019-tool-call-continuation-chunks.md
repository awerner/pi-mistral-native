# 0019. Tool-call continuation chunks append to the open call

- **Status**: Trial
- **Date**: 2026-11-03

## Context

`delta.tool_calls` entries in a chat-completions stream are assembled by
exact key: stream `index`, then call `id`. Some model families routed
through the chat-completions endpoint emit **continuation chunks** —
argument-only deltas that carry neither `id` nor `index` nor
`function.name`. With exact-key matching alone, such a chunk matches no
existing block and falls through to creating a new tool call with an
empty name: a phantom call whose arguments are split across two blocks,
and whose `toolcall_start` fires twice for one logical call. The same
hole exists in both assembly paths of this provider: the client
tool-call block path and the server-tools pending-candidate path.

## Decision

A delta with no `function.name` **and** no `id` is a continuation: when
no exact `index`/`id` match exists, it appends to the most recently
opened tool-call block (client path) or the most recently opened,
not-yet-folded pending candidate (server-tools path). A continuation
with no open block/candidate is dropped — there is nothing valid to
append to, and creating a block would be the phantom-call bug. Exact-key
matching stays primary; the continuation fallback only runs when no
exact match exists. The `!toolCall.id` term in the discriminator is
load-bearing: a nameless delta *with* an `id` is a legitimate call
header whose name is backfilled by a later delta, and must never be
treated as a continuation.

## Consequences

- Argument fragments split across id-less/index-less/name-less chunks
  reassemble into the single real call; `toolcall_start` fires once per
  real call and `toolcall_delta` carries the appended arguments on the
  same block.
- The stream-event contract is unchanged; only the block-resolution
  fallback is new.
- A continuation arriving with no open call is silently dropped (same
  choice as the reference behavior upstream), which is strictly safer
  than inventing an empty-name call.
- Both assembly helpers can now return `undefined` (dropped
  continuation), so their callers guard with a `continue`.
