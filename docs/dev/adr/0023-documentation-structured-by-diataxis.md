# 0023. Documentation structured by Diátaxis, human reader first

- **Status**: Trial
- **Date**: 2026-11-05

## Context

The documentation site grew feature by feature. The sidebar groups
(*Getting started* / *Features* / *Developer*) mirror the release
history, not a reader's intent, and each feature page mixes content
types: instructions, look-up facts, rationale and implementation
internals sit side by side. The Configuration page shows this most
clearly — a reader who only wants the EU region first reads a
four-step path resolution chain, then a commented schema, then a
14-row table with paragraph-long cells, with internals such as
`ctx.ui.notify`, `session_start` or `extensions/mistral.ts` interleaved
with user-facing behavior. Concrete defects accumulated in that page:
a schema example containing `//` comments (invalid JSON — copying it
triggers the page's own "failed to parse" error, and the `endpoint`
section missing from the example), a "six sections are behavioral now"
paragraph that lists five bullets, a "reserved-and-parsed" paragraph
describing the state at the time of ADR
[0010](0010-configuration-via-mistral-native-json.md) (only
`rag.defaultLibraryId` and `ocr.defaultModel` are still reserved), a
JSON-before-environment precedence whose exceptions
(`MISTRAL_REGION`, `MISTRAL_CONNECTOR_TOOLS`, `MISTRAL_RAG_STREAMING`)
appear only inside table cells, and link texts that name files
("auth.md", "catalog.md") instead of pages. ADR
[0010](0010-configuration-via-mistral-native-json.md) itself cites
"the ADR-0007 env-first default" where ADR
[0004](0004-api-key-credential-chain-without-mistral-oauth.md) is the
intended target.

The site serves four audiences in priority order:

1. **First-time users** — install, set the API key, optionally pick a
   region, done.
2. **Power users** — rate card, connectors, agent mode, knowledge tools.
3. **Team and repository admins** — project scope, trust, secrets,
   gateways.
4. **Contributors** — internals, tests, publishing, ADRs.

The project is early enough for a big-bang rewrite: the old structure
is replaced outright, with no transition phase and no redirects. Old
deep links break, which is acceptable at this stage.

## Options considered

**A. Polish pages in place.** Cheap, but every page keeps mixing
content types, and every new feature repeats the pattern.

**B. Full rewrite by Diátaxis, in one step, with page contracts.**
Rewrite every page against a fixed page map, a per-type page contract
and fixed component conventions. This option is chosen.

**C. B plus a reference generated from the config schema, with a CI
drift check.** Deferred: the key reference stays hand-written, and a
PR checklist item mitigates drift. If drift happens anyway, a follow-up
ADR adopts this option.

## Decision

The site is structured by [Diátaxis](https://diataxis.fr), optimized
for human readers, first-time users first. The decision has six
normative parts.

### D1. Five sidebar sections, one type per page

| Sidebar section | Diátaxis type | Reader question |
|---|---|---|
| Get started | Tutorial | "Walk me through it once." |
| How-to guides | How-to | "How do I get X done?" |
| Reference | Reference | "What exactly is X?" |
| Concepts | Explanation | "Why does it work this way?" |
| Contributing | any type, for contributors | "How do I work on the code?" |

Every page declares `type: tutorial | how-to | reference | concept`
in its frontmatter, validated by the content schema — the build fails
without it. ADR pages are `concept`.

### D2. Page map

| Section | Pages |
|---|---|
| Get started | Welcome (one screen: what it is, who it is for, where to go next) · *Your first Mistral session* (install → `/login mistral-native` → optional region → `/mistral test` → first chat) |
| How-to guides | Set up your API key · Change a setting · Use the EU or US region · Override settings for one project · Keep secrets out of the config file · Route requests through a gateway · Use a Mistral agent · Set your own prices · Enable connectors and connector tools · Query your documents · Search the web · Run code with the code interpreter · Fix a configuration error |
| Reference | Configuration keys (URL `/configuration/`) · Config file locations and precedence · Environment variables · `/mistral` commands · Tools · Region routing · Credential chain · Built-in rate card · Max-output mapping · Configuration error messages |
| Concepts | How configuration layers work (incl. glossary) · Regions and data residency · Server-side and client-side tools · Models and cost estimates · How chat streaming works |
| Contributing | Development · Testing · Publishing · Website hosting · Design tokens · Internals (collects all implementation details removed from user pages) · ADRs (URLs under `/dev/adr/`) |

URLs follow the section folders (`get-started/`, `how-to/`,
`reference/`, `concepts/`, `contributing/`), with two exceptions:
*Configuration keys* stays at `/configuration/`, and ADRs stay under
`/dev/adr/`.

### D3. Page contract per type

| Type | Title pattern | Opens with | Contains | Never contains |
|---|---|---|---|---|
| Tutorial | "Your first …" | What the reader has at the end | One path, numbered steps, visible result after each step | Choices, alternatives, rationale, exhaustive options |
| How-to | Imperative task ("Use the EU region") | One sentence: what it achieves, when you need it | Prerequisites, `Steps`, a verification step (usually `/mistral`), links to reference | Full option lists, history, internals |
| Reference | Noun ("Configuration keys") | One sentence on scope | Facts in a fixed, scannable format; structure mirrors the product | Instructions beyond a minimal example, rationale |
| Concept | "How … works", "… and …" | The question the page answers | Rationale, trade-offs, diagrams | Step-by-step instructions, option tables |

Single source of truth: types, defaults, environment variables and
allowed values live **only** on reference pages. Other pages link to
them instead of repeating them.

### D4. Writing rules

1. Second person, present tense, active voice. The [Google developer
   documentation style guide](https://developers.google.com/style)
   settles open style questions.
2. User pages describe observable behavior ("pi shows a warning when
   the session starts"). Internal function names, hooks and source
   paths belong in Contributing.
3. Every copyable code block works as-is. JSON is strict JSON without
   comments; explanations go into the surrounding text.
4. Link text is the target page's title, never a file name.
5. No change-log language on reader pages ("behavioral now", "today",
   "yet"). Reserved keys get a `Badge`; history lives in ADRs.
6. Surprising behavior is stated where the reader acts. The
   JSON-over-environment precedence appears in every how-to that offers
   an environment variable.
7. Fixed terms, defined once in *How configuration layers work*:
   *user scope*, *project scope*, *effective value*, *unset*,
   *region*, *gateway*.
8. ADR links collect in one "Background" line at the end of a page —
   allowed only on pages in the Contributing section; user-facing
   pages (Get started, How-to guides, Reference, Concepts) carry zero
   ADR references.

### D5. Starlight component conventions

| Component | Use for | Not for |
|---|---|---|
| `Steps` | Every tutorial and how-to procedure | Lists of facts |
| `Tabs` with `syncKey="config-method"` | Equivalent methods: Command / File / Environment | Content that differs in meaning |
| `Aside type="caution"` | Surprising behavior: JSON beats env, regional split, +10% regional surcharge, project file ignored without trust | General hints |
| `Aside type="danger"` | Security only: `!command` runs a shell command; the API key never goes into the config file | Anything else |
| `Aside type="tip"` | Shortcuts (`/mistral` shows every effective value and its source) | Required information |
| `Badge` | Reference markers: `Reserved`, `Region-aware`, `Not settable via /mistral set` | Decoration |
| `FileTree` | Config file locations | — |
| `LinkCard` / `CardGrid` | Welcome page and section landing pages | Inline links in body text |

At most one aside per screen-height of content. If a page needs more,
the content is in the wrong type.

### D6. Entry format on *Configuration keys*

There is one entry per key, grouped by section. Each entry has the same
shape: heading with badges, one-sentence definition, then Type,
Default, Environment variable (with exceptions), Set with, a JSON
example and links.

## Consequences

- **Easier:** First-time users get one short path. Power users and
  admins find task pages by name. Every fact has exactly one home. New
  features fit the pattern: one how-to, one reference entry, optionally
  one concept page. Reviewers can check a page against its contract.
- **Harder:** More, shorter pages with more cross-links to maintain. A
  page's type must be decided before writing. Old deep links break,
  which is acceptable at this early stage. The component conventions
  require MDX-capable content, which constrains the site's ingestion
  pipeline (Starlight's `Steps`, `Tabs`, `Badge`, `FileTree` and
  `LinkCard` are Astro components, not Markdown).
- **Known risk accepted:** The key reference stays hand-written and
  can drift from the config schema. Mitigation: a checklist item in
  the PR template. If drift happens anyway, a follow-up ADR adopts
  option C.

## References

- [Diátaxis](https://diataxis.fr)
- [Canonical: Diátaxis, a new foundation for Canonical documentation](https://canonical.com/blog/diataxis-a-new-foundation-for-canonical-documentation)
- [Google Technical Writing: Organizing large documents](https://developers.google.com/tech-writing/two/large-docs)
- [Starlight components](https://starlight.astro.build/guides/components/)
- ADR [0010](0010-configuration-via-mistral-native-json.md) —
  Configuration via mistral-native.json
- ADR [0022](0022-mistral-set-scope-and-list-mutation.md) —
  Project-scope writes and list mutation for `/mistral set`
