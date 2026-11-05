# 0020. Code interpreter as a Conversations-backed tool

- **Status**: Trial
- **Date**: 2026-11-03

## Context

ADR [0018](0018-web-search-as-conversations-backed-tool.md) established
the stateless one-shot Conversations pattern for the Conversations-only
builtin tools: Chat Completions rejects `code_interpreter` with HTTP 400
code 1800 (live-probed 2026-11-03, same as `web_search`), while
`POST /v1/conversations` with `inputs[]`, `tools: [{type:
"code_interpreter"}]`, `stream: false`, `store: false` and a fixed
top-level `instructions` string is accepted. Probing the code interpreter
on the live endpoint (2026-11-03) surfaced wire facts that differ from
web search in one important way: the `tool.execution` entry's
`info.result` is an **array of content chunks**, not a JSON string —
observed shapes are `{type:"text", text}` and `{type:"file_url",
file_url, file_name, file_type, summary}` where `file_url` is a signed
blob URL for a generated file (plots, CSVs, …). `info` additionally
carries `code` (the executed Python source) and `code_output` (captured
stdout/stderr as a string). The `message.output` entry also references the
generated files via `tool_file` chunks, but like the web-search message
text it is discarded — only the tool.execution info is the tool's payload.

The model matrix is asymmetric in a different way than web search:
`mistral-small-latest`, `mistral-medium-latest` and
`magistral-medium-latest` run the code interpreter on `/v1/conversations`,
while `mistral-large-4` does **not** refuse with 3004 here — it accepts the
request but silently skips the tool (no `tool.execution` in `outputs[]`).
Hard forcing is unavailable as with web search (`completion_args.tool_choice`
"any" is 422-rejected), so `instructions` is the only forcing lever. Two
empty outcomes are distinct wire shapes: no `tool.execution` entry means
the backend skipped execution (retry-worthy), while a `tool.execution`
entry with an empty `result` array is a genuinely executed run with no
output.

## Decision

The code interpreter ships as one client-side pi tool,
`mistral_code_interpreter` (`extensions/tools/code-interpreter.ts`), over
the same **stateless one-shot Conversations call** as web search: a fresh
`POST /v1/conversations` with `inputs: [{role:"user", content: <prompt>}]`,
`tools: [{type:"code_interpreter"}]`, `stream: false`, `store: false` and
the fixed instructions string "Always use the code_interpreter tool to run
Python code before answering. Never answer from memory." The returned
`conversation_id` is discarded — the tool never continues a conversation.
The shared client method `createConversation` is generalized over the
builtin tool type and builds the instructions string per tool type; the
web-search strings are unchanged.

- **Parsing**: `outputs[]` is scanned for `tool.execution` entries matching
  `name`/`function` `code_interpreter`; each `info.result` array is mapped
  defensively to chunks — text chunks verbatim, `file_url` chunks to
  `{type:"file_url", fileUrl, fileName, fileType}` — and unknown chunk
  shapes are folded away, never dumped. Multiple executions concatenate
  their chunks in outputs order. `code`/`code_output` surface when strings.
  The `message.output` entry is never read. A matching entry whose
  `info.result` is not a readable array fails with an unreadable-result
  error, never a raw dump. The two empty outcomes stay distinct: a missing
  `tool.execution` entry yields an ok result with `skipped: true` (retry-
  worthy), an empty `result` array yields an ok "ran but produced no
  output" result. Neither is an error.
- **Signed URLs and privacy**: generated files arrive as signed blob URLs.
  They go into the model-facing `content`/`structuredContent` but never
  into the persisted `details`, which carry only `{tool, model, prompt,
  executed/skipped, chunk count}` — per the security rules in
  [the Tools reference](../reference/tools.mdx).
- **Model**: the Conversations call runs under the same search model as web
  search — `knowledge.searchModel`, default `mistral-small-latest` — not
  under the chat model. A 400 with code 3004 is mapped defensively to the
  same friendly error as web search (naming the key and the default); the
  skip path is the main safety net because `mistral-large-4` skips silently
  instead of refusing.
- **Usage**: prompt/completion tokens (plus details) map onto the tool
  result like the web-search path; cost stays 0 because the pay-per-use
  `connector_tokens` are not priceable locally.

## Consequences

- Running Python works on every model the chat stream can use: the
  execution runs under the search model's capabilities, not the chat
  model's — on `mistral-large-4` sessions the tool still runs
  (`mistral-small-latest` by default) even though large-4 itself would
  silently skip the tool.
- Generated files (plots, data files) come back as short-lived signed
  download links in the tool result — usable by the model and the user,
  never persisted into transcripts/logs via `details`.
- Forcing execution is probabilistic: the `instructions` string steers the
  server-side agent but cannot guarantee it, so skip detection (the
  distinct `skipped: true` result) remains the safety net.
- Code-interpreter execution is pay-per-use via `connector_tokens` — not
  priceable in the local cost display (tool-result cost stays 0; the token
  counts are surfaced).
- The Conversations call is Beta-endpoint usage — but stateless and
  one-shot (`store: false`, conversation discarded), so no server-side
  conversation state can corrupt anything.
