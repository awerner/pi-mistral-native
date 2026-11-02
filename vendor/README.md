# Vendored reference material

## mistral-openapi.yaml

Vendored copy of the official Mistral AI API OpenAPI specification
(<https://docs.mistral.ai/openapi.yaml>), fetched on 2026-10-30.

- Version: OpenAPI 3.1.0, "Mistral AI API" 1.0.0, 234 paths (chat completions,
  agents, connectors, files, libraries, OCR, embeddings, moderations, batch).
- Size: ~1.4 MB, SHA-256
  `08a585fb75bcfa6ff968773134ee00060e0db283fc6b16f421f544e78ba8db92`.
- Never edit by hand. Refresh by re-downloading and re-recording date and
  checksum here (decision: ADR
  [0003](../docs/adr/0003-vendored-openapi-spec.md)).
- The vendored spec is the reference for wire-format details of the native
  provider implementation (ADR
  [0002](../docs/adr/0002-mistral-native-provider-for-pi.md)):
  request schemas, `content` block arrays, thinking blocks, stream event
  shapes and tool definitions.
