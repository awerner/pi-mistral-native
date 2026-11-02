/**
 * Small shared HTTP client for Mistral's knowledge APIs (files, libraries,
 * documents) and the chat-completions RAG query paths (one-shot and
 * streaming).
 *
 * Wire formats verified against vendor/mistral-openapi.yaml; the one known
 * drift: the streaming request sends `stream_options:
 * {include_usage: true}`, which the vendored ChatCompletionRequest schema
 * (additionalProperties: false) does not declare — inherited from the
 * established provider stream path (extensions/mistral.ts) and verified
 * against the live API.
 * The fetch implementation is injectable so the tool tests can mock HTTP
 * without network access. Secrets are only ever placed on the outbound
 * Authorization header; they never appear in error messages or logs.
 *
 * ADR 0003 — Vendored OpenAPI spec; ADR 0015 — Streaming RAG document query.
 */

/** Options for {@link createMistralClient}. */
export interface MistralClientOptions {
	/** API base URL; defaults to `https://api.mistral.ai/v1`. */
	baseUrl?: string | undefined;
	/** Injected fetch implementation (tests); defaults to global fetch. */
	fetchImpl?: typeof fetch | undefined;
	/** Mistral API key. Required at request time; never logged. */
	apiKey?: string | undefined;
}

/** Error thrown for non-2xx Mistral API responses. Never contains request headers or the API key. */
export class MistralApiError extends Error {
	readonly status: number;
	/** Response body (truncated) for diagnostics; server-supplied content only. */
	readonly body: string;

	constructor(status: number, body: string) {
		const truncated = body.length > 500 ? `${body.slice(0, 500)}…` : body;
		const serverMessage = extractServerMessage(body);
		super(
			serverMessage
				? `Mistral API error ${status}: ${serverMessage}`
				: `Mistral API error ${status}${truncated ? `: ${truncated}` : ""}`,
		);
		this.name = "MistralApiError";
		this.status = status;
		this.body = truncated;
	}
}

/** Extracts a short server-supplied message from a JSON error body (`message` or `detail`). */
function extractServerMessage(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed !== null && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			for (const key of ["message", "detail"]) {
				const value = record[key];
				if (typeof value === "string" && value.length > 0) {
					return value.length > 300 ? `${value.slice(0, 300)}…` : value;
				}
			}
		}
	} catch {
		// Body is not JSON; the caller falls back to the raw text.
	}
	return undefined;
}

/** CreateFileResponse from POST /v1/files (loose subset). */
export interface CreateFileResponse {
	id: string;
	object: string;
	bytes: number;
	created_at: number;
	filename: string;
	purpose: string;
	sample_type?: string | null;
	num_lines?: number | null;
	mimetype?: string | null;
	signature?: string | null;
}

/** Library object (GET/POST /v1/libraries; loose subset). */
export interface MistralLibrary {
	id: string;
	name: string;
	created_at: string;
	updated_at: string;
	owner_id?: string | null;
	owner_type: string;
	total_size: number;
	nb_documents: number;
	description?: string | null;
	[key: string]: unknown;
}

/** Document object (loose subset; process_status per the ProcessStatus enum). */
export interface MistralDocument {
	id: string;
	library_id: string;
	mime_type?: string | null;
	extension?: string | null;
	size?: number | null;
	name: string;
	created_at: string;
	process_status: string;
	number_of_pages?: number | null;
	[key: string]: unknown;
}

/** Connector object from GET /v1/connectors (loose subset). */
export interface MistralConnector {
	id: string;
	name: string;
	description?: string | null | undefined;
	owner_type: string;
	visibility: string;
	[key: string]: unknown;
}

/** One tool of a connector from GET /v1/connectors/{id}/tools (loose subset). */
export interface MistralConnectorTool {
	name: string;
	title?: string | undefined;
	description?: string | null | undefined;
	inputSchema: Record<string, unknown>;
	[key: string]: unknown;
}

/** ProcessingStatus from GET .../status (loose subset). */
export interface DocumentProcessingStatus {
	document_id: string;
	process_status: string;
	processing_status: string;
}

/** Offset pagination block of GET /v1/libraries/{id}/documents. */
export interface DocumentPagination {
	total_items: number;
	total_pages: number;
	current_page: number;
	page_size: number;
	has_more: boolean;
}

/** Content chunk of a chat-completions message: text or document_url. */
export type QueryContentChunk =
	| { type: "text"; text: string }
	| { type: "document_url"; document_url: string; document_name?: string | null };

/** Raw non-streaming ChatCompletionResponse (loose subset for RAG queries). */
export interface ChatCompletionResponse {
	choices?: {
		message?: {
			role?: string;
			content?: string | QueryContentChunk[] | null;
			[key: string]: unknown;
		};
		finish_reason?: string;
	}[];
	usage?: Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * One `text/event-stream` chunk of a streaming RAG query
 * (vendor/mistral-openapi.yaml: CompletionChunk, loose subset). The delta
 * content follows the same ContentChunk union as the non-streaming message
 * (text and document_url chunks; a plain string is also accepted).
 */
export interface RagStreamChunk {
	id?: string;
	model?: string;
	usage?: Record<string, unknown>;
	/** In-stream failure payload delivered by Mistral-compatible gateways. */
	error?: unknown;
	choices?: {
		index?: number;
		delta?: {
			role?: string;
			content?: string | QueryContentChunk[] | null;
		};
		finish_reason?: string | null;
	}[];
	[key: string]: unknown;
}

/** The Mistral knowledge-API surface used by the pi tools. */
export interface MistralClient {
	uploadFile(args: {
		fileName: string;
		content: Uint8Array;
		mimeType: string;
		purpose: string;
		expiryHours?: number | undefined;
		visibility?: string | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<CreateFileResponse>;
	createLibrary(args: {
		name: string;
		description?: string | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<MistralLibrary>;
	listLibraries(args: {
		search?: string | undefined;
		pageSize?: number | undefined;
		pageToken?: string | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<{ data: MistralLibrary[]; next_page_token: string | null }>;
	uploadDocument(args: {
		libraryId: string;
		fileName: string;
		content: Uint8Array;
		mimeType: string;
		signal?: AbortSignal | undefined;
	}): Promise<MistralDocument>;
	listDocuments(args: {
		libraryId: string;
		search?: string | undefined;
		pageSize?: number | undefined;
		page?: number | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<{ pagination: DocumentPagination; data: MistralDocument[] }>;
	getDocument(args: {
		libraryId: string;
		documentId: string;
		signal?: AbortSignal | undefined;
	}): Promise<MistralDocument>;
	getDocumentStatus(args: {
		libraryId: string;
		documentId: string;
		signal?: AbortSignal | undefined;
	}): Promise<DocumentProcessingStatus>;
	getDocumentSignedUrl(args: {
		libraryId: string;
		documentId: string;
		kind: "document" | "extracted-text";
		signal?: AbortSignal | undefined;
	}): Promise<string>;
	reprocessDocument(args: {
		libraryId: string;
		documentId: string;
		signal?: AbortSignal | undefined;
	}): Promise<void>;
	queryLibrary(args: {
		model: string;
		libraryIds: string[];
		query: string;
		maxTokens?: number | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<ChatCompletionResponse>;
	/**
	 * Streaming RAG query over /v1/chat/completions: same request mapping as
	 * {@link queryLibrary} with `stream: true`, but the SSE body is yielded
	 * chunk-by-chunk so the caller can assemble the result progressively and
	 * forward abort mid-stream.
	 *
	 * ADR 0015 — Streaming RAG document query.
	 */
	queryLibraryStream(args: {
		model: string;
		libraryIds: string[];
		query: string;
		maxTokens?: number | undefined;
		signal?: AbortSignal | undefined;
	}): AsyncGenerator<RagStreamChunk>;
	listConnectors(args: {
		cursor?: string | undefined;
		pageSize?: number | undefined;
		/** Sets the fetch_user_data query filter (populates is_authenticated); optional. */
		fetchUserData?: boolean | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<{ items: MistralConnector[]; nextCursor: string | null }>;
	listConnectorTools(args: {
		connectorIdOrName: string;
		signal?: AbortSignal | undefined;
	}): Promise<MistralConnectorTool[]>;
	/** Raw tools listing for the client-side loader: pretty=false, page_size=1000, defensive shape handling. */
	listConnectorToolsRaw(args: {
		connectorIdOrName: string;
		pageSize?: number | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<MistralConnectorTool[]>;
	/** Calls a connector tool server-side proxy: POST {arguments}; returns the parsed response object. */
	callConnectorTool(args: {
		connectorIdOrName: string;
		toolName: string;
		arguments: Record<string, unknown>;
		signal?: AbortSignal | undefined;
	}): Promise<Record<string, unknown>>;
	/**
	 * Stateless one-shot Conversations call: a fresh POST /v1/conversations
	 * with `store: false`; the returned conversation_id is discarded by the
	 * caller. Thin transport method — response parsing lives in the tool
	 * module.
	 *
	 * ADR 0018 — Web search as a Conversations-backed tool.
	 */
	createConversation(args: {
		model: string;
		toolType: "web_search" | "web_search_premium";
		query: string;
		signal?: AbortSignal | undefined;
	}): Promise<unknown>;
	getConnectorAuthUrl(args: {
		connectorIdOrName: string;
		appReturnUrl?: string | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<{ authUrl: string; ttl: number }>;
	activateConnector(args: {
		connectorId: string;
		consumerScope: "user" | "workspace" | "organization";
		signal?: AbortSignal | undefined;
	}): Promise<string>;
	deactivateConnector(args: {
		connectorId: string;
		consumerScope: "user" | "workspace" | "organization";
		signal?: AbortSignal | undefined;
	}): Promise<string>;
	shareConnector(args: {
		connectorId: string;
		signal?: AbortSignal | undefined;
	}): Promise<string>;
	unshareConnector(args: {
		connectorId: string;
		signal?: AbortSignal | undefined;
	}): Promise<string>;
}

/**
 * Shared request helper. Sets Authorization/Accept, sends JSON or FormData
 * bodies, and throws {@link MistralApiError} on non-ok responses. The
 * Content-Type of multipart bodies is set by fetch itself (boundary).
 */
async function request(
	fetchImpl: typeof fetch,
	baseUrl: string,
	apiKey: string | undefined,
	method: "GET" | "POST" | "PUT" | "DELETE",
	path: string,
	init: { signal?: AbortSignal | undefined; query?: Record<string, string | undefined>; json?: unknown; form?: FormData },
): Promise<{ ok: true; text: string; status: number } | { ok: false; status: number; body: string }> {
	if (!apiKey) {
		throw new Error("MISTRAL_API_KEY not set and mistral-native provider has no API key");
	}
	const url = new URL(`${baseUrl}${path}`);
	for (const [key, value] of Object.entries(init.query ?? {})) {
		if (value !== undefined) {
			url.searchParams.set(key, value);
		}
	}
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/json",
	};
	if (init.json !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	const response = await fetchImpl(url, {
		method,
		headers,
		...(init.json !== undefined
			? { body: JSON.stringify(init.json) }
			: init.form !== undefined
				? { body: init.form }
				: {}),
		...(init.signal !== undefined ? { signal: init.signal } : {}),
	});
	const text = await response.text();
	if (!response.ok) {
		return { ok: false, status: response.status, body: text };
	}
	return { ok: true, text, status: response.status };
}

/** Parses a JSON object response; throws on a non-object body. */
function parseJsonObject(text: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Mistral API returned an unexpected non-object body: ${text.slice(0, 200)}`);
	}
	return parsed as Record<string, unknown>;
}

/** Builds the multipart form for a file/document upload (Node ≥ 22 globals). */
function buildUploadForm(
	fileName: string,
	content: Uint8Array,
	mimeType: string,
	extra: Record<string, string>,
): FormData {
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(content)], { type: mimeType }), fileName);
	for (const [key, value] of Object.entries(extra)) {
		form.append(key, value);
	}
	return form;
}

/** Extracts the `message` string from a MessageResponse body. */
function extractMessage(parsed: Record<string, unknown>): string {
	if (typeof parsed.message !== "string") {
		throw new Error("Mistral API message response is malformed: missing message");
	}
	return parsed.message;
}

/**
 * POST a JSON body expecting an SSE (or JSON) response and return the raw
 * Response with the body unconsumed. Throws {@link MistralApiError} on
 * non-2xx responses (the error body is drained and truncated). The body is
 * consumed incrementally by {@link sseChunkStream}.
 *
 * ADR 0015 — Streaming RAG document query.
 */
async function postStreaming(
	fetchImpl: typeof fetch,
	baseUrl: string,
	apiKey: string | undefined,
	path: string,
	json: unknown,
	signal: AbortSignal | undefined,
): Promise<Response> {
	if (!apiKey) {
		throw new Error("MISTRAL_API_KEY not set and mistral-native provider has no API key");
	}
	const response = await fetchImpl(new URL(`${baseUrl}${path}`), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "text/event-stream",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(json),
		...(signal !== undefined ? { signal } : {}),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new MistralApiError(response.status, text);
	}
	return response;
}

/**
 * Yields decoded JSON values from a `text/event-stream` body, terminating on
 * the `data: [DONE]` sentinel (vendor/mistral-openapi.yaml: CompletionChunk
 * stream). Malformed JSON fails the generator loudly — never a silent
 * truncation. Early termination (sentinel, natural EOF, or the caller's
 * abort signal) cancels the body reader so the connection is released, not
 * left half-consumed. An abort that fires while a body read is in flight
 * rejects that read with a transport AbortError, which propagates to the
 * caller as a thrown error — the tool maps either way to an error result,
 * never a partial answer.
 */
async function* sseChunkStream(response: Response, signal: AbortSignal | undefined): AsyncGenerator<RagStreamChunk> {
	const body = response.body;
	// The Response stub of some test doubles has no body; fall back to text().
	if (!body) {
		const text = await response.text();
		for await (const chunk of sseTextChunks(text)) {
			yield chunk;
		}
		return;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			if (signal?.aborted) {
				await reader.cancel().catch(() => undefined);
				return;
			}
			const read = await reader.read();
			if (read.done) break;
			buffer += decoder.decode(read.value, { stream: true });
			for (;;) {
				const { event, rest } = extractSseEvent(buffer);
				if (!event) {
					buffer = rest;
					break;
				}
				buffer = rest;
				const chunk = parseSseData(event);
				if (chunk.done) {
					// Release the body (keep-alive) instead of leaving it
					// half-consumed past the sentinel.
					await reader.cancel().catch(() => undefined);
					return;
				}
				if (chunk.data !== undefined) yield chunk.data as RagStreamChunk;
			}
		}
		buffer += decoder.decode();
		for await (const chunk of sseTextChunks(buffer)) {
			yield chunk;
		}
	} finally {
		reader.releaseLock();
	}
}

/** Yields JSON chunk values from a complete SSE text; [DONE] terminates. */
async function* sseTextChunks(text: string): AsyncGenerator<RagStreamChunk> {
	let buffer = text;
	for (;;) {
		const { event, rest } = extractSseEvent(buffer);
		if (!event) return;
		buffer = rest;
		const chunk = parseSseData(event);
		if (chunk.done) return;
		if (chunk.data !== undefined) yield chunk.data as RagStreamChunk;
	}
}

/** Split off the first complete SSE event (blank-line separated, LF or CRLF). */
function extractSseEvent(buffer: string): { event: string | null; rest: string } {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	let index = -1;
	let length = 0;
	if (lf !== -1 && (crlf === -1 || lf <= crlf)) {
		index = lf;
		length = 2;
	} else if (crlf !== -1) {
		index = crlf;
		length = 4;
	}
	if (index === -1) return { event: null, rest: buffer };
	return { event: buffer.slice(0, index), rest: buffer.slice(index + length) };
}

/** Parse one SSE event: joins `data:` lines, [DONE] sentinel, JSON decode. */
function parseSseData(raw: string): { done?: boolean; data?: unknown } {
	const dataLines: string[] = [];
	for (const line of raw.split(/\r\n|\n|\r/)) {
		if (line.startsWith(":")) continue;
		if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	}
	if (dataLines.length === 0) return {};
	const data = dataLines.join("\n");
	if (data.trim() === "[DONE]") return { done: true };
	return { data: JSON.parse(data) as unknown };
}

/** Creates a {@link MistralClient} bound to the given options. */
export function createMistralClient(options: MistralClientOptions): MistralClient {
	/*
	 * Global by default: the Files API backing this client is not available
	 * regionally, so the default base URL deliberately stays on the global
	 * endpoint regardless of the configured region — an explicit
	 * `options.baseUrl` still overrides it.
	 *
	 * ADR 0012 — Selectable region endpoint with per-family routing.
	 */
	const baseUrl = (options.baseUrl ?? "https://api.mistral.ai/v1").replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? fetch;
	const apiKey = options.apiKey;

	/** GET/POST/PUT/DELETE wrapper that throws MistralApiError on non-ok. */
	const doRequest = (
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		init: Parameters<typeof request>[5],
	) =>
		request(fetchImpl, baseUrl, apiKey, method, path, init).then((result) => {
			if (!result.ok) {
				throw new MistralApiError(result.status, result.body);
			}
			return result.text;
		});

	return {
		async uploadFile({ fileName, content, mimeType, purpose, expiryHours, visibility, signal }) {
			const form = buildUploadForm(fileName, content, mimeType, {
				purpose,
				...(expiryHours !== undefined ? { expiry: String(expiryHours) } : {}),
				...(visibility !== undefined ? { visibility } : {}),
			});
			const text = await doRequest("POST", "/files", { form, signal });
			return parseJsonObject(text) as unknown as CreateFileResponse;
		},
		async createLibrary({ name, description, signal }) {
			const text = await doRequest("POST", "/libraries", {
				json: { name, ...(description !== undefined ? { description } : {}) },
				signal,
			});
			return parseJsonObject(text) as unknown as MistralLibrary;
		},
		async listLibraries({ search, pageSize, pageToken, signal }) {
			const text = await doRequest("GET", "/libraries", {
				query: { search, page_size: pageSize?.toString(), page_token: pageToken },
				signal,
			});
			const parsed = parseJsonObject(text);
			const data = Array.isArray(parsed.data) ? (parsed.data as MistralLibrary[]) : [];
			const nextPageToken =
				typeof parsed.next_page_token === "string" ? parsed.next_page_token : null;
			return { data, next_page_token: nextPageToken };
		},
		async uploadDocument({ libraryId, fileName, content, mimeType, signal }) {
			const form = buildUploadForm(fileName, content, mimeType, {});
			const text = await doRequest("POST", `/libraries/${encodeURIComponent(libraryId)}/documents`, {
				form,
				signal,
			});
			return parseJsonObject(text) as unknown as MistralDocument;
		},
		async listDocuments({ libraryId, search, pageSize, page, signal }) {
			const text = await doRequest("GET", `/libraries/${encodeURIComponent(libraryId)}/documents`, {
				query: { search, page_size: pageSize?.toString(), page: page?.toString() },
				signal,
			});
			const parsed = parseJsonObject(text);
			const data = Array.isArray(parsed.data) ? (parsed.data as MistralDocument[]) : [];
			const pagination = (parsed.pagination ?? {}) as DocumentPagination;
			return { pagination, data };
		},
		async getDocument({ libraryId, documentId, signal }) {
			const text = await doRequest(
				"GET",
				`/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}`,
				{ signal },
			);
			return parseJsonObject(text) as unknown as MistralDocument;
		},
		async getDocumentStatus({ libraryId, documentId, signal }) {
			const text = await doRequest(
				"GET",
				`/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}/status`,
				{ signal },
			);
			return parseJsonObject(text) as unknown as DocumentProcessingStatus;
		},
		async getDocumentSignedUrl({ libraryId, documentId, kind, signal }) {
			const suffix = kind === "extracted-text" ? "extracted-text-signed-url" : "signed-url";
			const text = await doRequest(
				"GET",
				`/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}/${suffix}`,
				{ signal },
			);
			// The spec declares the body as a bare JSON string, but it may arrive
			// as a JSON-quoted string or as raw text; handle both.
			try {
				const parsed: unknown = JSON.parse(text);
				if (typeof parsed === "string") {
					return parsed;
				}
			} catch {
				// Not JSON — fall through to the raw body.
			}
			return text;
		},
		async reprocessDocument({ libraryId, documentId, signal }) {
			// 204 No Content on success.
			await doRequest(
				"POST",
				`/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}/reprocess`,
				{ signal },
			);
		},
		async listConnectors({ cursor, pageSize, fetchUserData, signal }) {
			const text = await doRequest("GET", "/connectors", {
				query: {
					cursor,
					page_size: pageSize?.toString(),
					fetch_user_data: fetchUserData === undefined ? undefined : String(fetchUserData),
				},
				signal,
			});
			const parsed = parseJsonObject(text);
			const items = Array.isArray(parsed.items) ? (parsed.items as MistralConnector[]) : [];
			const pagination = (parsed.pagination ?? {}) as Record<string, unknown>;
			const nextCursor = typeof pagination.next_cursor === "string" ? pagination.next_cursor : null;
			return { items, nextCursor };
		},
		async listConnectorTools({ connectorIdOrName, signal }) {
			const text = await doRequest(
				"GET",
				`/connectors/${encodeURIComponent(connectorIdOrName)}/tools`,
				{ signal },
			);
			const parsed: unknown = JSON.parse(text);
			if (!Array.isArray(parsed)) {
				throw new Error(`Mistral API returned an unexpected non-array body: ${text.slice(0, 200)}`);
			}
			return parsed as MistralConnectorTool[];
		},
		async listConnectorToolsRaw({ connectorIdOrName, pageSize, signal }) {
			// Live-verified 2026-11-02: the response is a bare array,
			// but be defensive — accept {items: [...]} and {data: [...]} object
			// shapes too, following pagination.next_cursor only when the object
			// shape carries one.
			const tools: MistralConnectorTool[] = [];
			let cursor: string | undefined;
			for (;;) {
				const text = await doRequest(
					"GET",
					`/connectors/${encodeURIComponent(connectorIdOrName)}/tools`,
					{ query: { pretty: "false", page_size: (pageSize ?? 1000).toString(), cursor }, signal },
				);
				const parsed: unknown = JSON.parse(text);
				let batch: unknown[] | undefined;
				let nextCursor: string | undefined;
				if (Array.isArray(parsed)) {
					batch = parsed;
				} else if (parsed !== null && typeof parsed === "object") {
					const record = parsed as Record<string, unknown>;
					batch = Array.isArray(record.items) ? record.items : Array.isArray(record.data) ? record.data : undefined;
					// `pagination` may be null in a live body (the cast type does not
					// exclude it) — reading next_cursor off null would throw.
					const pagination = record.pagination;
					if (pagination !== null && pagination !== undefined && typeof pagination === "object") {
						const nextCursorRaw = (pagination as Record<string, unknown>).next_cursor;
						if (typeof nextCursorRaw === "string") {
							nextCursor = nextCursorRaw;
						}
					}
				}
				if (batch === undefined) {
					throw new Error(`Mistral API returned an unexpected tools body: ${text.slice(0, 200)}`);
				}
				for (const entry of batch) {
					if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
						tools.push(entry as MistralConnectorTool);
					}
				}
				if (nextCursor === undefined) break;
				cursor = nextCursor;
			}
			return tools;
		},
		async callConnectorTool({ connectorIdOrName, toolName, arguments: toolArguments, signal }) {
			const text = await doRequest(
				"POST",
				`/connectors/${encodeURIComponent(connectorIdOrName)}/tools/${encodeURIComponent(toolName)}/call`,
				{ json: { arguments: toolArguments }, signal },
			);
			return parseJsonObject(text);
		},
		async getConnectorAuthUrl({ connectorIdOrName, appReturnUrl, signal }) {
			const text = await doRequest(
				"GET",
				`/connectors/${encodeURIComponent(connectorIdOrName)}/auth_url`,
				{ query: { app_return_url: appReturnUrl }, signal },
			);
			const parsed = parseJsonObject(text);
			if (typeof parsed.auth_url !== "string") {
				throw new Error("Mistral API auth_url response is malformed: missing auth_url");
			}
			const ttl = typeof parsed.ttl === "number" ? parsed.ttl : 0;
			return { authUrl: parsed.auth_url, ttl };
		},
		async activateConnector({ connectorId, consumerScope, signal }) {
			const text = await doRequest(
				"POST",
				`/connectors/${encodeURIComponent(connectorId)}/${encodeURIComponent(consumerScope)}/activate`,
				{ signal },
			);
			return extractMessage(parseJsonObject(text));
		},
		async deactivateConnector({ connectorId, consumerScope, signal }) {
			const text = await doRequest(
				"POST",
				`/connectors/${encodeURIComponent(connectorId)}/${encodeURIComponent(consumerScope)}/deactivate`,
				{ signal },
			);
			return extractMessage(parseJsonObject(text));
		},
		async shareConnector({ connectorId, signal }) {
			const text = await doRequest("PUT", `/connectors/${encodeURIComponent(connectorId)}/share`, { signal });
			return extractMessage(parseJsonObject(text));
		},
		async unshareConnector({ connectorId, signal }) {
			const text = await doRequest("DELETE", `/connectors/${encodeURIComponent(connectorId)}/share`, { signal });
			return extractMessage(parseJsonObject(text));
		},
		async queryLibrary({ model, libraryIds, query, maxTokens, signal }) {
			const text = await doRequest("POST", "/chat/completions", {
				json: {
					model,
					messages: [{ role: "user", content: query }],
					tools: [{ type: "document_library", library_ids: libraryIds }],
					stream: false,
					...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
				},
				signal,
			});
			return parseJsonObject(text) as unknown as ChatCompletionResponse;
		},
		async createConversation({ model, toolType, query, signal }) {
			// Wire-verified 2026-11-03: the Conversations endpoint takes `inputs`
			// (NOT `messages`, which it rejects as extra_forbidden) and accepts
			// `store: false` for a stateless one-shot call.
			const text = await doRequest("POST", "/conversations", {
				json: {
					inputs: [{ role: "user", content: query }],
					model,
					tools: [{ type: toolType }],
					stream: false,
					store: false,
				},
				signal,
			});
			return JSON.parse(text) as unknown;
		},
		async *queryLibraryStream({ model, libraryIds, query, maxTokens, signal }) {
			/*
			 * Streaming RAG query: identical request mapping to queryLibrary —
			 * the document_library tool declaration included — with `stream:
			 * true` and usage in the terminal SSE chunk
			 * (`stream_options.include_usage`). Unlike the one-shot methods,
			 * this consumes the response body incrementally so a long answer
			 * arrives chunk-by-chunk and an abort signal can stop the transfer
			 * mid-stream.
			 *
			 * ADR 0015 — Streaming RAG document query.
			 */
			const response = await postStreaming(fetchImpl, baseUrl, apiKey, "/chat/completions", {
				model,
				messages: [{ role: "user", content: query }],
				tools: [{ type: "document_library", library_ids: libraryIds }],
				stream: true,
				stream_options: { include_usage: true },
				...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
			}, signal);
			for await (const chunk of sseChunkStream(response, signal)) {
				yield chunk;
			}
		},
	};
}
