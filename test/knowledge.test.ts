/**
 * Mocked-HTTP tests for the Mistral knowledge tools:
 * mistral_ocr, mistral_embed, mistral_moderate, mistral_classify.
 *
 * All HTTP goes through the test seam (setMistralTestFetch) — no real network.
 * The fake key "test-key" is injected through the same seam's env fallback
 * (MISTRAL_API_KEY); no real secrets are used.
 *
 * ADR 0005 — OCR, embeddings, moderations/classifications as pi tools
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import {
	resetMistralTestOverrides,
	setMistralTestBaseUrl,
	setMistralTestFetch,
	type MistralFetchFn,
	type MistralRequestInit,
} from "../extensions/mistral/api.js";
import { setRetryTestSleep } from "../extensions/mistral/retry.js";
import { registerKnowledgeTools } from "../extensions/mistral/knowledge.js";

// Retries are on by default: a mocked 429/5xx would otherwise really
// sleep between attempts. A no-op sleep seam keeps this suite fast and
// deterministic (each test file runs in its own process, so a module-top
// seam is safe).
setRetryTestSleep(async () => {});

/** Captured HTTP requests, filled by the injected fake fetch. */
interface CapturedRequest {
	url: string;
	init: MistralRequestInit;
	body: Record<string, unknown>;
}

/** Fake fetch that responds with `responses` in order (or 200 `{}` forever). */
function fakeFetch(captured: CapturedRequest[], responses: Array<{ status: number; body: unknown }>): MistralFetchFn {
	let call = 0;
	return async (url, init) => {
		captured.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
		const preset = responses[call];
		call += 1;
		const status = preset?.status ?? 200;
		const body = preset !== undefined ? JSON.stringify(preset.body) : "{}";
		return new Response(body, { status, headers: { "Content-Type": "application/json" } });
	};
}

/** Fake fetch that ALWAYS answers `status`/`body` — a persistent failure the retry loop cannot outlast. */
function alwaysFailingFetch(captured: CapturedRequest[], status: number, body: unknown): MistralFetchFn {
	return async (url, init) => {
		captured.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	};
}

/** Fake pi ExtensionAPI capturing registered tools by name. */
function fakePi() {
	const tools = new Map<string, ToolDefinition<TSchema, unknown>>();
	const pi = {
		registerProvider: () => undefined,
		on: () => undefined,
		registerTool: (tool: ToolDefinition<TSchema, unknown>) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerKnowledgeTools(pi);
	return { pi, tools };
}

/** Minimal fake ExtensionToolContext: provider auth returns none, so env fallback applies. */
const fakeCtx = { modelRegistry: { getApiKeyForProvider: async () => undefined } } as const;

/** Execute a registered tool with the given params (and optional abort signal). */
async function runTool(
	tools: Map<string, ToolDefinition<TSchema, unknown>>,
	name: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ content: { type: string; text: string }[]; details: unknown; structuredContent?: unknown }> {
	const tool = tools.get(name);
	assert.ok(tool, `tool ${name} not registered`);
	// Cast through unknown: ToolDefinition's execute is typed to its params schema.
	const execute = tool.execute as unknown as (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details: unknown; structuredContent?: unknown }>;
	return execute("call-1", params, signal, undefined, fakeCtx);
}

function textOf(result: { content: { type: string; text: string }[] }): string {
	return result.content[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// Fixtures (shapes verified against vendor/mistral-openapi.yaml)
// ---------------------------------------------------------------------------

const ocrResponse = {
	pages: [
		{
			index: 0,
			markdown: "# Title\n\nHello world",
			images: [{ id: "img-0.jpeg", image_base64: "aGVsbG8=", top_left_x: 0, top_left_y: 0, bottom_right_x: 10, bottom_right_y: 10 }],
			dimensions: { dpi: 200, height: 2200, width: 1700 },
		},
		{ index: 1, markdown: "Page two", images: [], dimensions: {} },
	],
	model: "mistral-ocr-latest",
	usage_info: { pages_processed: 2, doc_size_bytes: null },
};

const embeddingResponse = {
	id: "emb-1",
	object: "list",
	model: "mistral-embed",
	data: [
		{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
		{ object: "embedding", embedding: [0.4, 0.5, 0.6], index: 1 },
	],
	usage: { prompt_tokens: 15, completion_tokens: 0, total_tokens: 15, prompt_audio_seconds: null },
};

const moderationResponse = {
	id: "mod-1",
	model: "mistral-moderation-latest",
	results: [
		{
			categories: { sexual: false, hate_and_discrimination: true, violence_and_threats: false },
			category_scores: { sexual: 0.001, hate_and_discrimination: 0.9, violence_and_threats: 0.002 },
		},
		{
			categories: { sexual: false, hate_and_discrimination: false, violence_and_threats: false },
			category_scores: { sexual: 0.001, hate_and_discrimination: 0.003, violence_and_threats: 0.002 },
		},
	],
};

const classificationResponse = {
	id: "cls-1",
	model: "ft-classifier-abc",
	results: [
		{ "support-billing": { scores: { billing: 0.8, support: 0.2 } } },
		{ "support-billing": { scores: { billing: 0.1, support: 0.9 } } },
	],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	setMistralTestBaseUrl("https://mistral.test/v1");
	// Dummy key through the same seam the real client uses (env fallback); never a real secret.
	process.env.MISTRAL_API_KEY = "test-key";
});

afterEach(() => {
	resetMistralTestOverrides();
	delete process.env.MISTRAL_API_KEY;
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registers the four knowledge tools with namespace and annotations", () => {
	const { tools } = fakePi();
	assert.deepEqual([...tools.keys()].sort(), [
		"mistral_classify",
		"mistral_embed",
		"mistral_moderate",
		"mistral_ocr",
	]);
	for (const tool of tools.values()) {
		assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false });
		assert.equal(tool.namespace?.name, "mistral-knowledge");
		assert.ok(tool.outputSchema, "outputSchema must be declared for structuredContent");
	}
});

// ---------------------------------------------------------------------------
// mistral_ocr
// ---------------------------------------------------------------------------

test("mistral_ocr: data-URL image becomes ImageURLChunk; response maps to markdown + structured pages", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: ocrResponse }]));
	const { tools } = fakePi();

	const result = await runTool(tools, "mistral_ocr", { image: "data:image/png;base64,iVBORw0" });

	const request = captured[0];
	assert.ok(request);
	assert.equal(request.url, "https://mistral.test/v1/ocr");
	assert.equal(request.init.method, "POST");
	assert.equal(request.init.headers.Authorization, "Bearer test-key");
	assert.deepEqual(request.body, {
		model: "mistral-ocr-latest",
		document: { type: "image_url", image_url: "data:image/png;base64,iVBORw0" },
	});

	assert.match(textOf(result), /--- Page 0 ---\n# Title/);
	assert.match(textOf(result), /--- Page 1 ---\nPage two/);
	const structured = result.structuredContent as {
		pages: { index: number; dimensions: object; imageCount: number }[];
		model: string;
	};
	assert.equal(structured.model, "mistral-ocr-latest");
	assert.equal(structured.pages.length, 2);
	assert.deepEqual(structured.pages[0]?.dimensions, { dpi: 200, height: 2200, width: 1700 });
	assert.equal(structured.pages[0]?.imageCount, 1);
});

test("mistral_ocr: local-path-shaped input fails fast with a remedy, before any HTTP", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, []));
	const { tools } = fakePi();

	const paths = ["/tmp/x.png", "/home/user/doc.pdf", "./scan.png", "../up/heic.tiff", "~/pics/a.jpg"];
	for (const path of paths) {
		await assert.rejects(
			runTool(tools, "mistral_ocr", { image: path }),
			(err: Error) =>
				/looks like a local file path/.test(err.message) &&
				/base64/.test(err.message) &&
				/http\(s\) URL/.test(err.message),
			`pre-check for ${path}`,
		);
	}
	assert.equal(captured.length, 0, "no request may leave the tool");
});

test("mistral_ocr: plain base64 is wrapped as a PNG data URL", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: ocrResponse }]));
	const { tools } = fakePi();

	await runTool(tools, "mistral_ocr", { image: "aGVsbG8=" });
	assert.deepEqual(captured[0]?.body.document, {
		type: "image_url",
		image_url: "data:image/png;base64,aGVsbG8=",
	});
});

test("mistral_ocr: http(s) document URL stays DocumentURLChunk; pages and include_image_base64 pass through", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: ocrResponse }]));
	const { tools } = fakePi();

	await runTool(tools, "mistral_ocr", {
		image: "https://example.com/doc.pdf",
		pages: "0-5",
		include_image_base64: true,
		model: "mistral-ocr-latest",
	});
	assert.deepEqual(captured[0]?.body, {
		model: "mistral-ocr-latest",
		document: { type: "document_url", document_url: "https://example.com/doc.pdf" },
		pages: "0-5",
		include_image_base64: true,
	});
});

test("mistral_ocr: remote image URLs (by extension, case-insensitive, query ignored) become ImageURLChunk", async () => {
	const cases: Array<[string, { type: string; image_url?: string; document_url?: string }]> = [
		["https://example.com/photo.png", { type: "image_url", image_url: "https://example.com/photo.png" }],
		["https://example.com/PHOTO.JPG?size=large#frag", { type: "image_url", image_url: "https://example.com/PHOTO.JPG?size=large#frag" }],
		["http://example.com/a/heic pic.tiff?x=1", { type: "image_url", image_url: "http://example.com/a/heic pic.tiff?x=1" }],
		["https://example.com/photo.png.exe", { type: "document_url", document_url: "https://example.com/photo.png.exe" }],
	];
	for (const [url, expected] of cases) {
		const captured: CapturedRequest[] = [];
		setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: ocrResponse }]));
		const { tools } = fakePi();
		await runTool(tools, "mistral_ocr", { image: url });
		assert.deepEqual(captured[0]?.body.document, expected, `routing for ${url}`);
	}
});

test("mistral_ocr: base64 payloads never reach the model-facing content, only structuredContent", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: ocrResponse }]));
	const { tools } = fakePi();

	const result = await runTool(tools, "mistral_ocr", {
		image: "data:image/png;base64,x",
		include_image_base64: true,
	});

	const text = textOf(result);
	assert.ok(!text.includes("aGVsbG8="), "content must not contain image base64");
	assert.match(text, /images\[\]\.image_base64/);
	const structured = result.structuredContent as {
		pages: { images: { id: string; image_base64?: string }[] }[];
	};
	assert.equal(structured.pages[0]?.images[0]?.image_base64, "aGVsbG8=");
});

// ---------------------------------------------------------------------------
// mistral_embed
// ---------------------------------------------------------------------------

test("mistral_embed: request shape, summary content, structured vectors", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: embeddingResponse }]));
	const { tools } = fakePi();

	const result = await runTool(tools, "mistral_embed", { input: ["Hello", "World"] });

	const request = captured[0];
	assert.ok(request);
	assert.equal(request.url, "https://mistral.test/v1/embeddings");
	assert.equal(request.init.headers.Authorization, "Bearer test-key");
	assert.deepEqual(request.body, { model: "mistral-embed", input: ["Hello", "World"] });

	assert.match(textOf(result), /Mistral embeddings \(mistral-embed\): 2 text\(s\), dimension 3, usage 15 tokens/);
	const structured = result.structuredContent as {
		model: string;
		usage: { total_tokens: number };
		embeddings: { index: number; dimension: number; vector: number[] }[];
	};
	assert.equal(structured.model, "mistral-embed");
	assert.equal(structured.usage.total_tokens, 15);
	assert.deepEqual(
		structured.embeddings.map((e) => [e.index, e.dimension, e.vector]),
		[
			[0, 3, [0.1, 0.2, 0.3]],
			[1, 3, [0.4, 0.5, 0.6]],
		],
	);
	// Content must not contain the full vectors.
	assert.ok(!textOf(result).includes("0.1, 0.2"), "content must not embed vectors");
	// Details stay small: previews only.
	const details = result.details as { vectors: { preview: number[] }[] };
	assert.equal(details.vectors[0]?.preview.length, 3);
});

test("mistral_embed: custom model is passed through", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: embeddingResponse }]));
	const { tools } = fakePi();
	await runTool(tools, "mistral_embed", { input: ["x"], model: "mistral-embed-v2" });
	assert.equal(captured[0]?.body.model, "mistral-embed-v2");
});

// ---------------------------------------------------------------------------
// mistral_moderate
// ---------------------------------------------------------------------------

test("mistral_moderate: string input normalized to array; flagged summary + structured scores", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: moderationResponse }]));
	const { tools } = fakePi();

	const result = await runTool(tools, "mistral_moderate", { input: "some text" });

	const request = captured[0];
	assert.ok(request);
	assert.equal(request.url, "https://mistral.test/v1/moderations");
	assert.equal(request.init.headers.Authorization, "Bearer test-key");
	assert.deepEqual(request.body, { model: "mistral-moderation-latest", input: ["some text"] });

	assert.match(textOf(result), /Input 0: flagged \(hate_and_discrimination\)/);
	assert.match(textOf(result), /Input 1: no categories flagged/);
	const structured = result.structuredContent as {
		model: string;
		results: { categories: Record<string, boolean>; category_scores: Record<string, number> }[];
	};
	assert.equal(structured.model, "mistral-moderation-latest");
	assert.equal(structured.results.length, 2);
	assert.equal(structured.results[0]?.categories.hate_and_discrimination, true);
	assert.equal(structured.results[0]?.category_scores.hate_and_discrimination, 0.9);
});

test("mistral_moderate: array input passes through as array", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: moderationResponse }]));
	const { tools } = fakePi();
	await runTool(tools, "mistral_moderate", { input: ["a", "b"] });
	assert.deepEqual(captured[0]?.body.input, ["a", "b"]);
});

// ---------------------------------------------------------------------------
// mistral_classify
// ---------------------------------------------------------------------------

test("mistral_classify: request shape, per-input summary, raw results in structuredContent", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: classificationResponse }]));
	const { tools } = fakePi();

	const result = await runTool(tools, "mistral_classify", {
		model: "ft-classifier-abc",
		input: "How do I pay my bill?",
	});

	const request = captured[0];
	assert.ok(request);
	assert.equal(request.url, "https://mistral.test/v1/classifications");
	assert.equal(request.init.headers.Authorization, "Bearer test-key");
	assert.deepEqual(request.body, {
		model: "ft-classifier-abc",
		input: ["How do I pay my bill?"],
	});

	assert.match(textOf(result), /Input 0: support-billing\/billing: 0\.8/);
	assert.match(textOf(result), /Input 1: support-billing\/support: 0\.9/);
	const structured = result.structuredContent as {
		id: string;
		model: string;
		results: Record<string, { scores: Record<string, number> }>[];
	};
	assert.equal(structured.id, "cls-1");
	assert.equal(structured.model, "ft-classifier-abc");
	assert.deepEqual(structured.results[0], { "support-billing": { scores: { billing: 0.8, support: 0.2 } } });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test("non-2xx: thrown error contains status and a capped excerpt of the body", async () => {
	const longBody = "x".repeat(2000);
	const captured: CapturedRequest[] = [];
	// The 429 is retryable, so the request must be retried until the budget
	// is exhausted; the assertion pins the finally surfaced error shape.
	setMistralTestFetch(alwaysFailingFetch(captured, 429, { message: `too many requests ${longBody}` }));
	const { tools } = fakePi();

	await assert.rejects(
		runTool(tools, "mistral_embed", { input: ["x"] }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /status 429/);
			assert.ok(error.message.includes("too many requests"), "excerpt of the body is included");
			assert.ok(error.message.length < 700, `excerpt is capped (got ${error.message.length})`);
			// Headers never appear in the error.
			assert.ok(!error.message.includes("Authorization"));
			assert.ok(!error.message.includes("test-key"), "key value must never be in the error");
			return true;
		},
	);
});

test("missing API key: clear error, no key value in the message", async () => {
	// Both fallbacks absent: provider auth returns nothing, env unset.
	delete process.env.MISTRAL_API_KEY;
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, []));
	const { tools } = fakePi();

	await assert.rejects(
		runTool(tools, "mistral_ocr", { image: "data:image/png;base64,x" }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /No Mistral API key/);
			assert.match(error.message, /MISTRAL_API_KEY/);
			assert.ok(!error.message.includes("test-key"));
			assert.equal(captured.length, 0, "no HTTP request must be made");
			return true;
		},
	);
});

test("success status but invalid JSON: descriptive error with the SyntaxError as cause", async () => {
	const captured: CapturedRequest[] = [];
	// A 200 response whose body is not JSON.
	setMistralTestFetch(async (url, init) => {
		captured.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
		return new Response("<html>gateway error page</html>", {
			status: 200,
			headers: { "Content-Type": "text/html" },
		});
	});
	const { tools } = fakePi();

	await assert.rejects(
		runTool(tools, "mistral_embed", { input: ["x"] }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /returned an invalid JSON response \(status 200\)/);
			assert.ok(error.message.includes("/embeddings"), "message names the path");
			assert.ok((error as Error & { cause?: unknown }).cause instanceof SyntaxError);
			assert.ok(!error.message.includes("test-key"), "key value must never be in the error");
			return true;
		},
	);
});

test("abort signal: the signal passed to execute is forwarded to the fetch init", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: embeddingResponse }]));
	const { tools } = fakePi();

	const controller = new AbortController();
	await runTool(tools, "mistral_embed", { input: ["x"] }, controller.signal);

	assert.equal(captured[0]?.init.signal, controller.signal, "execute's signal must reach the fetch init");
});

test("provider-level auth takes precedence over the environment fallback", async () => {
	const captured: CapturedRequest[] = [];
	setMistralTestFetch(fakeFetch(captured, [{ status: 200, body: ocrResponse }]));
	const { tools } = fakePi();
	// Override the fake context with provider auth returning a known dummy key.
	const ctx = { modelRegistry: { getApiKeyForProvider: async () => "provider-test-key" } };
	const tool = tools.get("mistral_ocr");
	assert.ok(tool);
	const execute = tool.execute as unknown as (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[] }>;
	await execute("call-1", { image: "data:image/png;base64,x" }, undefined, undefined, ctx);
	assert.equal(captured[0]?.init.headers.Authorization, "Bearer provider-test-key");
});
