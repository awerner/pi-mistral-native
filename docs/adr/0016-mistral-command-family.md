# 0016. `/mistral` command family: show, set, test

- **Status**: Trial
- **Date**: 2026-02-14

## Context

The config layer (ADR
[0010](0010-configuration-via-mistral-native-json.md)) is strictly validated
and layered (project JSON > user JSON > env > defaults), but inspecting it
means reading the file by hand, and setting a value means hand-editing JSON
with no feedback. The config-UX research recommended a small command family
as the top improvement: a status card showing where every effective value
comes from, a `set` that writes safely, and a live connectivity check.

Two forces shape the write side. First, a trust boundary: the project-scope
file `.pi/mistral-native.json` is part of the repository (it travels with
commits and reviews), so a command silently writing it would let a local
command mutate what every contributor sees — it stays hand-authored. Second,
ADR [0004](0004-api-key-credential-chain-without-mistral-oauth.md)'s
env-first default: no file must ever be created speculatively, or the
out-of-the-box behavior stops being "no config, just env".

## Decision

Add a `/mistral` command family (registered by the extension, implemented
in `extensions/mistral/commands.ts`), three subcommands:

- **`/mistral`** (bare): a status card listing every behavioral key's
  effective value with its **provenance** — which layer supplied it
  (`project file <path>`, `user file <path>`, `env <VAR>`, `default`,
  `unset`) — plus the config paths in the chain and the auth source label
  (never the key value). Values using the config-value protocol display
  the raw stored string, never the resolved one.
- **`/mistral set <key> <value>`**: writes **user scope only** — the first
  existing file in the user chain, else the chain head, created on first
  `set` (never speculatively). Atomic (temp file + rename in the same
  directory), merge-preserving (other keys survive), validated via
  `validateMistralFileConfig` **before** the write, and write-then-verified
  by re-reading the chain. Unknown keys and `models.rateCard` (nested
  object array, no sane single-string encoding) get a Usage error pointing
  at the documented keys and the file for hand-editing.
- **`/mistral test`**: a live `GET /v1/models` check with a named failing
  step (auth / network / HTTP status) and a concrete fix hint per failure.

Invariants the command layer commits to:

1. **File-as-truth, no shadow state**: commands re-read the user and project
   scopes at invocation time via the pure loaders — never the module-level
   `session_start` snapshot (`getEffectiveMistralConfig`) and never the
   test override. Only a *successful* `set` calls `refreshMistralConfig`
   to sync the live session; a bare status read never mutates cached state.
2. **Project scope is read-only for commands**: `set` refuses to write it
   and the card says so when a project key shadows a user key.
3. **No speculative file creation**: the user file is created only by an
   explicit first `set` (extending ADR 0010's "authored by hand" note).
4. **Never render secrets**: the API key is never displayed; auth shows the
   source label only.
5. **Non-TUI degradation**: output rides `ctx.ui.notify` only — it works
   in TUI and RPC modes; pi binds no UI context in print/json modes, so
   the command is silent there by pi's own contract (no separate plain
   print channel in v1).

## Consequences

Easier: one command answers "why is this value active?"; setting a key is
safe, validated, and idempotent-by-value; connectivity failures name their
step instead of a bare status code.

Given up / accepted: `set` covers single-string keys only (nested
`models.rateCard` stays hand-edited; the Usage error says so); env values
set through pi's provider-scoped `options.env` are invisible to the card
(it reports process env — the same documented limitation as the region
notice, ADR 0012); other concurrent pi sessions pick up a written value at
their next `session_start`. The write is same-directory-rename atomic but
does not preserve the target's file mode (same trade-off as the login
region write).
