/**
 * Mocked-HTTP unit tests for the Mistral knowledge tools.
 *
 * All HTTP is mocked via an injected fetch implementation; no network access
 * and no real API keys ("test-key" literal only).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMistralClient, MistralApiError } from "../extensions/tools/mistral-client.js";
import { createKnowledgeTools } from "../extensions/tools/knowledge.js";
import { DEFAULT_QUERY_MODEL } from "../extensions/tools/knowledge.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setMistralConfigForTests } from "../extensions/mistral/config.js";

// Force a deterministic no-file config baseline for this suite: the RAG
// streaming default must hold regardless of the developer's
// real mistral-native.json or environment. Per-test toggles set explicit
// configs and restore the baseline.
setMistralConfigForTests(null);
// A developer-exported MISTRAL_RAG_STREAMING would flip default-path tests
// onto the one-shot path; neutralize it for the suite and restore after.
const suiteRagStreamingEnv = process.env.MISTRAL_RAG_STREAMING;
delete process.env.MISTRAL_RAG_STREAMING;
process.on("exit", () => {
	if (suiteRagStreamingEnv !== undefined) {
		process.env.MISTRAL_RAG_STREAMING = suiteRagStreamingEnv;
	}
});

/** A recorded outgoing request. */
interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	signal?: AbortSignal | undefined;
}

/** Builds a recording fetch mock with a queue of canned responses. */
function createMockFetch() {
	const requests: RecordedRequest[] = [];
	let responseIndex = 0;
	const responses: { status: number; body: string }[] = [];

	const mockFetch = (async (_url: unknown, init?: RequestInit) => {
		const url = String(_url);
		requests.push({
			url,
			method: init?.method ?? "GET",
			headers: Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			),
			body: init?.body,
			signal: init?.signal ?? undefined,
		});
		const response = responses[responseIndex++];
		if (!response) {
			throw new Error(`unexpected request #${responseIndex - 1} to ${url}`);
		}
		// Statuses with a mandatory null body (204/304) must not receive a body.
		const nullBodyStatus = response.status === 204 || response.status === 304;
		return new Response(nullBodyStatus ? null : response.body, {
			status: response.status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	return {
		mockFetch,
		requests,
		/** Queue a canned response for the next request. */
		respond(status: number, body: unknown) {
			responses.push({ status, body: typeof body === "string" ? body : JSON.stringify(body) });
		},
	};
}

/** Builds the nine tools with a client bound to the mock fetch. */
function buildTools(mockFetch: typeof fetch) {
	const tools = createKnowledgeTools({
		getClient: async () => createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch }),
	});
	return tools;
}

/** Finds a tool by name and asserts it exists. */
function toolByName(tools: ToolDefinition<any, any>[], name: string) {
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `tool ${name} must exist`);
	return tool;
}

/** Calls a tool's execute with the standard pi signature. */
async function execute(tool: ToolDefinition<any, any>, params: unknown, signal?: AbortSignal) {
	const result = await tool.execute("call-1", params as never, signal, undefined, undefined as never);
	return result as {
		content: { type: string; text?: string }[];
		structuredContent?: Record<string, unknown>;
		details?: unknown;
		isError?: boolean;
	};
}

/**
 * Renders a multipart FormData body for assertions. File parts render as
 * `[file:<name>:<bytes>]` so tests pin both the uploaded filename and the
 * content size; plain values render as-is.
 */
async function formDataText(body: unknown): Promise<string> {
	assert.ok(body instanceof FormData, "expected a FormData body");
	const parts: string[] = [];
	for (const [key, value] of body.entries()) {
		// Cast to unknown: undici's FormDataEntryValue File type and the global
		// File type come from different declarations (instanceof needs unknown).
		const entry = value as unknown;
		if (typeof entry === "string") {
			parts.push(`${key}=${entry}`);
		} else if (entry instanceof File) {
			parts.push(`${key}=[file:${entry.name}:${entry.size}]`);
		} else if (entry instanceof Blob) {
			parts.push(`${key}=[blob:${entry.size}]`);
		} else {
			parts.push(`${key}=[unknown]`);
		}
	}
	return parts.join(";");
}

test("registerKnowledgeTools registers all nine knowledge tools", async () => {
	const { default: mistralExtension } = await import("../extensions/mistral.js");
	const registeredProviders: { name: string }[] = [];
	const registeredTools: { name: string }[] = [];
	const stubPi = {
		registerProvider: (providerOrName: unknown, _config?: unknown) => {
			// Native provider registration: a pi-ai Provider object.
			const provider = providerOrName as { id: string };
			registeredProviders.push({ name: provider.id });
		},
		on: () => undefined,
		registerTool: (tool: { name: string }) => {
			registeredTools.push(tool);
		},
		registerCommand: () => undefined,
	};
	mistralExtension(stubPi as never);
	assert.equal(registeredProviders.length, 1);
	assert.equal(registeredProviders[0]?.name, "mistral-native");
	// Main carries the OCR/embeddings/moderation/classification tools
	// (extensions/mistral/knowledge.ts); below them ride the nine
	// library/RAG tools and the seven connector tools.
	/*
	 * ADR 0005 — OCR, embeddings, moderations/classifications as pi tools;
	 * ADR 0007 — Server-side tools as opaque content
	 */
	assert.deepEqual(registeredTools.map((tool) => tool.name), [
		"mistral_ocr",
		"mistral_embed",
		"mistral_moderate",
		"mistral_classify",
		"mistral_file_upload",
		"mistral_library_create",
		"mistral_library_list",
		"mistral_document_upload",
		"mistral_document_list",
		"mistral_document_status",
		"mistral_document_signed_url",
		"mistral_document_reprocess",
		"mistral_document_query",
		"mistral_connector_list",
		"mistral_connector_tools",
		"mistral_connector_auth_url",
		"mistral_connector_activate",
		"mistral_connector_deactivate",
		"mistral_connector_share",
		"mistral_connector_unshare",
	]);
});

test("mistral_file_upload posts multipart to /v1/files with purpose and returns id", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mistral-test-"));
	const filePath = join(dir, "notes.txt");
	await writeFile(filePath, "hello mistral", "utf8");

	const mock = createMockFetch();
	mock.respond(200, {
		id: "file-123",
		object: "file",
		bytes: 13,
		created_at: 1716963433,
		filename: "notes.txt",
		purpose: "ocr",
		sample_type: "infer",
		source: "upload",
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_file_upload"), {
		path: filePath,
		purpose: "ocr",
	});

	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "POST");
	assert.ok(request.url.endsWith("/v1/files"), `unexpected url ${request.url}`);
	assert.equal(request.headers.Authorization, "Bearer test-key");
	assert.ok(!request.headers["Content-Type"], "multipart Content-Type must be set by fetch, not manually");
	const formText = await formDataText(request.body);
	// Pins both the uploaded filename and the exact content size.
	assert.match(formText, /file=\[file:notes\.txt:13\]/);
	assert.match(formText, /purpose=ocr/);
	assert.equal(result.isError, undefined);
	assert.equal(result.structuredContent?.id, "file-123");
	assert.equal(result.structuredContent?.bytes, 13);
});

test("mistral_file_upload applies defaults when purpose and visibility are omitted", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mistral-test-"));
	const filePath = join(dir, "plain.txt");
	await writeFile(filePath, "defaults", "utf8");

	const mock = createMockFetch();
	mock.respond(200, {
		id: "file-789",
		object: "file",
		bytes: null,
		created_at: 1716963433,
		filename: "plain.txt",
		purpose: "ocr",
		sample_type: "infer",
		source: "upload",
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_file_upload"), {
		path: filePath,
		// purpose and visibility deliberately omitted: execute must default them.
	});

	const formText = await formDataText(mock.requests[0]?.body);
	assert.match(formText, /purpose=ocr/);
	// visibility=user is our privacy-safe default (the API would default to workspace).
	assert.match(formText, /visibility=user/);
	// The spec's own /v1/files example returns bytes: null; it must pass through.
	assert.equal(result.structuredContent?.bytes, null);
});

test("mistral_file_upload sends visibility=workspace when explicitly passed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mistral-test-"));
	const filePath = join(dir, "shared.txt");
	await writeFile(filePath, "shared", "utf8");

	const mock = createMockFetch();
	mock.respond(200, {
		id: "file-999",
		object: "file",
		bytes: 6,
		created_at: 1716963433,
		filename: "shared.txt",
		purpose: "batch",
		sample_type: "infer",
		source: "upload",
	});
	const tools = buildTools(mock.mockFetch);
	await execute(toolByName(tools, "mistral_file_upload"), {
		path: filePath,
		purpose: "batch",
		visibility: "workspace",
	});
	const formText = await formDataText(mock.requests[0]?.body);
	assert.match(formText, /visibility=workspace/);
});

test("mistral_file_upload sends expiry when given", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mistral-test-"));
	const filePath = join(dir, "batch.jsonl");
	await writeFile(filePath, "{}", "utf8");

	const mock = createMockFetch();
	mock.respond(200, {
		id: "file-456",
		object: "file",
		bytes: 2,
		created_at: 1716963433,
		filename: "batch.jsonl",
		purpose: "batch",
		sample_type: "infer",
		source: "upload",
	});
	const tools = buildTools(mock.mockFetch);
	await execute(toolByName(tools, "mistral_file_upload"), {
		path: filePath,
		purpose: "batch",
		expiryHours: 24,
	});
	const formText = await formDataText(mock.requests[0]?.body);
	assert.match(formText, /purpose=batch/);
	assert.match(formText, /expiry=24/);
});

test("mistral_file_upload omits expiry from the form when expiryHours is absent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mistral-test-"));
	const filePath = join(dir, "plain.txt");
	await writeFile(filePath, "no-expiry-body", "utf8");

	const mock = createMockFetch();
	mock.respond(200, {
		id: "file-321",
		object: "file",
		bytes: 14,
		created_at: 1716963433,
		filename: "plain.txt",
		purpose: "ocr",
		sample_type: "infer",
		source: "upload",
	});
	const tools = buildTools(mock.mockFetch);
	await execute(toolByName(tools, "mistral_file_upload"), {
		path: filePath,
		purpose: "ocr",
	});
	const formText = await formDataText(mock.requests[0]?.body);
	// Deliberately neutral filename: only the form fields may contain "expiry".
	assert.ok(!/expiry/.test(formText), `expiry must be omitted: ${formText}`);
});

test("mistral_library_create posts JSON and maps the 201 Library response", async () => {
	const mock = createMockFetch();
	mock.respond(201, {
		id: "lib-1",
		name: "Project docs",
		created_at: "2026-10-30T00:00:00Z",
		updated_at: "2026-10-30T00:00:00Z",
		owner_id: null,
		owner_type: "user",
		total_size: 0,
		nb_documents: 0,
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_library_create"), {
		name: "Project docs",
		description: "All project documentation",
	});

	const request = mock.requests[0];
	assert.ok(request);
	assert.ok(request.url.endsWith("/v1/libraries"));
	assert.equal(request.headers["Content-Type"], "application/json");
	assert.equal(request.headers.Authorization, "Bearer test-key");
	const body = JSON.parse(String(request.body)) as Record<string, unknown>;
	assert.deepEqual(body, { name: "Project docs", description: "All project documentation" });
	assert.equal(result.structuredContent?.id, "lib-1");
	assert.equal(result.structuredContent?.name, "Project docs");
});

test("mistral_library_list encodes query params and maps nextPageToken", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		data: [
			{
				id: "lib-1",
				name: "Docs",
				created_at: "2026-10-30T00:00:00Z",
				updated_at: "2026-10-30T00:00:00Z",
				owner_id: null,
				owner_type: "user",
				total_size: 10,
				nb_documents: 2,
			},
		],
		next_page_token: "token-2",
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_library_list"), {
		search: "docs",
		pageSize: 10,
		pageToken: "token-1",
	});

	const request = mock.requests[0];
	assert.ok(request);
	const url = new URL(request.url);
	assert.equal(url.pathname, "/v1/libraries");
	assert.equal(url.searchParams.get("search"), "docs");
	assert.equal(url.searchParams.get("page_size"), "10");
	assert.equal(url.searchParams.get("page_token"), "token-1");
	const libraries = result.structuredContent?.libraries as { id: string }[];
	assert.equal(libraries?.length, 1);
	assert.equal(libraries?.[0]?.id, "lib-1");
	assert.equal(result.structuredContent?.nextPageToken, "token-2");
});

test("mistral_document_upload posts multipart to the library documents endpoint (201)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mistral-test-"));
	const filePath = join(dir, "report.pdf");
	await writeFile(filePath, "%PDF-1.4 fake", "utf8");

	const mock = createMockFetch();
	mock.respond(201, {
		id: "doc-9",
		library_id: "lib-1",
		mime_type: "application/pdf",
		extension: "pdf",
		size: 14,
		name: "report.pdf",
		created_at: "2026-10-30T00:00:00Z",
		process_status: "todo",
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_upload"), {
		libraryId: "lib-1",
		path: filePath,
	});

	const request = mock.requests[0];
	assert.ok(request);
	assert.ok(
		request.url.endsWith("/v1/libraries/lib-1/documents"),
		`unexpected url ${request.url}`,
	);
	assert.equal(request.headers.Authorization, "Bearer test-key");
	const formText = await formDataText(request.body);
	// Pins the uploaded filename and exact content size ("%PDF-1.4 fake" is 13 bytes).
	assert.match(formText, /file=\[file:report\.pdf:13\]/);
	assert.equal(result.structuredContent?.id, "doc-9");
	assert.equal(result.structuredContent?.process_status, "todo");
});

test("mistral_document_list passes pagination params through and maps the pagination block", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		pagination: { total_items: 5, total_pages: 3, current_page: 1, page_size: 2, has_more: true },
		data: [
			{
				id: "doc-1",
				library_id: "lib-1",
				name: "a.md",
				created_at: "2026-10-30T00:00:00Z",
				process_status: "done",
			},
		],
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_list"), {
		libraryId: "lib-1",
		search: "report",
		page: 1,
		pageSize: 2,
	});

	const request = mock.requests[0];
	assert.ok(request);
	const url = new URL(request.url);
	assert.equal(url.pathname, "/v1/libraries/lib-1/documents");
	assert.equal(url.searchParams.get("search"), "report");
	assert.equal(url.searchParams.get("page"), "1");
	assert.equal(url.searchParams.get("page_size"), "2");
	const documents = result.structuredContent?.documents as { id: string }[];
	assert.equal(documents?.[0]?.id, "doc-1");
	assert.deepEqual(result.structuredContent?.pagination, {
		totalItems: 5,
		totalPages: 3,
		currentPage: 1,
		pageSize: 2,
		hasMore: true,
	});
});

test("mistral_document_status merges document metadata with the status endpoint", async () => {
	const mock = createMockFetch();
	mock.respond(200, { document_id: "doc-1", process_status: "done", processing_status: "DONE" });
	mock.respond(200, {
		id: "doc-1",
		library_id: "lib-1",
		mime_type: "text/markdown",
		extension: "md",
		size: 42,
		name: "readme.md",
		created_at: "2026-10-30T00:00:00Z",
		process_status: "done",
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_status"), {
		libraryId: "lib-1",
		documentId: "doc-1",
	});

	assert.ok(mock.requests[0]?.url.endsWith("/v1/libraries/lib-1/documents/doc-1/status"));
	assert.ok(mock.requests[1]?.url.endsWith("/v1/libraries/lib-1/documents/doc-1"));
	assert.equal(result.structuredContent?.documentId, "doc-1");
	assert.equal(result.structuredContent?.processStatus, "done");
	assert.equal(result.structuredContent?.processingStatus, "DONE");
	assert.equal(result.structuredContent?.name, "readme.md");
	assert.equal(result.structuredContent?.size, 42);
});

test("mistral_document_status still returns status when metadata enrichment fails", async () => {
	const mock = createMockFetch();
	mock.respond(200, { document_id: "doc-1", process_status: "in_progress", processing_status: "RUNNING" });
	mock.respond(404, { message: "document metadata gone" });
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_status"), {
		libraryId: "lib-1",
		documentId: "doc-1",
	});
	assert.equal(result.isError, undefined);
	assert.equal(result.structuredContent?.processStatus, "in_progress");
	assert.equal(result.structuredContent?.name, undefined);
});

test("mistral_document_signed_url parses a JSON-quoted string body and keeps the URL out of details", async () => {
	const mock = createMockFetch();
	mock.respond(200, JSON.stringify("https://sig.example/a"));
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_signed_url"), {
		libraryId: "lib-1",
		documentId: "doc-1",
		kind: "document",
	});

	assert.ok(mock.requests[0]?.url.endsWith("/v1/libraries/lib-1/documents/doc-1/signed-url"));
	assert.equal(result.structuredContent?.url, "https://sig.example/a");
	assert.match(String(result.content[0]?.text), /https:\/\/sig\.example\/a/);
	// Never-logged rule: the signed URL must not appear in details (logs/transcripts).
	assert.doesNotMatch(JSON.stringify(result.details), /sig\.example/);
});

test("mistral_document_signed_url falls back to the raw body when it is not JSON", async () => {
	const mock = createMockFetch();
	mock.respond(200, "https://sig.example/raw");
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_signed_url"), {
		libraryId: "lib-1",
		documentId: "doc-1",
		kind: "extracted-text",
	});

	assert.ok(mock.requests[0]?.url.endsWith("/v1/libraries/lib-1/documents/doc-1/extracted-text-signed-url"));
	assert.equal(result.structuredContent?.url, "https://sig.example/raw");
	assert.match(String(result.content[0]?.text), /https:\/\/sig\.example\/raw/);
	assert.doesNotMatch(JSON.stringify(result.details), /sig\.example/);
});

test("mistral_document_signed_url defaults kind to document when omitted", async () => {
	const mock = createMockFetch();
	mock.respond(200, JSON.stringify("https://sig.example/a"));
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_signed_url"), {
		libraryId: "lib-1",
		documentId: "doc-1",
		// kind deliberately omitted: execute must default it.
	});
	assert.ok(mock.requests[0]?.url.endsWith("/v1/libraries/lib-1/documents/doc-1/signed-url"));
	assert.equal(result.structuredContent?.kind, "document");
	assert.equal(result.structuredContent?.url, "https://sig.example/a");
});

test("the abort signal passed to execute reaches fetch's init.signal", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		data: [],
		next_page_token: null,
	});
	const tools = buildTools(mock.mockFetch);
	const controller = new AbortController();
	await execute(toolByName(tools, "mistral_library_list"), { search: "docs" }, controller.signal);
	// Strict identity: the exact signal object must be forwarded, not a copy.
	assert.equal(mock.requests[0]?.signal, controller.signal);
});

test("query params round-trip special characters through URLSearchParams", async () => {
	const mock = createMockFetch();
	mock.respond(200, { data: [], next_page_token: null });
	const tools = buildTools(mock.mockFetch);
	await execute(toolByName(tools, "mistral_library_list"), { search: "a b&c" });
	const url = new URL(String(mock.requests[0]?.url));
	assert.equal(url.searchParams.get("search"), "a b&c");
});

test("a non-JSON error body produces an isError result with status and truncated raw body", async () => {
	const mock = createMockFetch();
	mock.respond(502, "<html>bad gateway</html>");
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_library_list"), {});

	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /502/);
	assert.match(text, /bad gateway/);
	assert.doesNotMatch(text, /test-key/);
});

test("mistral_document_reprocess maps a 204 empty body to an ok result", async () => {
	const mock = createMockFetch();
	mock.respond(204, "");
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_reprocess"), {
		libraryId: "lib-1",
		documentId: "doc-1",
	});

	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "POST");
	assert.ok(request.url.endsWith("/v1/libraries/lib-1/documents/doc-1/reprocess"));
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent, { reprocessed: true });
});

test("mistral_document_query with streaming disabled sends the one-shot document_library RAG request", async () => {
	/*
	 * Config toggle: rag.streaming=false forces the one-shot request over
	 * the streaming default.
	 * ADR 0015 — Streaming RAG document query
	 */
	setMistralConfigForTests({ rag: { streaming: false, defaultLibraryId: undefined } });
	const mock = createMockFetch();
	mock.respond(200, {
		choices: [
			{
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "The deploy guide says: run npm run build." },
						{
							type: "document_url",
							document_url: "https://sig.example/doc.pdf",
							document_name: "deploy-guide.pdf",
						},
					],
				},
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_query"), {
		libraryIds: ["lib-1", "lib-2"],
		query: "How do I deploy?",
	});

	const request = mock.requests[0];
	assert.ok(request);
	assert.ok(request.url.endsWith("/v1/chat/completions"));
	const body = JSON.parse(String(request.body)) as Record<string, any>;
	assert.equal(body.stream, false);
	assert.equal(body.model, DEFAULT_QUERY_MODEL);
	assert.deepEqual(body.tools, [{ type: "document_library", library_ids: ["lib-1", "lib-2"] }]);
	assert.deepEqual(body.messages, [{ role: "user", content: "How do I deploy?" }]);

	const chunks = result.structuredContent?.chunks as Record<string, unknown>[];
	assert.equal(chunks?.length, 2);
	assert.deepEqual(chunks?.[0], { type: "text", text: "The deploy guide says: run npm run build." });
	assert.deepEqual(chunks?.[1], {
		type: "document_url",
		documentUrl: "https://sig.example/doc.pdf",
		documentName: "deploy-guide.pdf",
	});
	const text = String(result.content[0]?.text);
	assert.match(text, /run npm run build/);
	assert.match(text, /Citations:/);
	assert.match(text, /deploy-guide\.pdf: https:\/\/sig\.example\/doc\.pdf/);
});

test("mistral_document_query with streaming disabled maps plain string content to a single text chunk", async () => {
	setMistralConfigForTests({ rag: { streaming: false, defaultLibraryId: undefined } });
	const mock = createMockFetch();
	mock.respond(200, {
		choices: [{ message: { role: "assistant", content: "Plain answer" }, finish_reason: "stop" }],
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_query"), {
		libraryIds: ["lib-1"],
		query: "Anything?",
		model: "mistral-small-latest",
	});
	const body = JSON.parse(String(mock.requests[0]?.body)) as Record<string, unknown>;
	assert.equal(body.model, "mistral-small-latest");
	const chunks = result.structuredContent?.chunks as Record<string, unknown>[];
	assert.deepEqual(chunks, [{ type: "text", text: "Plain answer" }]);
	assert.match(String(result.content[0]?.text), /Plain answer/);
	setMistralConfigForTests(null);
});

test("mistral_document_query streaming: an empty SSE stream maps to the no-content note", async () => {
	const mock = createMockFetch();
	// A well-formed SSE stream that carries no content deltas and no error.
	mock.respond(200, [
		'data: {"id":"rag-1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
		'data: {"id":"rag-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
		"data: [DONE]",
		"",
	].join("\n\n"));
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_query"), {
		libraryIds: ["lib-1"],
		query: "Anything?",
	});
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent?.chunks, []);
	assert.match(String(result.content[0]?.text), /no content/);
});

test("mistral_document_query streaming: an in-stream error event fails loudly, never as no-content", async () => {
	const mock = createMockFetch();
	mock.respond(200, [
		'data: {"id":"rag-1","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}',
		'data: {"error":{"message":"library index unavailable"}}',
		"data: [DONE]",
		"",
	].join("\n\n"));
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_query"), {
		libraryIds: ["lib-1"],
		query: "Anything?",
	});
	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /library index unavailable/);
	// The partial text must not be returned as an ok answer.
	assert.doesNotMatch(text, /partial/);
	assert.doesNotMatch(text, /no content/);
});

test("mistral_document_query streaming: a finish_reason error chunk fails loudly", async () => {
	const mock = createMockFetch();
	mock.respond(200, [
		'data: {"id":"rag-1","choices":[{"index":0,"delta":{"content":"some text"},"finish_reason":null}]}',
		'data: {"id":"rag-1","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}',
		"data: [DONE]",
		"",
	].join("\n\n"));
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_query"), {
		libraryIds: ["lib-1"],
		query: "Anything?",
	});
	assert.equal(result.isError, true);
	assert.match(String(result.content[0]?.text), /finish_reason error/);
	assert.doesNotMatch(String(result.content[0]?.text), /no content/);
});

test("mistral_document_query streaming: content with only ignored chunk types renders no-retrieved-text like one-shot", async () => {
	const mock = createMockFetch();
	// A stream whose only content is a chunk type with no retrieval payload
	// (thinking): mapped chunks are empty but content was delivered — the
	// one-shot path renders "(no retrieved text)" for this input class, and
	// the streaming path must render identically, not "no content".
	mock.respond(200, [
		'data: {"id":"rag-1","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"pondering"}]}]},"finish_reason":null}]}',
		'data: {"id":"rag-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
		"data: [DONE]",
		"",
	].join("\n\n"));
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_query"), {
		libraryIds: ["lib-1"],
		query: "Anything?",
	});
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent?.chunks, []);
	assert.match(String(result.content[0]?.text), /no retrieved text/);
	assert.doesNotMatch(String(result.content[0]?.text), /no content/);
});

test("mistral_document_query with streaming disabled returns an empty result for null content", async () => {
	setMistralConfigForTests({ rag: { streaming: false, defaultLibraryId: undefined } });
	const mock = createMockFetch();
	mock.respond(200, { choices: [{ message: { role: "assistant", content: null } }] });
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_document_query"), {
		libraryIds: ["lib-1"],
		query: "Anything?",
	});
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent?.chunks, []);
	assert.match(String(result.content[0]?.text), /no content/);
	setMistralConfigForTests(null);
});

test("mistral_document_query streams over SSE and maps chunks + citations identically to one-shot", async () => {
	const mock = createMockFetch();
	// SSE fixture: two text deltas (string + block-array), a document_url
	// citation chunk, then the terminal usage chunk and [DONE].
	const sseBody = [
		'data: {"id":"rag-1","model":"mistral-large-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
		'data: {"id":"rag-1","model":"mistral-large-4","choices":[{"index":0,"delta":{"content":"The deploy guide says: run "},"finish_reason":null}]}',
		'data: {"id":"rag-1","model":"mistral-large-4","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"npm run build."}]},"finish_reason":null}]}',
		'data: {"id":"rag-1","model":"mistral-large-4","choices":[{"index":0,"delta":{"content":[{"type":"document_url","document_url":"https://sig.example/doc.pdf","document_name":"deploy-guide.pdf"}]},"finish_reason":null}]}',
		'data: {"id":"rag-1","model":"mistral-large-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":2}}}',
		"data: [DONE]",
		"",
	].join("\n\n");
	mock.respond(200, sseBody);
	const tools = buildTools(mock.mockFetch);
	const previews: string[] = [];
	const queryTool = toolByName(tools, "mistral_document_query");
	const result = await queryTool.execute(
		"call-1",
		{ libraryIds: ["lib-1", "lib-2"], query: "How do I deploy?" } as never,
		undefined,
		(partial) => {
			const first = partial.content[0];
			previews.push(first && first.type === "text" ? first.text : "");
		},
		undefined as never,
	);

	const request = mock.requests[0];
	assert.ok(request);
	assert.ok(request.url.endsWith("/v1/chat/completions"));
	const body = JSON.parse(String(request.body)) as Record<string, any>;
	// Same request mapping as one-shot, plus the streaming wire options.
	assert.equal(body.stream, true);
	assert.deepEqual(body.stream_options, { include_usage: true });
	assert.equal(body.model, DEFAULT_QUERY_MODEL);
	assert.deepEqual(body.tools, [{ type: "document_library", library_ids: ["lib-1", "lib-2"] }]);
	assert.deepEqual(body.messages, [{ role: "user", content: "How do I deploy?" }]);

	// Chunks + citations mapping is identical to the one-shot implementation.
	const chunks = (result as { structuredContent?: { chunks?: Record<string, unknown>[] } }).structuredContent?.chunks;
	assert.equal(chunks?.length, 3);
	assert.deepEqual(chunks?.[0], { type: "text", text: "The deploy guide says: run " });
	assert.deepEqual(chunks?.[1], { type: "text", text: "npm run build." });
	assert.deepEqual(chunks?.[2], {
		type: "document_url",
		documentUrl: "https://sig.example/doc.pdf",
		documentName: "deploy-guide.pdf",
	});
	const text = String((result as { content: { text?: string }[] }).content[0]?.text);
	assert.match(text, /npm run build\./);
	assert.match(text, /Citations:/);
	assert.match(text, /deploy-guide\.pdf: https:\/\/sig\.example\/doc\.pdf/);
	// Preview updates fired: growing partial text reached the onUpdate channel.
	assert.ok(previews.length >= 2, `expected preview updates, got ${previews.length}`);
	assert.equal(previews[previews.length - 1], "The deploy guide says: run \nnpm run build.");
	// Usage from the terminal chunk is carried on the tool result.
	const usage = (result as unknown as { usage?: Record<string, unknown> }).usage;
	assert.ok(usage);
	assert.equal(usage.input, 8); // prompt_tokens 10 - cached 2
	assert.equal(usage.output, 5);
	assert.equal(usage.cacheRead, 2);
	assert.equal(usage.totalTokens, 15);
});

test("the RAG SSE parser: an event split across body reads still parses", async () => {
	// One event delivered in two separate body reads (byte-level split).
	const encoder = new TextEncoder();
	const full = 'data: {"id":"rag-1","choices":[{"index":0,"delta":{"content":"split answer"},"finish_reason":null}]}\n\n'
		+ 'data: {"id":"rag-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	const mid = full.indexOf("split");
	const part1 = full.slice(0, mid);
	const part2 = full.slice(mid);
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(encoder.encode(part1));
			c.enqueue(encoder.encode(part2));
			c.close();
		},
	});
	const mockFetch = (async () =>
		new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch });
	const collected: string[] = [];
	for await (const chunk of client.queryLibraryStream({ model: "mistral-large-4", libraryIds: ["lib-1"], query: "q" })) {
		const content = chunk.choices?.[0]?.delta?.content;
		if (typeof content === "string" && content.length > 0) collected.push(content);
	}
	assert.deepEqual(collected, ["split answer"]);
});

test("the RAG SSE parser: CRLF event framing parses", async () => {
	const sse = 'data: {"id":"rag-1","choices":[{"index":0,"delta":{"content":"crlf answer"},"finish_reason":null}]}\r\n\r\ndata: [DONE]\r\n\r\n';
	const mockFetch = (async () =>
		new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch });
	const collected: string[] = [];
	for await (const chunk of client.queryLibraryStream({ model: "mistral-large-4", libraryIds: ["lib-1"], query: "q" })) {
		const content = chunk.choices?.[0]?.delta?.content;
		if (typeof content === "string" && content.length > 0) collected.push(content);
	}
	assert.deepEqual(collected, ["crlf answer"]);
});

test("the RAG SSE parser: malformed JSON data fails loudly", async () => {
	const sse = 'data: {"id":"rag-1","choices":[BROKEN\n\n';
	const mockFetch = (async () =>
		new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch });
	await assert.rejects(
		client.queryLibraryStream({ model: "mistral-large-4", libraryIds: ["lib-1"], query: "q" }).next(),
		/malformed|JSON|parse/i,
	);
});

test("the RAG SSE parser: a stream ending without [DONE] still yields its chunks", async () => {
	const sse = 'data: {"id":"rag-1","choices":[{"index":0,"delta":{"content":"no done sentinel"},"finish_reason":"stop"}]}\n\n';
	const mockFetch = (async () =>
		new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch });
	const collected: string[] = [];
	for await (const chunk of client.queryLibraryStream({ model: "mistral-large-4", libraryIds: ["lib-1"], query: "q" })) {
		const content = chunk.choices?.[0]?.delta?.content;
		if (typeof content === "string" && content.length > 0) collected.push(content);
	}
	assert.deepEqual(collected, ["no done sentinel"]);
});

test("the RAG streaming path: a non-2xx response throws MistralApiError with the drained body", async () => {
	const mockFetch = (async () =>
		new Response(JSON.stringify({ message: "Library not found" }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch;
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch });
	await assert.rejects(
		client.queryLibraryStream({ model: "mistral-large-4", libraryIds: ["lib-1"], query: "q" }).next(),
		(error) => {
			assert.ok(error instanceof MistralApiError);
			assert.equal((error as MistralApiError).status, 404);
			assert.match((error as MistralApiError).message, /Library not found/);
			return true;
		},
	);
});

test("mistral_document_query abort mid-stream returns an aborted error result", async () => {
	const controller = new AbortController();
	let rejectRead: ((error: Error) => void) | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(
				new TextEncoder().encode(
					'data: {"id":"rag-1","model":"mistral-large-4","choices":[{"index":0,"delta":{"content":"partial answer"},"finish_reason":null}]}\n\n',
				),
			);
			// The next read never resolves; only the abort signal ends it.
			rejectRead = (error) => c.error(error);
			controller.signal.addEventListener("abort", () => rejectRead?.(new Error("aborted")), { once: true });
		},
	});
	const mock = createMockFetch();
	// respond() is not used; patch the mock to return our stream Response.
	const mockFetch = (async () =>
		new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
	const tools = createKnowledgeTools({
		getClient: async () => createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch }),
	});
	const queryTool = toolByName(tools, "mistral_document_query");
	const executing = queryTool.execute(
		"call-1",
		{ libraryIds: ["lib-1"], query: "long query" } as never,
		controller.signal,
		undefined,
		undefined as never,
	);
	// Give the stream a tick to consume the first chunk, then abort.
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	const result = (await executing) as {
		content: { text?: string }[];
		isError?: boolean;
		details?: Record<string, unknown>;
	};
	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /aborted/);
	// The abort error from the transport is mapped to the generic run()
	// failure shape; the key contract is: no partial answer is returned as
	// an ok result, and the abort is visible as an isError result.
	assert.doesNotMatch(text, /Citations:/);
	assert.equal((result.details as Record<string, unknown> | undefined)?.tool, "mistral_document_query");
});

test("config precedence: rag.streaming wins over knowledge.streaming; env applies only without JSON", async () => {
	const { getEffectiveRagStreaming } = await import("../extensions/mistral/config.js");
	// No file config: env var decides.
	setMistralConfigForTests(null);
	process.env.MISTRAL_RAG_STREAMING = "0";
	assert.equal(getEffectiveRagStreaming(), false);
	delete process.env.MISTRAL_RAG_STREAMING;
	assert.equal(getEffectiveRagStreaming(), true); // default
	// knowledge.streaming applies when rag.streaming is unset.
	setMistralConfigForTests({ knowledge: { streaming: false } });
	assert.equal(getEffectiveRagStreaming(), false);
	setMistralConfigForTests({ knowledge: { streaming: true } });
	assert.equal(getEffectiveRagStreaming(), true);
	// rag.streaming wins over knowledge.streaming (both set).
	setMistralConfigForTests({
		knowledge: { streaming: true },
		rag: { streaming: false, defaultLibraryId: undefined },
	});
	assert.equal(getEffectiveRagStreaming(), false);
	setMistralConfigForTests({
		knowledge: { streaming: false },
		rag: { streaming: true, defaultLibraryId: undefined },
	});
	assert.equal(getEffectiveRagStreaming(), true);
	// JSON wins over env.
	process.env.MISTRAL_RAG_STREAMING = "0";
	setMistralConfigForTests({ rag: { streaming: true, defaultLibraryId: undefined } });
	assert.equal(getEffectiveRagStreaming(), true);
	delete process.env.MISTRAL_RAG_STREAMING;
	// Restore the no-file baseline.
	setMistralConfigForTests(null);
});

test("mistral_document_query with streaming forced off by env var uses the one-shot request", async () => {
	process.env.MISTRAL_RAG_STREAMING = "0";
	try {
		const mock = createMockFetch();
		mock.respond(200, {
			choices: [{ message: { role: "assistant", content: "Plain answer" }, finish_reason: "stop" }],
		});
		const tools = buildTools(mock.mockFetch);
		const result = await execute(toolByName(tools, "mistral_document_query"), {
			libraryIds: ["lib-1"],
			query: "Anything?",
		});
		const body = JSON.parse(String(mock.requests[0]?.body)) as Record<string, unknown>;
		assert.equal(body.stream, false);
		const chunks = result.structuredContent?.chunks as Record<string, unknown>[];
		assert.deepEqual(chunks, [{ type: "text", text: "Plain answer" }]);
	} finally {
		delete process.env.MISTRAL_RAG_STREAMING;
		setMistralConfigForTests(null);
	}
});

test("a 404 JSON error maps to an isError result with status and server message", async () => {
	const mock = createMockFetch();
	mock.respond(404, { message: "Library not found" });
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_library_list"), {});

	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /404/);
	assert.match(text, /Library not found/);
	// The API key must never leak into error results.
	assert.doesNotMatch(text, /test-key/);
});

test("MistralApiError carries status and a truncated body without headers", async () => {
	const longBody = "x".repeat(600);
	const mock = createMockFetch();
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	mock.respond(500, JSON.stringify({ detail: longBody }));
	try {
		await client.listLibraries({});
		assert.fail("expected rejection");
	} catch (error) {
		assert.ok(error instanceof MistralApiError, "expected a MistralApiError");
		const apiError = error as MistralApiError;
		assert.equal(apiError.status, 500);
		assert.match(apiError.message, /500/);
		assert.match(apiError.message, /x{10}/);
		assert.ok((apiError.body ?? "").length <= 501);
		assert.ok(!apiError.message.includes("test-key"));
	}
});

test("missing API key produces a clear isError result mentioning MISTRAL_API_KEY", async () => {
	const mock = createMockFetch();
	const tools = createKnowledgeTools({
		getClient: async () => createMistralClient({ apiKey: undefined, fetchImpl: mock.mockFetch }),
	});
	const result = await execute(toolByName(tools, "mistral_library_list"), {});
	assert.equal(result.isError, true);
	assert.match(String(result.content[0]?.text), /MISTRAL_API_KEY/);
	assert.equal(mock.requests.length, 0, "no request must be sent without a key");
});
