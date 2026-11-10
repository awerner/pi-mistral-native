# 0025. Staggered retry with configurable backoff

- **Status**: Trial
- **Date**: 2026-11-10

## Context

Chat requests against Mistral intermittently failed hard with HTTP 429
`backend_out_of_capacity` (code 3505) — a transient server-side capacity
condition, not a quota violation: the backend is momentarily saturated and
asks the client to retry later. A hard failure loses the user's request
even though a retry within seconds would succeed.

The provider stream path already had a retry loop with interruptible
backoff, but it defaulted to **zero** retries (pi never passes pi-ai's
`SimpleStreamOptions.maxRetries` at runtime), its ladder was a hardcoded
0.5s–8s equal-jitter schedule, and its server-delay ceiling was a
hardcoded 60s. The tool fetch paths — `mistralFetch` (knowledge APIs) and
the files/libraries client — had no retry at all, so a 429 surfaced
directly to the agent mid-task.

## Decision

1. **One shared retry module** (`extensions/mistral/retry.ts`), not three
   copies: the policy object, the status classification (408/409/429/5xx),
   the delay computation, the server-delay parsing and the interruptible
   sleep all live there; the three call sites import it. The module has no
   imports from the call sites (no cycles).
2. **Retries on by default, configurable via the `retry` config section**:
   `maxAttempts` (3), `baseDelayMs` (1000), `maxDelayMs` (30000) — the
   same schema/validation/write path as every other config key
   (positive integers; `maxDelayMs >= baseDelayMs`; 0 is invalid, so
   retries cannot be disabled via config). pi-ai's
   `SimpleStreamOptions.maxRetries` / `.maxRetryDelayMs` stay the runtime
   override inlet for the stream path.
3. **`maxAttempts` counts retries, not requests**: the default 3 means up
   to 4 requests, delays 1s → 2s → 4s, worst case ~7s of waiting — a
   capacity blip is absorbed invisibly, a sustained outage still fails
   after a bounded wait.
4. **Full jitter**: each wait is uniform in `[0, min(base·2^attempt,
   max))` — the recommended shape for capacity-type throttles; it staggers
   concurrent clients instead of synchronizing them into a second spike.
   (The old equal-jitter `(1 − rand·0.25)` shape is dropped; no test
   asserted it.)
5. **Retry-After precedence, unchanged**: `retry-after-ms` then
   `retry-after` (numeric seconds, else HTTP-date) beat the computed
   backoff, capped by `maxDelayMs`; a server request beyond the cap fails
   fast with the existing message text.
6. **Status-only retry for the side-effectful client**: the chat stream
   and `mistralFetch` retry statuses AND network errors (every request
   there is a pure POST — retry-safe); the files/libraries client retries
   statuses only, because it also performs uploads, creates and deletes
   where a network error may mean the server already acted.
7. **The 60s server-delay ceiling is replaced by `maxDelayMs` (30s
   default)** — an intended behavior change: server retry-after delays
   between 30s and 60s now fail fast where they previously waited.
8. **An attempts note for visibility**: when retries were attempted and a
   retryable error is finally surfaced, the message keeps the status +
   body excerpt exactly and appends ` (after N attempts)`. Non-retryable
   errors never carry the note. The note is the only retry surfacing in
   the error path — a per-attempt notice would spam mid-conversation.

## Consequences

- Capacity blips disappear by default: no configuration needed for the
  reported failure mode; the default budget absorbs it.
- Sustained outages fail after ~7s with the full error body plus the
  attempts note, so a slow request explains itself.
- The 30s cap tightens the previous 60s server-delay ceiling — a server
  asking 45s now fails fast instead of stalling the session (recorded in
  the CHANGELOG as a behavior change).
- Cross-scope degenerate merges are possible (the user file sets
  `baseDelayMs: 5000`, the project file sets `maxDelayMs: 3000`; the
  per-file cross-field rule cannot see across scopes). The delay
  computation's `min()` then simply caps every delay at `maxDelayMs` —
  benign, never a crash.
- The files/libraries client's status-only policy means a flaky network
  still fails a tool call on the first network error — accepted: a
  duplicated upload or delete is worse than a retried tool call.
- Tests inject the module-level sleep seam (`setRetryTestSleep`) and the
  random source; with retries on by default, every mocked-429/5xx suite
  must install the no-op seam or it would really sleep.
