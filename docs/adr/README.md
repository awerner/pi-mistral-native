# Architecture Decision Records

This directory holds the **target-architecture** ADR series for
pi-mistral-native: short, dated records of *why* a decision about the
software's architecture was made, kept next to the code they explain.

## When to write one

Write a new ADR when a decision:

- (a) **changes architecture** (a new component, a different data or wire
  model, a different way the project is built, tested or distributed),
- (b) **rejects an obvious alternative** (worth recording so it isn't
  re-litigated later without the context), or
- (c) **accepts a risk** (a known tradeoff we're consciously living with).

Everyday version bumps, dependency updates, and bug fixes do **not** get an
ADR — those are just commits.

Copy [`template.md`](template.md), give it the next number in the series,
add it to the index, and keep it to about one page. Create the
new ADR with status `Trial`; never set `Accepted` — promotion is the
project owner's decision alone.

## Lifecycle

Every ADR is born `Trial`. Agents author ADRs only in `Trial` — a proposal
under evaluation: merging the introducing PR implies no acceptance. While
an ADR is `Trial`, agents may edit or rewrite it, or discard it entirely
(delete the file and remove its index row). Promotion `Trial → Accepted`
happens only by an explicit decision of the project owner (the human); the
plan is a bulk promotion of all ADRs accumulated by then with the first
stable release. Once accepted, an ADR is immutable: a changed decision gets
a new ADR, and the old one's status becomes `Superseded by NNNN` (the only
edit allowed to an accepted ADR).

Status legend:

- `Trial` — birth state of every ADR: agent-authored proposal in evaluation;
  may be sharpened, rewritten, or discarded.
- `Accepted` — promoted only by an explicit human (project-owner) decision;
  from here on immutable.
- `Superseded by NNNN` — an accepted ADR replaced by ADR NNNN.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Trial |
| [0002](0002-mistral-native-provider-for-pi.md) | Mistral-native provider for pi | Trial |
| [0003](0003-vendored-openapi-spec.md) | Vendored OpenAPI spec | Trial |
| [0004](0004-api-key-credential-chain-without-mistral-oauth.md) | API-key credential chain without Mistral OAuth | Trial |
| [0005](0005-ocr-embeddings-moderations-as-pi-tools.md) | OCR, embeddings, moderations/classifications as pi tools | Trial |
| [0006](0006-knowledge-api-tools.md) | Knowledge API tools | Trial |
| [0007](0007-server-side-tools-as-opaque-content.md) | Server-side tools as opaque content | Trial |
| [0008](0008-direct-fetch-over-vendor-sdk.md) | Direct fetch over vendor SDK | Trial |
| [0009](0009-ship-built-dist-as-tarball-surface.md) | Ship built dist as the tarball surface | Trial |
| [0010](0010-configuration-via-mistral-native-json.md) | Configuration via mistral-native.json | Trial |
| [0011](0011-client-side-connector-tools.md) | Client-side connector tools via the loader pattern | Trial |
| [0012](0012-selectable-region-endpoints.md) | Selectable region endpoint with per-family routing | Trial |
| [0013](0013-rate-card-sourced-prices.md) | Per-family rate card with sourced prices and visible fall-through | Trial |
| [0014](0014-content-chunk-coverage.md) | Content chunk coverage: map or reject, never drop | Trial |
| [0015](0015-streaming-rag-document-query.md) | Streaming RAG document query | Trial |
| [0016](0016-mistral-command-family.md) | `/mistral` command family: show, set, test | Trial |
| [0017](0017-documented-max-output-mapping.md) | Documented max-output mapping over fixed clamp | Trial |
| [0018](0018-web-search-as-conversations-backed-tool.md) | Web search as a Conversations-backed tool | Trial |
| [0019](0019-tool-call-continuation-chunks.md) | Tool-call continuation chunks append to the open call | Trial |
| [0020](0020-code-interpreter-as-conversations-backed-tool.md) | Code interpreter as a Conversations-backed tool | Trial |
| [0021](0021-cost-estimates-marked-not-billed.md) | Cost estimates marked as not provider-billed | Trial |
