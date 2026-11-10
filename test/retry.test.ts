/**
 * Tests for the shared retry mechanics (extensions/mistral/retry.ts) and
 * their wiring into the three fetch paths: the provider chat stream
 * (extensions/mistral.ts), the knowledge-API client
 * (extensions/mistral/api.ts) and the files/libraries client
 * (extensions/tools/mistral-client.ts).
 *
 * All delay computation is deterministic via an injected random source; all
 * retry loops run against a no-op sleep seam, so no test ever really waits.
 *
 * ADR 0025 — Staggered retry with configurable backoff
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_RETRY_POLICY,
	attemptsNote,
	backoffDelayMs,
	isRetryableStatus,
	retryDelayMs,
	serverRequestedDelayMs,
	setRetryTestSleep,
	sleepInterruptible,
	type RetryPolicy,
} from "../extensions/mistral/retry.js";
import {
	getEffectiveRetryPolicy,
	mergeMistralFileConfigs,
	setMistralConfigForTests,
	validateMistralFileConfig,
	type MistralFileConfig,
} from "../extensions/mistral/config.js";
import { MODELS, MISTRAL_BASE_URL, mistralStreamSimple } from "../extensions/mistral.js";
import { setMistralTestBaseUrl, setMistralTestFetch, resetMistralTestOverrides } from "../extensions/mistral/api.js";
import { createMistralClient, MistralApiError } from "../extensions/tools/mistral-client.js";
import type { TranscriptContext } from "@earendil-works/pi-ai";

// Retries on by default: every retry-loop test runs against a no-op sleep
// seam so no test really waits (each test file runs in its own process).
setRetryTestSleep(async () => {});

// The no-file config baseline keeps the effective policy at the built-in
// defaults regardless of the developer's real mistral-native.json.
setMistralConfigForTests(null);

/** The waits the no-op sleep seam observed: [ms, signal] per call. */
const sleepCalls: Array<{ ms: number; aborted: boolean }> = [];

beforeEach(() => {
	sleepCalls.length = 0;
	setRetryTestSleep(async (ms, signal) => {
		sleepCalls.push({ ms, aborted: signal?.aborted === true });
	});
});

afterEach(() => {
	setRetryTestSleep(async () => {});
	setMistralConfigForTests(null);
	resetMistralTestOverrides();
	delete process.env.MISTRAL_API_KEY;
});

// =============================================================================
// Pure pieces: status classification, delay computation, server delay
// =============================================================================

test("isRetryableStatus: 408/409/429/5xx retry; deterministic 4xx fail", () => {
	for (const status of [408, 409, 429, 500, 502, 503, 504]) {
		assert.equal(isRetryableStatus(status), true, `${status} is retryable`);
	}
	for (const status of [200, 301, 400, 401, 402, 403, 404, 422]) {
		assert.equal(isRetryableStatus(status), false, `${status} is not retryable`);
	}
});

test("backoffDelayMs: full jitter is uniform in [0, capped)", () => {
	const policy = { baseDelayMs: 1000, maxDelayMs: 30000 };
	// attempt 0: capped at 1000; attempt 1: 2000; attempt 2: 4000.
	assert.equal(backoffDelayMs(0, policy, () => 0), 0);
	assert.equal(backoffDelayMs(0, policy, () => 0.999), 999);
	assert.equal(backoffDelayMs(1, policy, () => 0.5), 1000);
	assert.equal(backoffDelayMs(2, policy, () => 0.5), 2000);
	assert.equal(backoffDelayMs(3, policy, () => 0.5), 4000);
	assert.equal(backoffDelayMs(3, policy, () => 0.25), 2000);
	// A random() of ~1 lands at the capped value (never above).
	assert.ok(backoffDelayMs(2, policy, () => 0.999999) < 4000);
});

test("backoffDelayMs: maxDelayMs caps the ladder; the default ladder is 1s/2s/4s", () => {
	const capped = { baseDelayMs: 1000, maxDelayMs: 3000 };
	// 2^5 would be 32s; the cap holds every deep attempt at 3s.
	for (const attempt of [2, 5, 10]) {
		const delay = backoffDelayMs(attempt, capped, () => 0.5);
		assert.equal(delay, 1500, `attempt ${attempt} is capped at maxDelayMs`);
	}
	// The default policy's ladder: 1s → 2s → 4s (midpoint of each).
	assert.equal(backoffDelayMs(0, DEFAULT_RETRY_POLICY, () => 0.5), 500);
	assert.equal(backoffDelayMs(1, DEFAULT_RETRY_POLICY, () => 0.5), 1000);
	assert.equal(backoffDelayMs(2, DEFAULT_RETRY_POLICY, () => 0.5), 2000);
	assert.equal(backoffDelayMs(3, DEFAULT_RETRY_POLICY, () => 0.5), 4000);
});

test("backoffDelayMs: full-jitter bounds hold across the unit interval", () => {
	const policy = { baseDelayMs: 1000, maxDelayMs: 30000 };
	const samples = [0, 0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999, 0.999999];
	for (const random of samples) {
		const delay = backoffDelayMs(1, policy, () => random);
		assert.ok(delay >= 0 && delay < 2000, `delay ${delay} outside [0, 2000)`);
	}
});

test("serverRequestedDelayMs: retry-after-ms and retry-after (numeric and HTTP-date) parse", () => {
	const headers = (entries: Record<string, string>) => new Headers(entries);
	// retry-after-ms wins when present.
	assert.equal(serverRequestedDelayMs(headers({ "retry-after-ms": "2500" }), 30000), 2500);
	// numeric seconds.
	assert.equal(serverRequestedDelayMs(headers({ "retry-after": "3" }), 30000), 3000);
	// HTTP-date: a date 5s in the future yields ~5s.
	const future = new Date(Date.now() + 5000).toUTCString();
	const fromHttpDate = serverRequestedDelayMs(headers({ "retry-after": future }), 30000);
	assert.ok(fromHttpDate !== undefined && fromHttpDate > 4000 && fromHttpDate <= 5000, `HTTP-date delay ${fromHttpDate}`);
	// No headers: undefined.
	assert.equal(serverRequestedDelayMs(headers({}), 30000), undefined);
	assert.equal(serverRequestedDelayMs(undefined, 30000), undefined);
});

test("serverRequestedDelayMs: a server delay beyond maxDelayMs fails fast with the exact message", () => {
	assert.throws(
		() => serverRequestedDelayMs(new Headers({ "retry-after": "61" }), 30000),
		/Mistral API requested 61s retry delay \(max: 30s\)/,
	);
	assert.throws(
		() => serverRequestedDelayMs(new Headers({ "retry-after-ms": "45000" }), 30000),
		/Mistral API requested 45s retry delay \(max: 30s\)/,
	);
	// Within the cap: no throw.
	assert.equal(serverRequestedDelayMs(new Headers({ "retry-after": "30" }), 30000), 30000);
});

test("retryDelayMs: a server-requested delay beats the computed backoff", () => {
	const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 };
	const response = new Response("busy", { status: 429, headers: { "retry-after": "7" } });
	assert.equal(retryDelayMs(response, 0, policy, () => 0.999), 7000);
	// Without a server delay, the computed backoff applies.
	assert.equal(retryDelayMs(new Response("busy", { status: 429 }), 0, policy, () => 0.5), 500);
	// A network error has no response: pure backoff.
	assert.equal(retryDelayMs(undefined, 1, policy, () => 0.5), 1000);
});

test("attemptsNote: appended only when more than one request was made", () => {
	assert.equal(attemptsNote(1), "");
	assert.equal(attemptsNote(2), " (after 2 attempts)");
	assert.equal(attemptsNote(4), " (after 4 attempts)");
});

// =============================================================================
// Interruptible sleep
// =============================================================================

test("sleepInterruptible: resolves after the wait", async () => {
	const started = Date.now();
	await sleepInterruptible(5, undefined);
	assert.ok(Date.now() - started >= 4, "the wait actually elapsed");
});

test("sleepInterruptible: abort during a pending backoff rejects with AbortError", async () => {
	const controller = new AbortController();
	const pending = sleepInterruptible(5000, controller.signal);
	// Let the sleep start, then abort.
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal((error as Error).name, "AbortError");
		return true;
	});
});

test("sleepInterruptible: an already-aborted signal rejects immediately", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(sleepInterruptible(100, controller.signal), (error: unknown) => {
		assert.equal((error as Error).name, "AbortError");
		return true;
	});
});

// =============================================================================
// Config validation and effective policy
// =============================================================================

const VALIDATION_PATH = "/tmp/retry-validation.json";

test("validation: a valid retry section parses", () => {
	const { config, error } = validateMistralFileConfig({ retry: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 20000 } }, VALIDATION_PATH);
	assert.equal(error, undefined);
	assert.deepEqual(config?.retry, { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 20000 });
});

test("validation: unknown retry section key is rejected", () => {
	const { error } = validateMistralFileConfig({ retry: { maxAttempts: 3, timeout: 100 } }, VALIDATION_PATH);
	assert.match(error!, /unknown field "retry\.timeout" in \/tmp\/retry-validation\.json; known fields: baseDelayMs, maxAttempts, maxDelayMs/);
});

test("validation: non-integer, zero and negative values are rejected", () => {
	for (const [key, raw] of [
		["maxAttempts", 0],
		["maxAttempts", -1],
		["maxAttempts", 1.5],
		["maxAttempts", "3"],
		["baseDelayMs", 0],
		["baseDelayMs", 250.5],
		["maxDelayMs", -5],
	] as const) {
		const { error } = validateMistralFileConfig({ retry: { [key]: raw } }, VALIDATION_PATH);
		assert.match(
			error!,
			new RegExp(`field "retry\\.${key}" in ${VALIDATION_PATH.replace(/\//g, "\\/")} must be a positive integer`),
			`${key}: ${String(raw)}`,
		);
	}
});

test("validation: maxDelayMs below baseDelayMs is rejected (same file)", () => {
	const { error } = validateMistralFileConfig({ retry: { baseDelayMs: 5000, maxDelayMs: 3000 } }, VALIDATION_PATH);
	assert.match(error!, /field "retry\.maxDelayMs" in .* must be greater than or equal to retry\.baseDelayMs \(1000 by default\)/);
});

test("validation: maxDelayMs below the DEFAULT base is rejected when base unset", () => {
	const { error } = validateMistralFileConfig({ retry: { maxDelayMs: 500 } }, VALIDATION_PATH);
	assert.match(error!, /must be greater than or equal to retry\.baseDelayMs \(1000 by default\)/);
	// Equal to the default base: valid.
	const ok = validateMistralFileConfig({ retry: { maxDelayMs: 1000 } }, VALIDATION_PATH);
	assert.equal(ok.error, undefined);
});

test("merge: retry keys merge per key, project over user", () => {
	const user: MistralFileConfig = { retry: { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60000 } };
	const project: MistralFileConfig = { retry: { maxAttempts: 1, baseDelayMs: undefined, maxDelayMs: undefined } };
	const merged = mergeMistralFileConfigs(user, project);
	// mergeSection is a raw key-by-key merge: a project key explicitly set to
	// undefined OVERWRITES the user value (undefined is "unset" downstream).
	assert.deepEqual(merged?.retry, { maxAttempts: 1, baseDelayMs: undefined, maxDelayMs: undefined });
	// A project key that is simply absent lets the user value survive.
	const projectAbsent = mergeMistralFileConfigs(user, { retry: { baseDelayMs: 500, maxAttempts: undefined, maxDelayMs: undefined } });
	assert.deepEqual(projectAbsent?.retry, { maxAttempts: undefined, baseDelayMs: 500, maxDelayMs: undefined });
});

test("getEffectiveRetryPolicy: per-key fallback to the built-in defaults", () => {
	assert.deepEqual(getEffectiveRetryPolicy(undefined), { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 });
	assert.deepEqual(getEffectiveRetryPolicy({ retry: { maxAttempts: 7, baseDelayMs: undefined, maxDelayMs: undefined } }), {
		maxAttempts: 7,
		baseDelayMs: 1000,
		maxDelayMs: 30000,
	});
	assert.deepEqual(getEffectiveRetryPolicy({ retry: { maxAttempts: undefined, baseDelayMs: 250, maxDelayMs: 5000 } }), {
		maxAttempts: 3,
		baseDelayMs: 250,
		maxDelayMs: 5000,
	});
});

// =============================================================================
// Stream path: attempt counting, success-on-retry, Retry-After precedence
// =============================================================================

type RuntimeModel = (typeof MODELS)[number] & { provider: string; baseUrl: string };

function makeModel(): RuntimeModel {
	return { ...MODELS[0]!, provider: "mistral-native", baseUrl: MISTRAL_BASE_URL };
}

const CONTEXT: TranscriptContext = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
} as unknown as TranscriptContext;

type SseChunk = Record<string, unknown>;

function sseResponse(chunks: SseChunk[]): Response {
	const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chunk = (delta: Record<string, unknown>): SseChunk => ({
	id: "retry-1",
	object: "chat.completion.chunk",
	model: "mistral-large-4",
	choices: [{ index: 0, delta, finish_reason: null }],
});

const finalChunk = (): SseChunk => ({
	id: "retry-1",
	object: "chat.completion.chunk",
	model: "mistral-large-4",
	choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
});

/** Runs the stream to its terminal event and returns it. */
async function runStream(fetchImpl: () => Promise<Response>) {
	const events: { type: string; [key: string]: unknown }[] = [];
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		fetch: fetchImpl,
	} as never);
	for await (const event of stream) events.push(event as never);
	const last = events[events.length - 1];
	assert.ok(last && (last.type === "done" || last.type === "error"), `stream ended with ${last?.type}`);
	return last!;
}

test("stream: an always-429 response exhausts maxAttempts+1 calls, then the error with the attempts note", async () => {
	let calls = 0;
	const last = await runStream(async () => {
		calls++;
		return new Response(JSON.stringify({ message: "Not enough capacity available for this request, please retry later." }), { status: 429 });
	});
	// maxAttempts counts RETRIES: 3 retries + the initial request = 4 calls.
	assert.equal(calls, 4, "expected maxAttempts+1 calls");
	assert.equal(last.type, "error");
	const error = last.error as { errorMessage?: string };
	assert.match(error.errorMessage ?? "", /Mistral API error \(429\)/);
	assert.match(error.errorMessage ?? "", /\(after 4 attempts\)/);
	// Three backoff waits were observed by the sleep seam.
	assert.equal(sleepCalls.length, 3);
});

test("stream: a first-429-then-success request succeeds with exactly two calls", async () => {
	let calls = 0;
	const last = await runStream(async () => {
		calls++;
		if (calls === 1) return new Response(JSON.stringify({ message: "capacity" }), { status: 429 });
		return sseResponse([chunk({ role: "assistant", content: "ok" }), finalChunk()]);
	});
	assert.equal(calls, 2);
	assert.equal(last.type, "done");
	const message = last.message as { content: { text?: string }[] };
	assert.equal(message.content[0]?.text, "ok");
});

test("stream: retry-after-ms and retry-after beat the computed backoff; beyond-cap fails fast", async () => {
	// retry-after-ms: the sleep seam observes the server delay (2500ms),
	// not the computed backoff.
	let calls = 0;
	const first = await runStream(async () => {
		calls++;
		if (calls === 1) return new Response("busy", { status: 429, headers: { "retry-after-ms": "2500" } });
		return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk()]);
	});
	assert.equal(first.type, "done");
	assert.equal(sleepCalls[0]?.ms, 2500, "the server-requested delay wins");

	// retry-after (numeric seconds): 2s → 2000ms.
	sleepCalls.length = 0;
	calls = 0;
	await runStream(async () => {
		calls++;
		if (calls === 1) return new Response("busy", { status: 429, headers: { "retry-after": "2" } });
		return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk()]);
	});
	assert.equal(sleepCalls[0]?.ms, 2000);

	// retry-after (HTTP-date): a date 3s out yields ~3000ms.
	sleepCalls.length = 0;
	calls = 0;
	const future = new Date(Date.now() + 3000).toUTCString();
	await runStream(async () => {
		calls++;
		if (calls === 1) return new Response("busy", { status: 429, headers: { "retry-after": future } });
		return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk()]);
	});
	const httpDateMs = sleepCalls[0]?.ms ?? 0;
	assert.ok(httpDateMs > 2000 && httpDateMs <= 3000, `HTTP-date delay ${httpDateMs}`);

	// A server delay beyond maxDelayMs fails fast with the exact message
	// and no retry happens at all.
	let fastCalls = 0;
	const last = await runStream(async () => {
		fastCalls++;
		return new Response("busy", { status: 429, headers: { "retry-after": "61" } });
	});
	assert.equal(fastCalls, 1, "the beyond-cap delay must fail on the first response");
	assert.equal(last.type, "error");
	const error = last.error as { errorMessage?: string };
	assert.match(error.errorMessage ?? "", /Mistral API requested 61s retry delay \(max: 30s\)/);
});

test("stream: a non-retryable status fails on the first response with no attempts note", async () => {
	let calls = 0;
	const last = await runStream(async () => {
		calls++;
		return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
	});
	assert.equal(calls, 1);
	assert.equal(last.type, "error");
	const error = last.error as { errorMessage?: string };
	assert.match(error.errorMessage ?? "", /Mistral API error \(401\)/);
	assert.doesNotMatch(error.errorMessage ?? "", /attempts/);
	assert.equal(sleepCalls.length, 0);
});

test("stream: the config retry keys drive the policy (and pi-ai's maxRetries still overrides)", async () => {
	setMistralConfigForTests({ retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000 } });
	let calls = 0;
	const last = await runStream(async () => {
		calls++;
		return new Response("busy", { status: 429 });
	});
	assert.equal(calls, 2, "one retry from the config policy");
	assert.equal(sleepCalls.length, 1);
	// The wait is bounded by the configured base (100ms) — full jitter.
	assert.ok(sleepCalls[0]!.ms < 100, `wait ${sleepCalls[0]!.ms} must be under the base delay`);
	assert.equal(last.type, "error");

	// SimpleStreamOptions.maxRetries overrides the config default.
	calls = 0;
	const events: { type: string; [key: string]: unknown }[] = [];
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		maxRetries: 0,
		fetch: async () => {
			calls++;
			return new Response("busy", { status: 429 });
		},
	} as never);
	for await (const event of stream) events.push(event as never);
	assert.equal(calls, 1, "maxRetries: 0 disables retries at the runtime layer");
});

test("stream: a network error is retried (the stream path retries network errors)", async () => {
	let calls = 0;
	const last = await runStream(async () => {
		calls++;
		if (calls <= 2) throw new TypeError("fetch failed");
		return sseResponse([chunk({ role: "assistant", content: "recovered" }), finalChunk()]);
	});
	assert.equal(calls, 3);
	assert.equal(last.type, "done");
	const message = last.message as { content: { text?: string }[] };
	assert.equal(message.content[0]?.text, "recovered");
});

// =============================================================================
// mistralFetch (knowledge APIs): attempt counting, note, network retry
// =============================================================================

const fakeCtx = { modelRegistry: { getApiKeyForProvider: async () => undefined } } as const;

test("mistralFetch: an always-429 response exhausts maxAttempts+1 calls, then the error with the note", async () => {
	process.env.MISTRAL_API_KEY = "test-key";
	setMistralTestBaseUrl("https://mistral.test/v1");
	let calls = 0;
	setMistralTestFetch(async () => {
		calls++;
		return new Response(JSON.stringify({ message: "too many requests" }), { status: 429 });
	});
	await assert.rejects(
		(async () => {
			const { mistralFetch } = await import("../extensions/mistral/api.js");
			return mistralFetch<{ ok: boolean }>(fakeCtx, "/embeddings", { model: "m", input: [] }, undefined);
		})(),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Mistral API request to \/embeddings failed with status 429/);
			assert.match(error.message, /\(after 4 attempts\)/);
			return true;
		},
	);
	assert.equal(calls, 4);
	assert.equal(sleepCalls.length, 3);
});

test("mistralFetch: a first-429-then-success call succeeds with two calls; network errors retry", async () => {
	process.env.MISTRAL_API_KEY = "test-key";
	setMistralTestBaseUrl("https://mistral.test/v1");
	let calls = 0;
	setMistralTestFetch(async () => {
		calls++;
		if (calls === 1) return new Response("busy", { status: 429 });
		return new Response(JSON.stringify({ data: [] }), { status: 200 });
	});
	const { mistralFetch } = await import("../extensions/mistral/api.js");
	await mistralFetch<{ data: unknown[] }>(fakeCtx, "/embeddings", { model: "m", input: [] }, undefined);
	assert.equal(calls, 2);

	// Network errors retry too (all mistralFetch calls are pure POSTs).
	calls = 0;
	setMistralTestFetch(async () => {
		calls++;
		if (calls === 1) throw new TypeError("fetch failed");
		return new Response(JSON.stringify({ data: [] }), { status: 200 });
	});
	await mistralFetch<{ data: unknown[] }>(fakeCtx, "/embeddings", { model: "m", input: [] }, undefined);
	assert.equal(calls, 2);
});

test("mistralFetch: a non-retryable status fails on the first response with no note", async () => {
	process.env.MISTRAL_API_KEY = "test-key";
	setMistralTestBaseUrl("https://mistral.test/v1");
	let calls = 0;
	setMistralTestFetch(async () => {
		calls++;
		return new Response(JSON.stringify({ message: "nope" }), { status: 403 });
	});
	const { mistralFetch } = await import("../extensions/mistral/api.js");
	await assert.rejects(mistralFetch(fakeCtx, "/embeddings", {}, undefined), (error: unknown) => {
		assert.match((error as Error).message, /status 403/);
		assert.doesNotMatch((error as Error).message, /attempts/);
		return true;
	});
	assert.equal(calls, 1);
});

// =============================================================================
// mistral-client (files/libraries): statuses-only retry, attempts note
// =============================================================================

/** A recording fetch mock with a queue of canned responses. */
function createMockFetch() {
	const requests: { url: string; method: string }[] = [];
	let responseIndex = 0;
	const responses: { status: number; body: string }[] = [];
	const mockFetch = (async (_url: unknown, init?: RequestInit) => {
		requests.push({ url: String(_url), method: init?.method ?? "GET" });
		const response = responses[responseIndex++];
		if (!response) throw new Error(`unexpected request #${responseIndex - 1} to ${String(_url)}`);
		return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return {
		mockFetch,
		requests,
		respond(status: number, body: unknown) {
			responses.push({ status, body: typeof body === "string" ? body : JSON.stringify(body) });
		},
	};
}

test("mistral-client request(): an always-429 response exhausts maxAttempts+1 calls with the attempts note", async () => {
	const mock = createMockFetch();
	for (let i = 0; i < 4; i++) mock.respond(429, { message: "capacity" });
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	await assert.rejects(client.listLibraries({}), (error: unknown) => {
		assert.ok(error instanceof MistralApiError);
		assert.equal((error as MistralApiError).status, 429);
		assert.match((error as MistralApiError).message, /\(after 4 attempts\)/);
		return true;
	});
	assert.equal(mock.requests.length, 4);
	assert.equal(sleepCalls.length, 3);
});

test("mistral-client request(): a first-429-then-success call succeeds with two calls", async () => {
	const mock = createMockFetch();
	mock.respond(429, { message: "capacity" });
	mock.respond(200, { data: [], next_page_token: null });
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	const result = await client.listLibraries({});
	assert.deepEqual(result.data, []);
	assert.equal(mock.requests.length, 2);
});

test("mistral-client request(): a network error is NOT retried (side-effectful client)", async () => {
	const mock = createMockFetch();
	let calls = 0;
	const failingFetch = (async () => {
		calls++;
		throw new TypeError("fetch failed");
	}) as typeof fetch;
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: failingFetch });
	await assert.rejects(client.listLibraries({}), /fetch failed/);
	assert.equal(calls, 1, "a network error must not be retried on the side-effectful client");
	void mock;
});

test("mistral-client request(): a non-retryable status fails on the first response with no note", async () => {
	const mock = createMockFetch();
	mock.respond(404, { message: "Library not found" });
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	await assert.rejects(client.listLibraries({}), (error: unknown) => {
		assert.ok(error instanceof MistralApiError);
		assert.doesNotMatch((error as MistralApiError).message, /attempts/);
		return true;
	});
	assert.equal(mock.requests.length, 1);
});

test("mistral-client postStreaming(): an always-500 stream start exhausts the budget with the note", async () => {
	const mock = createMockFetch();
	for (let i = 0; i < 4; i++) mock.respond(500, { message: "boom" });
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	await assert.rejects(
		client.queryLibraryStream({ model: "mistral-large-4", libraryIds: ["lib-1"], query: "q" }).next(),
		(error: unknown) => {
			assert.ok(error instanceof MistralApiError);
			assert.equal((error as MistralApiError).status, 500);
			assert.match((error as MistralApiError).message, /\(after 4 attempts\)/);
			return true;
		},
	);
	assert.equal(mock.requests.length, 4);
});

test("mistral-client postStreaming(): a first-503-then-success call succeeds with two calls", async () => {
	const mock = createMockFetch();
	mock.respond(503, "unavailable");
	const sse = 'data: {"id":"rag-1","choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	mock.respond(200, sse);
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	const collected: string[] = [];
	for await (const chunk of client.queryLibraryStream({ model: "mistral-large-4", libraryIds: ["lib-1"], query: "q" })) {
		const content = chunk.choices?.[0]?.delta?.content;
		if (typeof content === "string" && content.length > 0) collected.push(content);
	}
	assert.deepEqual(collected, ["recovered"]);
	assert.equal(mock.requests.length, 2);
});

test("MistralApiError: the attempts constructor parameter appends the note only past one attempt", () => {
	assert.equal(new MistralApiError(500, "boom", 1).message, "Mistral API error 500: boom");
	assert.equal(new MistralApiError(500, "boom", 3).message, "Mistral API error 500: boom (after 3 attempts)");
	// The default is one attempt: no note.
	assert.ok(!new MistralApiError(500, "boom").message.includes("attempts"));
});
