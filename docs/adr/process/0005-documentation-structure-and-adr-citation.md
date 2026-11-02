# 0005. Documentation structure and ADR citation convention

- **Status**: Trial
- **Date**: 2026-11-01

## Context

Audience layers were mixed: README.md carried user content (features,
install, configuration) and developer content (Development + Layout
sections) in one file. ADR citations were inline everywhere across README.md and the docs
pages, interrupting prose flow, and tables carried ADR refs inside
cells. End users,
contributors and agents each need their own layer without reading the
others' material.

## Decision

**1. Four-layer documentation structure:**

| Layer | Location | Audience | Content |
|---|---|---|---|
| Landing | `README.md` | End users | Quickstart (before Features), "What you can do" capability list, Install, Configuration pointer — only that; a short pointer paragraph defers development topics to `docs/development.md` |
| Feature docs | `docs/*.md` (except `docs/adr/` and `docs/development.md`/`docs/testing.md`) | End users | auth, catalog, stream, knowledge-tools, server-tools, configuration — capabilities, quick use, behavior, limits |
| Developer docs | `docs/development.md` + `docs/testing.md` | Contributors/agents | Build/test/layout/wire-mapping details |
| Decisions | `docs/adr/` | Contributors/agents | ADRs (Trial/Accepted), index in docs/adr/README.md |

AGENTS.md stays the agent entry point (it links to the developer docs);
`.pi/*.md` stay working instructions, not audience documentation.

**2. ADR citation convention:** prose in audience documentation never
cites ADRs inline — claims stand alone. At the end of a section, on its
own line, in italics, the short format:

```
*Decisions: [ADR 0004 — API-key credential chain without Mistral OAuth](../0004-api-key-credential-chain-without-mistral-oauth.md)*
```

Multiple ADRs go on the same line, semicolon-separated, in ascending
order. No relevant ADR → no line. Tables carry no ADR refs in cells;
the reference line goes directly under the table. Exception:
references necessary for comprehension stay permitted — but as
end-of-section proof references, never inline parentheses.

**3. Capability-first audience docs:** audience documentation leads
with **"What you can do"** — capabilities named by what the user gets
(chat with reasoning, RAG over your documents, OCR, connectors as
tools, region routing, self-configuration via `/mistral`), each paired
with its minimal quick step (a tool name, a tiny config/command
snippet). The primary reading path answers "what can I do, and how do
I do it fast"; quick-use sections align with the README Quickstart's
login→done tone. Implementation details, mechanisms and design
rationale sit below the primary path: `## How it works` mid-document,
deep evidence and protocol detail in per-doc `## Advanced` / `## Notes`
sections at the end (per-doc structure, not a central advanced folder).
Tool inventories live in the feature docs, organized **by user task**,
not by internal module; the README keeps none. Competitive/problem
framing (e.g. "Why not just the built-in provider?") stays short and
secondary — never before the capability list.

**Scope of the rule:** audience documentation (README.md + docs/*.md
except docs/adr/). Not binding for cross-references inside docs/adr/
(ADRs cite each other freely), code and test comments, AGENTS.md, or
`.pi/` docs.

## Consequences

- **Migration:** README's Development + Layout sections moved to
  docs/development.md; all inline citations converted to end-of-section
  Decisions lines; AGENTS.md carries the rules block so future
  agent-authored docs are born conformant. Heading anchors that
  contained ADR refs changed, and inbound links were tracked.
- **Easier:** each audience reads one layer; prose flows uninterrupted;
  the decision trail stays one click away without cluttering claims.
- **Harder:** every doc change must now place ADR refs in the right
  end-of-section lines — an extra discipline that agents and humans
  must follow; heading-anchor changes can break inbound links unless
  tracked during migration.
