/**
 * Shared HTTP client for Mistral's knowledge APIs (OCR, embeddings,
 * moderations, classifications).
 *
 * All calls POST JSON to `${MISTRAL_BASE_URL}${path}` with bearer auth.
 * Wire shapes follow vendor/mistral-openapi.yaml; only the
 * fields the tools actually use are modeled.
 *
 * ADR 0003 — Vendored OpenAPI spec
 * ADR 0005 — OCR, embeddings, moderations/classifications as pi tools
 */

import { attemptsNote, isRetryableStatus, retryDelayMs, retrySleep, type RetryPolicy } from "./retry.js";
import { getEffectiveMistralConfig, getEffectiveRetryPolicy } from "./config.js";

/**
 * Minimal structural slice of pi's ExtensionToolContext that tool executions
 * need: provider-level API key lookup. Keeping this minimal lets tests pass a
 * plain fake context.
 */
export interface MistralAuthContext {
	modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
}

/** Init passed to the (overridable) fetch implementation. */
export interface MistralRequestInit {
	method: "POST";
	headers: Record<string, string>;
	body: string;
	/** May be undefined; implementations must forward it to the real fetch. */
	signal: AbortSignal | undefined;
}

/** Fetch-like function; overridable for tests via setMistralTestFetch(). */
export type MistralFetchFn = (url: string, init: MistralRequestInit) => Promise<Response>;

/**
 * Base URL of the Mistral API (single source; extensions/mistral.ts re-exports
 * it). Global anchor for the knowledge APIs and server-tools/connector
 * clients: the Files, Agents and Batch APIs are not available regionally, so
 * these clients deliberately stay on the global endpoint regardless of the
 * configured region — only chat completions and the
 * model catalog route regionally.
 *
 * ADR 0012 — Selectable region endpoint with per-family routing
 */
export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

const ERROR_EXCERPT_LIMIT = 512;

let testFetch: MistralFetchFn | undefined;
let testBaseUrl: string | undefined;

const defaultFetch: MistralFetchFn = (url, init) => fetch(url, { ...init, signal: init.signal ?? null });

/** Override the fetch implementation (tests only). `undefined` restores the default. */
export function setMistralTestFetch(fn: MistralFetchFn | undefined): void {
	testFetch = fn;
}

/** Override the base URL (tests only). `undefined` restores the default. */
export function setMistralTestBaseUrl(url: string | undefined): void {
	testBaseUrl = url;
}

/** Clear all test overrides. */
export function resetMistralTestOverrides(): void {
	testFetch = undefined;
	testBaseUrl = undefined;
}

function baseUrl(): string {
	return testBaseUrl ?? MISTRAL_BASE_URL;
}

/**
 * Resolve the API key: provider auth first (`mistral-native`), then
 * `$MISTRAL_API_KEY`. Never logs or embeds the key value in errors.
 */
async function resolveApiKey(ctx: MistralAuthContext): Promise<string | undefined> {
	const registered = await ctx.modelRegistry.getApiKeyForProvider("mistral-native");
	if (registered && registered.length > 0) return registered;
	const fromEnv = process.env.MISTRAL_API_KEY;
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/** Size-capped excerpt of an error body; response headers are never included. */
function excerpt(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > ERROR_EXCERPT_LIMIT
		? `${trimmed.slice(0, ERROR_EXCERPT_LIMIT)}…[truncated]`
		: trimmed;
}

/**
 * Read at most ERROR_EXCERPT_LIMIT bytes of a response body via its reader, so
 * an unbounded error payload cannot exhaust memory. A null body yields "".
 */
async function readCappedBody(response: Response): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (received < ERROR_EXCERPT_LIMIT) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				received += value.byteLength;
			}
		}
	} catch {
		// Read failures while sampling the error body: keep what was read so far.
	} finally {
		// Stop the producer even when the body was longer than the cap.
		await reader.cancel().catch(() => {});
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const merged = new Uint8Array(Math.min(total, ERROR_EXCERPT_LIMIT));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= merged.byteLength) break;
		const take = Math.min(chunk.byteLength, merged.byteLength - offset);
		merged.set(chunk.subarray(0, take), offset);
		offset += take;
	}
	return new TextDecoder().decode(merged);
}

/**
 * POST `body` as JSON to `${baseUrl}${path}` and parse the JSON response.
 * Throws on a missing API key (never with the key value), on non-2xx responses
 * (with status and a short, size-capped body excerpt), and on 2xx responses
 * that are not valid JSON (with the original parse error as `cause`).
 *
 * Retries transient statuses (408/409/429/5xx) and network errors with the
 * shared backoff policy — every mistralFetch call is a pure request POST,
 * so a retry is always safe. A caller abort is never retried. A finally
 * surfaced retryable error carries the attempts note after the excerpt.
 *
 * ADR 0025 — Staggered retry with configurable backoff
 */
export async function mistralFetch<T>(
	ctx: MistralAuthContext,
	path: string,
	body: unknown,
	signal: AbortSignal | undefined,
	retryPolicy: RetryPolicy = getEffectiveRetryPolicy(getEffectiveMistralConfig()),
): Promise<T> {
	const apiKey = await resolveApiKey(ctx);
	if (!apiKey) {
		throw new Error(
			`No Mistral API key: provider auth for "mistral-native" returned none and MISTRAL_API_KEY is not set.`,
		);
	}
	const url = `${baseUrl()}${path}`;
	const init: MistralRequestInit = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal,
	};
	const fetchFn = testFetch ?? defaultFetch;
	let attempt = 0;
	for (;;) {
		let response: Response;
		try {
			response = await fetchFn(url, init);
		} catch (error) {
			// A caller abort is never retried: it surfaces as-is.
			if (signal?.aborted) throw error;
			if (attempt < retryPolicy.maxAttempts) {
				await retrySleep(retryDelayMs(undefined, attempt, retryPolicy), signal);
				attempt++;
				continue;
			}
			throw error;
		}
		if (response.ok) {
			try {
				return (await response.json()) as T;
			} catch (error) {
				throw new Error(
					`Mistral API request to ${path} returned an invalid JSON response (status ${response.status})`,
					{ cause: error },
				);
			}
		}
		if (isRetryableStatus(response.status) && attempt < retryPolicy.maxAttempts && !signal?.aborted) {
			// Drain the failed body so the connection is released before the wait
			// — via the capped reader: readCappedBody stops at the excerpt limit
			// and cancels the reader (releasing the connection), keeping the
			// module's memory-safety invariant (an unbounded error payload
			// cannot exhaust memory) on the retry path too.
			await readCappedBody(response).catch(() => undefined);
			await retrySleep(retryDelayMs(response, attempt, retryPolicy), signal);
			attempt++;
			continue;
		}
		const text = await readCappedBody(response);
		throw new Error(
				`Mistral API request to ${path} failed with status ${response.status}: ${excerpt(text)}${attemptsNote(attempt + 1)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Wire types (vendor/mistral-openapi.yaml). Only what the tools use.
// ---------------------------------------------------------------------------

/** /v1/ocr — OCRRequest.document is a FileChunk | DocumentURLChunk | ImageURLChunk. */
export type OcrDocumentChunk =
	| { type: "image_url"; image_url: string }
	| { type: "document_url"; document_url: string };

/** /v1/ocr request (OCRRequest): `document` and `model` required. */
export type OcrRequest = {
	model: string;
	document: OcrDocumentChunk;
	pages?: string;
	include_image_base64?: boolean;
};

/** OCRImageObject (fields the tools surface). */
export type OcrImageObject = {
	id: string;
	image_base64?: string | null;
};

/** OCRPageDimensions (spec example shows `{}`, so all fields optional). */
export type OcrPageDimensions = {
	width?: number;
	height?: number;
	dpi?: number;
};

/** OCRPageObject (fields the tools surface). */
export type OcrPageObject = {
	index: number;
	markdown: string;
	images?: OcrImageObject[];
	dimensions?: OcrPageDimensions | null;
};

/** OCRResponse. */
export type OcrResponse = {
	pages?: OcrPageObject[];
	model?: string;
	usage_info?: { pages_processed?: number; doc_size_bytes?: number | null };
};

/** /v1/embeddings request (EmbeddingRequest). */
export type EmbeddingRequest = {
	model: string;
	input: string[];
};

/** EmbeddingResponse (ResponseBase + data: EmbeddingResponseData[]). */
export type EmbeddingResponse = {
	id?: string;
	model?: string;
	data?: { object?: string; embedding: number[]; index: number }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number | null; total_tokens?: number };
};

/** /v1/moderations and /v1/classifications request (ClassificationRequest). */
export type ClassificationRequest = {
	model: string;
	input: string[];
};

/** ModerationObject. */
export type ModerationObject = {
	categories?: Record<string, boolean>;
	category_scores?: Record<string, number>;
};

/** ModerationResponse. */
export type ModerationResponse = {
	id?: string;
	model?: string;
	results?: ModerationObject[];
};

/** ClassificationTargetResult: per-label scores of one training-time target. */
export type ClassificationTargetResult = {
	scores: Record<string, number>;
};

/** ClassificationResponse: one results entry per input, keyed by target name. */
export type ClassificationResponse = {
	id?: string;
	model?: string;
	results?: Record<string, ClassificationTargetResult>[];
};
