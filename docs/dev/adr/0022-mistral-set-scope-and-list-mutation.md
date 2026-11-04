# 0022. Project-scope writes and list mutation for `/mistral set`

- **Status**: Trial
- **Date**: 2026-11-04

## Context

ADR [0016](0016-mistral-command-family.md) — `/mistral` command family:
show, set, test — made `set` user-scope-only (the project file
`.pi/mistral-native.json` travels with the repo — a trust boundary) and
its writes whole-value only: setting a project-scoped value or adding
one entry to a list meant hand-editing JSON.

Separately, pi 1.5.0's completion contracts broke the shipped
completion at every argument position past the command name. The apply
contract replaces the **entire argument string** with the selected
item's value, and the shipped items carried bare last tokens — so
applying a suggestion deleted the preceding tokens (`set ` vanished).
And explicit Tab on a slash line containing a space issues a *forced*
request, which skips extension argument completions — so Tab fell
through to file completion.

## Decision

1. An explicit `--project` flag opts into writing the project scope:
   `/mistral set --project <key> <value>` writes
   `<cwd>/.pi/mistral-native.json` (the project path of ADR
   [0010](0010-configuration-via-mistral-native-json.md) —
   Configuration via mistral-native.json) through the same
   validate-then-atomic-write path as the user scope, gated on pi's
   project trust and refused with a clear message otherwise; the user
   scope stays the default. The ADR 0016 trust-boundary concern is
   answered by the explicit opt-in plus the trust gate: a command write
   is as visible in the repo diff as a hand edit. This supersedes ADR
   0016's "project scope is read-only for commands" invariant for `set`.
2. List-kind keys (`serverTools`, `connectors`,
   `connectorTools.autoLoad`) accept `+entry` (append, deduplicated)
   and `-entry` (remove). Removing an absent entry is a no-op with a
   note, never an error, and nothing is written when nothing changes.
   A bare key still clears the list; a plain comma-separated value
   still replaces it wholesale. `+`/`-` prefixes are parsed only for
   list-kind keys — a string value starting with `+`/`-` is stored
   literally.
3. Completion items carry the complete new argument text as `value`
   (the label shows the completing token), and a registered
   autocomplete-provider wrapper answers `/mistral` argument lines —
   including forced (Tab) requests — delegating everything else to the
   built-in provider. The `registerCommand` completion remains as the
   fallback contract for consumers without the wrapper (static hints
   there).

## Consequences

- A fully discoverable setter: value hints at the value position and Tab
  completion at every argument position.
- No-op mutations never touch the file — an unset list stays unset, so
  the environment fallback is preserved.
- The autocomplete-provider wrapper owns `/mistral` argument lines
  entirely: file/`@` completion no longer applies inside them.
- The wrapper is a deliberate coupling to pi 1.5.0's documented
  autocomplete-provider composition.
- The project file is now command-writable, which reviewers see in the
  repo diff like any hand edit.
