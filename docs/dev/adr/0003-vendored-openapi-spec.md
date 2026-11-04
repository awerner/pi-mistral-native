# 0003. Vendored OpenAPI spec

- **Status**: Trial
- **Date**: 2026-10-30

## Context

The native provider (ADR
[0002](0002-mistral-native-provider-for-pi.md)) must match
Mistral's actual wire format: request schemas, block-array `content`, stream
event shapes, tool and connector definitions. The source of truth is
Mistral's OpenAPI specification at <https://docs.mistral.ai/openapi.yaml>,
but fetching it ad hoc means network access, a moving target, and no way to
review what changed between two revisions of our implementation.

## Decision

Vendor the spec: `vendor/mistral-openapi.yaml` (fetched 2026-10-30 from
<https://docs.mistral.ai/openapi.yaml>, OpenAPI 3.1.0, 234 paths). It is a
read-only reference — never edit by hand; refresh by re-downloading and
recording date and SHA-256 in `vendor/README.md`. Model facts
(`contextWindow`, `maxTokens`) and wire-format details are verified against
the vendored copy, not against blog posts or memory.

## Consequences

- Wire-format decisions are auditable and diffable: a spec refresh shows
  exactly what changed upstream.
- The repo carries a ~1.4 MB YAML file; `npm` consumers do not — it stays
  outside the published `files`.
- The spec can lag behind the live API until someone refreshes it; the
  dynamic catalog compensates for model churn, but wire-format changes
  still need a manual refresh.
