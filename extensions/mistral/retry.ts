/**
 * Shared retry mechanics for transient Mistral API failures.
 *
 * One policy object drives every fetch path that retries: the provider
 * chat stream (extensions/mistral.ts), the knowledge-API client
 * (extensions/mistral/api.ts) and the files/libraries client
 * (extensions/tools/mistral-client.ts). Transient statuses (408/409/429/5xx)
 * — and, on the pure-request paths, network errors — are retried with
 * full-jitter exponential backoff; a server-requested `Retry-After` delay
 * wins over the computed delay, capped by `maxDelayMs` (a server request
 * beyond the cap fails fast instead of stalling the session).
 *
 * The module has no imports from the call sites (no cycles); the test
 * sleep seam mirrors setMistralTestFetch in extensions/mistral/api.ts.
 *
 * ADR 0025 — Staggered retry with configurable backoff
 */

/** Retry policy shape resolved from the `retry` config section. */
export interface RetryPolicy {
	/** Number of RETRIES after the initial request (not total requests). */
	maxAttempts: number;
	/** Backoff base: the delay ladder is baseDelayMs · 2^attempt, full jitter. */
	baseDelayMs: number;
	/** Ceiling for every wait, including server-requested `Retry-After` delays. */
	maxDelayMs: number;
}

/** Built-in defaults: 3 retries, a 1s → 2s → 4s ladder, a 30s wait ceiling. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
};

/**
 * Transient HTTP statuses worth a retry. Deterministic failures
 * (401/402/403/404/422 …) fail on the first response, never retried.
 */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Full-jitter backoff delay for the wait AFTER attempt `attempt` failed:
 * uniform in [0, min(baseDelayMs · 2^attempt, maxDelayMs)). Full jitter is
 * the recommended shape for capacity-type throttles (a 429 blip clears
 * without a synchronized thundering herd). `random` is injectable for
 * deterministic tests.
 */
export function backoffDelayMs(
	attempt: number,
	policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">,
	random: () => number = Math.random,
): number {
	const capped = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
	return random() * capped;
}

/**
 * Server-requested delay from `retry-after-ms` (milliseconds) or
 * `retry-after` (numeric seconds, else an HTTP-date), capped at
 * `maxDelayMs`. Returns undefined when the response carries no parsable
 * header. A server request beyond the cap throws — failing fast beats
 * stalling the session for the server's asked duration. The message text
 * is pinned by tests and matches the stream path's historical wording.
 */
export function serverRequestedDelayMs(headers: Headers | undefined, maxDelayMs: number): number | undefined {
	const max = maxDelayMs > 0 ? maxDelayMs : Number.POSITIVE_INFINITY;
	const retryAfterMs = headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerDelay(value, max);
	}
	const retryAfter = headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerDelay(delayMs, max);
	}
	return undefined;
}

function validateServerDelay(delayMs: number, maxDelayMs: number): number {
	if (delayMs > maxDelayMs) {
		throw new Error(
			`Mistral API requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s)`,
		);
	}
	return delayMs;
}

/**
 * The wait before the next attempt: a server-requested delay (when the
 * response carries one) wins over the computed backoff; both are capped by
 * the policy's `maxDelayMs`. `response` is undefined after a network error,
 * which has no headers to honor.
 */
export function retryDelayMs(
	response: Response | undefined,
	attempt: number,
	policy: RetryPolicy,
	random: () => number = Math.random,
): number {
	const serverDelay = serverRequestedDelayMs(response?.headers, policy.maxDelayMs);
	if (serverDelay !== undefined) return serverDelay;
	return backoffDelayMs(attempt, policy, random);
}

/**
 * Sleep for `ms`, rejecting with an AbortError when `signal` fires first.
 * Aborting mid-backoff must surface as a rejection, not a resolved wait.
 */
export function sleepInterruptible(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortError());
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

/**
 * Test seam for the sleep primitive (mirrors setMistralTestFetch): with
 * retries enabled by default, tests that mock 429/5xx responses would
 * otherwise really sleep between attempts. `undefined` restores the real
 * sleep.
 */
let testSleep: ((ms: number, signal: AbortSignal | undefined) => Promise<void>) | undefined;

/** Override the sleep implementation (tests only). `undefined` restores the real sleep. */
export function setRetryTestSleep(fn: ((ms: number, signal: AbortSignal | undefined) => Promise<void>) | undefined): void {
	testSleep = fn;
}

/** The active sleep implementation: the test seam when set, else the real interruptible sleep. */
export function retrySleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return testSleep !== undefined ? testSleep(ms, signal) : sleepInterruptible(ms, signal);
}

/**
 * The attempt note appended to a finally-surfaced retryable error, e.g.
 * ` (after 4 attempts)` — visibility that the request was retried, without
 * touching the status + body excerpt. `attempts` counts every request sent
 * (initial + retries); no note when only one request was made.
 */
export function attemptsNote(attempts: number): string {
	return attempts > 1 ? ` (after ${attempts} attempts)` : "";
}
