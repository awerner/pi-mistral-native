/**
 * Tests for the native `mistral-chat` streamSimple implementation
 * (extensions/mistral.ts).
 *
 * Covers Mistral-style streaming scenarios (block assembly, string
 * regression, empty-thinking skip, tool-call regression, same-delta
 * thinking+text, signature), plus event-protocol, request-mapping, usage,
 * abort, overflow, and error-path coverage required by pi's custom-provider
 * contract (pi docs custom-provider.md, "Test the integration").
 *
 * ADR 0002 — Mistral-native provider for pi
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message, Model, ModelsStoreEntry, RefreshModelsContext, TranscriptContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import {
	API_ENFORCED_COMPLETION_CEILINGS,
	COMPLETION_CEILING_FALLBACK,
	DEFAULT_RATES,
	DOCUMENTED_OUTPUT_LIMITS,
	MISTRAL_API,
	MISTRAL_BASE_URL,
	MODELS,
	buildMistralNativeProvider,
	completionCeilingForModel,
	default as registerExtension,
	fallThroughModelIds,
	fetchMistralModels,
	lastFallThroughNotice,
	documentedMaxTokensForModel,
	mapModelList,
	ratesAndFallThroughForModel,
	refreshMistralModels,
	setMistralFetch,
	mistralStreamSimple,
	takeFallThroughNoticeForTests,
} from "../extensions/mistral.js";
import type { MistralModelConfig } from "../extensions/mistral.js";
import { setMistralConfigForTests } from "../extensions/mistral/config.js";

// Force the no-file baseline for this suite: each test file runs in its own
// node --test process, so this module-top override keeps the stream tests
// env-only deterministic regardless of the developer's real
// mistral-native.json.
setMistralConfigForTests(null);

// The suite's cost assertions pin the global rate card: an ambient
// MISTRAL_REGION (e.g. on a machine that exports one) would flip the
// region surcharge on every dynamic-catalog cost. Delete it for the whole
// process (the region-specific tests set it explicitly via withEnv).
delete process.env.MISTRAL_REGION;

/**
 * Snapshot + restore helper for process.env keys (per-test, unlike the
 * module-top config override). Async: env stays applied until the awaited
 * fn settles.
 */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
	const keys = Object.keys(env);
	const previous = keys.map((key) => process.env[key]);
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await fn();
	} finally {
		keys.forEach((key, i) => {
			const prior = previous[i];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		});
	}
}

// =============================================================================
// Harness
// =============================================================================

type RegisteredModel = (typeof MODELS)[number];

/** The model shape the runtime passes to streamSimple (registration-enriched). */
type RuntimeModel = RegisteredModel & { provider: string; baseUrl: string };

/**
 * Model as the runtime passes it to streamSimple: the registered model
 * (`ProviderConfig.models` entries) enriched with `provider` and `baseUrl`,
 * which pi's model runtime adds at registration time.
 */
function makeModel(overrides: Partial<RuntimeModel> = {}): RuntimeModel {
	return {
		...MODELS[0]!,
		provider: "mistral-native",
		baseUrl: MISTRAL_BASE_URL,
		...overrides,
	};
}

const CONTEXT: TranscriptContext = {
	messages: [
		{ role: "system", content: "You are a test harness.", timestamp: 1 },
		{ role: "user", content: "What is 2+2? Answer briefly.", timestamp: 2 },
	],
} as unknown as TranscriptContext;

type SseChunk = Record<string, unknown>;

function sseResponse(chunks: SseChunk[], options: { terminate?: boolean } = {}): Response {
	const body =
		chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
		(options.terminate === false ? "" : "data: [DONE]\n\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): SseChunk => ({
	id: "repro-1",
	object: "chat.completion.chunk",
	created: 1793048657,
	model: "mistral-large-4",
	choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
	...extra,
});

const finalChunk = (finishReason: string | null, extra: Record<string, unknown> = {}): SseChunk => ({
	id: "repro-1",
	object: "chat.completion.chunk",
	created: 1793048657,
	model: "mistral-large-4",
	choices: [{ index: 0, delta: {}, finish_reason: finishReason, logprobs: null }],
	...extra,
});

const thinkingBlock = (text: string, closed = true): Record<string, unknown> => ({
	type: "thinking",
	thinking: [{ type: "text", text }],
	...(closed ? { closed: true } : {}),
});
const textBlock = (text: string): Record<string, unknown> => ({ type: "text", text });

interface StreamOutcome {
	events: { type: string; [key: string]: unknown }[];
	message: Record<string, unknown> & { content: { type: string; [key: string]: unknown }[] };
}

async function runStream(
	chunks: SseChunk[],
	options: {
		model?: RuntimeModel;
		messages?: Message[];
		streamOptions?: Record<string, unknown>;
		response?: Response;
	} = {},
): Promise<StreamOutcome> {
	const events: { type: string; [key: string]: unknown }[] = [];
	const model = options.model ?? makeModel();
	const context = options.messages
		? ({ messages: options.messages } as unknown as TranscriptContext)
		: CONTEXT;
	const fetchImpl =
		options.response === undefined
			? () => Promise.resolve(sseResponse(chunks))
			: () => Promise.resolve(options.response!);
	const stream = mistralStreamSimple(
		model as never,
		context,
		{ apiKey: "test-key", fetch: fetchImpl, maxRetries: 0, ...options.streamOptions } as never,
	);
	for await (const event of stream) events.push(event as never);
	const last = events[events.length - 1];
	assert.ok(last && (last.type === "done" || last.type === "error"), `stream ended with ${last?.type}`);
	return {
		events,
		message: ((last.type === "done" ? last.message : last.error) as StreamOutcome["message"])!,
	};
}

/** Narrow a refresh result to chat configs: the mistral-native catalog only contains chat models. */
function asChatConfigs(models: ProviderModelConfig[]): MistralModelConfig[] {
	return models as MistralModelConfig[];
}

test("MODELS registers mistral-large-4 against the Mistral chat-completions endpoint", () => {
	assert.equal(MISTRAL_BASE_URL, "https://api.mistral.ai/v1");

	const model = MODELS.find((m) => m.id === "mistral-large-4");
	assert.ok(model, "mistral-large-4 missing from catalog");
	assert.equal(model.api, MISTRAL_API);
	assert.equal(model.api, "mistral-chat");
	assert.equal(model.reasoning, true);
	// Facts mirror the official model card: 1M-token context,
	// $0.70/$2.10/$0.07 per million (the verified rate card,
	// https://docs.mistral.ai/models/mistral-large-4-0). The API enforces a
	// 262144 completion-token ceiling (wire-verified, 400 code 3058), so
	// maxTokens follows the same mapping as the live catalog: the wire
	// ceiling capped at the context window.
	assert.deepEqual(model.cost, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });
	assert.equal(model.contextWindow, 1048576);
	assert.equal(model.maxTokens, 262144);
});

test("compat flags record Mistral's wire differences", () => {
	const model = MODELS[0]!;
	assert.deepEqual(model.compat, {
		supportsDeveloperRole: false,
		supportsStore: false,
		supportsMidConvoSystemMessages: false,
	});
});

test("thinkingLevelMap maps pi levels to Mistral reasoning_effort values", () => {
	const map = MODELS[0]!.thinkingLevelMap;
	assert.ok(map);
	assert.equal(map.off, "none");
	assert.equal(map.high, "high");
	assert.equal(map.minimal, null);
	assert.equal(map.max, null);
});

// =============================================================================
// Repro scenarios
// =============================================================================

test("block-array thinking+text deltas assemble correctly (the bug scenario)", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [thinkingBlock("The user asks 2+2. ")] }),
		chunk({ content: [thinkingBlock("The answer is 4.")] }),
		chunk({ content: [textBlock("4")] }),
		finalChunk("stop"),
	]);
	const types = message.content.map((b) => b.type);
	assert.deepEqual(types, ["thinking", "text"]);
	assert.equal(message.content[0]!.thinking, "The user asks 2+2. The answer is 4.");
	assert.equal(message.content[1]!.text, "4");
	assert.ok(!JSON.stringify(message.content).includes("[object Object]"), "[object Object] leaked into blocks");
});

test("plain-string content still parses (regression)", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: "2+" }),
		chunk({ content: "2 is 4" }),
		finalChunk("stop"),
	]);
	assert.equal(message.content.length, 1);
	assert.equal(message.content[0]!.type, "text");
	assert.equal(message.content[0]!.text, "2+2 is 4");
});

test("empty thinking parts create no stray blocks", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [thinkingBlock("")] }),
		chunk({ content: [textBlock("4")] }),
		finalChunk("stop"),
	]);
	const types = message.content.map((b) => b.type);
	assert.deepEqual(types, ["text"]);
});

test("tool calls still parse alongside string content (regression)", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: null }),
		chunk({
			content: "",
			tool_calls: [
				{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } },
			],
		}),
		chunk({
			content: "",
			tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
		}),
		finalChunk("tool_calls"),
	]);
	const toolCall = message.content.find((b) => b.type === "toolCall");
	assert.ok(toolCall, "no toolCall block");
	assert.equal(toolCall.name, "get_weather");
	assert.deepEqual(toolCall.arguments, { city: "Paris" });
	assert.equal(message.stopReason, "toolUse");
});

test("thinking and text blocks in one delta", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [thinkingBlock("Compute first."), textBlock("4")] }),
		finalChunk("stop"),
	]);
	const types = message.content.map((b) => b.type);
	assert.deepEqual(types, ["thinking", "text"]);
	assert.equal(message.content[0]!.thinking, "Compute first.");
	assert.equal(message.content[1]!.text, "4");
});

test("thinking block carries a signature", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [thinkingBlock("Think.")] }),
		finalChunk("stop"),
	]);
	const thinking = message.content.find((b) => b.type === "thinking");
	assert.ok(thinking, "no thinking block");
	assert.equal(typeof thinking.thinkingSignature, "string");
	assert.ok((thinking.thinkingSignature as string).length > 0);
});

test("provider thinking signature from ThinkChunk lands on the block", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({
			content: [
				{
					type: "thinking",
					thinking: [{ type: "text", text: "Signed reasoning." }],
					signature: "sig-abc123",
				},
			],
		}),
		finalChunk("stop"),
	]);
	const thinking = message.content.find((b) => b.type === "thinking");
	assert.ok(thinking);
	assert.equal(thinking.thinkingSignature, "sig-abc123");
});

// =============================================================================
// Content chunk coverage (map or reject, never drop)
// =============================================================================

/*
 * Mistral's delta chunk vocabulary is wider than pi's block model: known
 * chunk types map (references append citation markers; an empty
 * reference_ids array is a legitimate no-op), unknown or malformed ones
 * fail loudly — content is never dropped silently.
 *
 * ADR 0014 — Content chunk coverage: map or reject, never drop
 */

const referenceChunk = (referenceIds: (number | string)[]): Record<string, unknown> => ({
	type: "reference",
	reference_ids: referenceIds,
});

test("reference chunks append citation markers to the assistant text", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [textBlock("Mistral released Large 4 "), referenceChunk([0])] }),
		chunk({ content: [textBlock("and "), referenceChunk([0, 1]), textBlock(" covered it.")] }),
		finalChunk("stop"),
	]);
	const text = message.content.find((b) => b.type === "text");
	assert.ok(text, "no text block");
	assert.equal(
		text.text,
		"Mistral released Large 4 [0]and [0, 1] covered it.",
	);
});

test("nested reference inside a thinking chunk becomes a marker in the thinking text", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({
			content: [
				{
					type: "thinking",
					thinking: [{ type: "text", text: "Check " }, referenceChunk([1]), { type: "text", text: " for details." }],
					closed: true,
				},
			],
		}),
		chunk({ content: [textBlock("Done.")] }),
		finalChunk("stop"),
	]);
	const thinking = message.content.find((b) => b.type === "thinking");
	assert.ok(thinking, "no thinking block");
	assert.equal(thinking.thinking, "Check [1] for details.");
	assert.equal(message.content.find((b) => b.type === "text")!.text, "Done.");
});

test("a nested thinking part without a type field maps as text (spec-legal default)", async () => {
	// TextChunk's `type` is optional with default "text"
	// (vendor/mistral-openapi.yaml) — a bare {text: …} nested part is legal
	// wire, not a rejection case.
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({
			content: [
				{
					type: "thinking",
					thinking: [{ text: "Untyped part." }, { type: "text", text: " Typed part." }],
					closed: true,
				},
			],
		}),
		finalChunk("stop"),
	]);
	const thinking = message.content.find((b) => b.type === "thinking");
	assert.ok(thinking, "no thinking block");
	assert.equal(thinking.thinking, "Untyped part. Typed part.");
});

test("a reference chunk with a non-array reference_ids is rejected loudly", async () => {
	// Malformed wire shape (e.g. a gateway quirk): presence-but-non-array
	// must not silently no-op into an empty marker.
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [{ type: "reference", reference_ids: 0 }] }),
		finalChunk("stop"),
	]);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /"reference"/);
	assert.match(message.errorMessage as string, /reference_ids must be an array/);
});

test("a nested reference part with a non-array reference_ids is rejected loudly", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({
			content: [
				{
					type: "thinking",
					thinking: [{ type: "reference", reference_ids: "0" }],
					closed: true,
				},
			],
		}),
		finalChunk("stop"),
	]);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /"reference"/);
	assert.match(message.errorMessage as string, /reference_ids must be an array/);
});

test("a reference chunk with an empty reference_ids array is a no-op, not an error", async () => {
	// An empty array is a legitimate empty carrier.
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [textBlock("Only text."), referenceChunk([])] }),
		finalChunk("stop"),
	]);
	assert.equal(message.stopReason, "stop");
	assert.equal(message.content.find((b) => b.type === "text")!.text, "Only text.");
});

test("nested tool_reference inside a thinking chunk is rejected loudly", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({
			content: [
				{
					type: "thinking",
					thinking: [{ type: "tool_reference", tool_name: "web_search", tool_call_id: 0 }],
					closed: true,
				},
			],
		}),
		finalChunk("stop"),
	]);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /tool_reference/);
});

// One rejection test per loudly-rejected delta chunk type.
const REJECTED_DELTA_CHUNKS: { name: string; chunk: Record<string, unknown>; match: RegExp }[] = [
	{
		name: "resource",
		chunk: { type: "resource", uri: "file:///doc.txt", content: { type: "text", text: "secret" } },
		match: /"resource"/,
	},
	{ name: "resource_link", chunk: { type: "resource_link", uri: "https://example.com/res" }, match: /"resource_link"/ },
	{
		name: "input_audio",
		chunk: { type: "input_audio", input_audio: "<base64 audio payload>" },
		match: /"input_audio"/,
	},
	{
		name: "image_url",
		chunk: { type: "image_url", image_url: { url: "data:image/png;base64,aXBtZy1ieXRlcw==" } },
		match: /"image_url"/,
	},
	{
		name: "document_url",
		chunk: { type: "document_url", document_url: "https://example.com/doc.pdf", document_name: "doc.pdf" },
		match: /"document_url"/,
	},
	{
		name: "file",
		chunk: { type: "file", file_id: "0b2b1e2e-3b4f-4a3d-8a4c-000000000000" },
		match: /"file"/,
	},
	{ name: "unknown", chunk: { type: "hologram", data: "…" }, match: /"hologram"/ },
	{ name: "missing type", chunk: { data: "…" }, match: /<missing type>/ },
];

for (const { name, chunk: bad, match } of REJECTED_DELTA_CHUNKS) {
	test(`delta chunk type "${name}" terminates with a clear error event`, async () => {
		const { events, message } = await runStream([
			chunk({ role: "assistant", content: "" }),
			chunk({ content: [textBlock("Before the bad chunk."), bad] }),
			finalChunk("stop"),
		]);
		// Exactly one terminal event: the error event, not done.
		const terminals = events.filter((e) => e.type === "done" || e.type === "error");
		assert.equal(terminals.length, 1);
		assert.equal(terminals[0]!.type, "error");
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage as string, match);
		assert.match(message.errorMessage as string, /pi cannot represent it/);
		// The chunk payload (data URL / base64 body) must not leak into the error.
		const errorText = JSON.stringify(message.errorMessage);
		assert.ok(!errorText.includes("aXBtZy1ieXRlcw=="), "payload leaked into error message");
	});
}

test("input_audio rejection names pi as the blocker (blocked-on-pi)", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [{ type: "input_audio", input_audio: "<base64>" }] }),
		finalChunk("stop"),
	]);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /blocked on pi/);
});

test("a request with an unknown pi user block type fails with a clear error", async () => {
	// pi 1.4.0 cannot produce this block; the cast simulates a future pi
	// block type so the boundary stays fail-loud.
	const messages = [
		{ role: "user", content: [{ type: "hologram" as never, data: "…" }], timestamp: 2 },
	] as never as Message[];
	const { message } = await runStream([chunk({ role: "assistant", content: "" }), finalChunk("stop")], {
		messages,
	});
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /"hologram"/);
	assert.match(message.errorMessage as string, /user content/);
});

test("a request with an unknown pi block in a tool result fails with a clear error", async () => {
	// Cast-simulated future pi block type inside a toolResult.
	const messages = [
		{ role: "user", content: "Run the tool.", timestamp: 2 },
		{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "get_weather",
				content: [{ type: "hologram" as never, data: "…" }],
				isError: false,
				timestamp: 3,
			},
	] as never as Message[];
	const { message } = await runStream([chunk({ role: "assistant", content: "" }), finalChunk("stop")], {
		messages,
	});
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /"hologram"/);
	assert.match(message.errorMessage as string, /tool result content/);
});

test("a request with an unknown pi block in an assistant turn fails with a clear error", async () => {
	// Cast-simulated future pi block type inside an assistant message;
	// thinking blocks stay a documented skip and must not throw.
	const messages = [
		{ role: "user", content: "Hi", timestamp: 2 },
		{
				role: "assistant",
				content: [{ type: "thinking" as never, thinking: "Keep this off the wire.", thinkingSignature: "sig" }, { type: "hologram" as never, data: "…" }],
				api: "mistral-chat",
				provider: "mistral-native",
				model: "mistral-large-4",
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 3,
			},
	] as never as Message[];
	const { message } = await runStream([chunk({ role: "assistant", content: "" }), finalChunk("stop")], {
		messages,
	});
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /"hologram"/);
	assert.match(message.errorMessage as string, /assistant content/);
});

// =============================================================================
// Event protocol (custom-provider contract)
// =============================================================================

test("emits start, balanced block events with updated partials, and exactly one terminal event", async () => {
	const { events } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [thinkingBlock("Think.")] }),
		chunk({ content: [textBlock("Hi"), textBlock(" there")] }),
		finalChunk("stop"),
	]);
	const types = events.map((e) => e.type);
	assert.equal(types[0], "start");
	const terminals = types.filter((t) => t === "done" || t === "error");
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0], "done");
	// Block *_end events are emitted at finalization, in block order,
	// like pi-ai's OpenAI-completions adapter.
	assert.deepEqual(types, [
		"start",
		"thinking_start",
		"thinking_delta",
		"text_start",
		"text_delta",
		"text_delta",
		"thinking_end",
		"text_end",
		"done",
	]);
	// Blocks are updated before their events are emitted; both text parts
	// arrive in one SSE chunk (pushed back-to-back before the consumer
	// resumes), so the shared partial already reads "Hi there" at either
	// delta — the same semantics as pi-ai's OpenAI-completions adapter.
	const deltas = events.filter((e) => e.type === "text_delta");
	assert.deepEqual(
		deltas.map((d) => d.delta),
		["Hi", " there"],
	);
	assert.equal(
		(deltas[deltas.length - 1]!.partial as { content: { text: string }[] }).content[1]!.text,
		"Hi there",
	);
	const end = events.find((e) => e.type === "text_end")!;
	assert.equal(end.content, "Hi there");
});

test("tool-call events are balanced and arguments parse by toolcall_end", async () => {
	const { events, message } = await runStream([
		chunk({ role: "assistant", content: null }),
		chunk({
			content: null,
			tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } }],
		}),
		chunk({ content: null, tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
		finalChunk("tool_calls"),
	]);
	const types = events.map((e) => e.type);
	assert.deepEqual(types.filter((t) => t.startsWith("toolcall")), [
		"toolcall_start",
		"toolcall_delta",
		"toolcall_delta",
		"toolcall_end",
	]);
	const end = events.find((e) => e.type === "toolcall_end")!;
	const toolCall = end.toolCall as { name: string; arguments: Record<string, string> };
	assert.equal(toolCall.name, "get_weather");
	assert.deepEqual(toolCall.arguments, { city: "Paris" });
	// No streaming scratch fields survive into the final message.
	assert.ok(!("partialArgs" in (message.content[0] as object)));
	assert.ok(!("streamIndex" in (message.content[0] as object)));
});

test("parallel tool calls with split deltas assemble by stream index", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: null }),
		chunk({
			content: null,
			tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"P' } }],
		}),
		chunk({
			content: null,
			tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }],
		}),
		chunk({
			content: null,
			tool_calls: [{ index: 0, function: { arguments: 'aris"}' } }],
		}),
		finalChunk("tool_calls"),
	]);
	const toolCalls = message.content.filter((b) => b.type === "toolCall");
	assert.equal(toolCalls.length, 2);
	assert.deepEqual(toolCalls[0]!.arguments, { city: "Paris" });
	assert.deepEqual(toolCalls[1]!.arguments, { tz: "UTC" });
});

// =============================================================================
// Usage and cost
// =============================================================================

test("usage with cached tokens maps to pi usage and cost", async () => {
	const model = makeModel();
	const { message } = await runStream(
		[
			chunk({ role: "assistant", content: "" }),
			chunk({ content: "hi" }),
			finalChunk("stop", {
				usage: {
					prompt_tokens: 1100,
					completion_tokens: 50,
					total_tokens: 1150,
					prompt_tokens_details: { cached_tokens: 100 },
					completion_tokens_details: { reasoning_tokens: 30 },
				},
			}),
		],
		{ model },
	);
	const usage = message.usage as Record<string, number>;
	assert.equal(usage.input, 1000); // prompt minus cache read
	assert.equal(usage.output, 50);
	assert.equal(usage.cacheRead, 100);
	assert.equal(usage.reasoning, 30);
	assert.equal(usage.totalTokens, 1150);
	// Cost per the rate card: (1000*0.70 + 50*2.10 + 100*0.07) / 1e6
	const expected = (1000 * 0.7 + 50 * 2.1 + 100 * 0.07) / 1_000_000;
	const cost = usage.cost as unknown as { total: number };
	assert.ok(Math.abs(cost.total - expected) < 1e-9, `cost.total=${cost.total} expected=${expected}`);
});

// =============================================================================
// Abort
// =============================================================================

test("abort converts to an aborted result", async () => {
	const controller = new AbortController();
	const events: { type: string; [key: string]: unknown }[] = [];
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "par" }))}\n\n`));
			// Never completes; the consumer aborts.
			controller.signal.addEventListener("abort", () => c.close(), { once: true });
		},
	});
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		signal: controller.signal,
		fetch: () =>
			Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })),
		maxRetries: 0,
	} as never);
	const consuming = (async () => {
		for await (const event of stream) events.push(event as never);
	})();
	// Give the stream a tick to consume the first chunk, then abort.
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	await consuming;

	const last = events[events.length - 1]!;
	assert.equal(last.type, "error");
	assert.equal(last.reason, "aborted");
	const error = last.error as { stopReason: string; errorMessage?: string };
	assert.equal(error.stopReason, "aborted");
	assert.ok(error.errorMessage, "aborted message needs an errorMessage");
	// Exactly one terminal event.
	assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
});

// =============================================================================
// Error paths
// =============================================================================

test("non-2xx response terminates with a single error event before start", async () => {
	const events: { type: string; [key: string]: unknown }[] = [];
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		fetch: () =>
			Promise.resolve(
				new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
			),
		maxRetries: 0,
	} as never);
	for await (const event of stream) events.push(event as never);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type, "error");
	const error = events[0]!.error as { stopReason: string; errorMessage: string };
	assert.equal(error.stopReason, "error");
	assert.match(error.errorMessage, /401/);
});

test("context overflow error message is normalized with the context_length_exceeded marker", async () => {
	const overflowBody = JSON.stringify({
		message: "Prompt contains 500000 tokens which is too large for model with 409600 maximum context length",
	});
	const { message } = await runStream([], {
		response: new Response(overflowBody, { status: 400 }),
	});
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /too large for model/);
	assert.match(message.errorMessage as string, /context_length_exceeded/);
});

test("rate-limit errors are not normalized to overflow", async () => {
	const { message } = await runStream([], {
		response: new Response(JSON.stringify({ message: "Requests rate limit exceeded" }), {
			status: 429,
		}),
	});
	assert.equal(message.stopReason, "error");
	assert.ok(!((message.errorMessage as string) ?? "").includes("context_length_exceeded"));
});

test("malformed SSE data terminates with an error event", async () => {
	const { message } = await runStream([], {
		response: new Response("data: {broken json\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	});
	assert.equal(message.stopReason, "error");
});

test("stream ending without finish_reason terminates with an error", async () => {
	const { message } = await runStream([chunk({ content: "partial" })], {
		streamOptions: {},
	});
	// finalChunk omitted: no finish_reason, no terminal [DONE]-driven done.
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /finish_reason/);
});

test("missing API key fails the stream with an error before start", async () => {
	const events: { type: string; [key: string]: unknown }[] = [];
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		fetch: () => {
			throw new Error("fetch must not be called without a key");
		},
	} as never);
	for await (const event of stream) events.push(event as never);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type, "error");
	assert.match((events[0]!.error as { errorMessage: string }).errorMessage, /No API key/);
});

// =============================================================================
// Request mapping
// =============================================================================

test("request maps model, messages, stream options, max_tokens, temperature, tools, tool_choice", async () => {
	let captured: Record<string, unknown> | undefined;
	const tool = {
		name: "get_weather",
		description: "Get the weather",
		parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
	};
	const messages: Message[] = [
		{
			role: "system",
			content: "You are a test harness.",
			toolsAdded: [tool as never],
			timestamp: 1,
		},
		{ role: "user", content: "Weather in Paris?", timestamp: 2 },
	];
	const stream = mistralStreamSimple(makeModel() as never, { messages } as never, {
		apiKey: "test-key",
		temperature: 0.2,
		maxTokens: 1024,
		toolChoice: "auto",
		fetch: async (_url: unknown, init?: RequestInit) => {
			captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
			return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]);
		},
		maxRetries: 0,
	} as never);
	for await (const _event of stream) {
		// drain
	}
	assert.ok(captured);
	assert.equal(captured!.model, "mistral-large-4");
	assert.equal(captured!.stream, true);
	assert.deepEqual(captured!.stream_options, { include_usage: true });
	assert.equal(captured!.max_tokens, 1024);
	assert.equal(captured!.temperature, 0.2);
	assert.equal(captured!.tool_choice, "auto");
	const wireMessages = captured!.messages as { role: string; content: unknown }[];
	assert.deepEqual(wireMessages.map((m) => m.role), ["system", "user"]);
	assert.equal(wireMessages[0]!.content, "You are a test harness.");
	assert.equal(wireMessages[1]!.content, "Weather in Paris?");
	const tools = captured!.tools as { type: string; function: { name: string } }[];
	assert.equal(tools.length, 1);
	assert.equal(tools[0]!.type, "function");
	assert.equal(tools[0]!.function.name, "get_weather");
});

test("reasoning_effort maps from pi thinking levels through thinkingLevelMap", async () => {
	// "low" is unsupported by mistral-large-4 (thinkingLevelMap.low === null);
	// pi clamps it to the nearest supported level, which maps to "high".
	const cases: { level: "off" | "high" | "low"; expected: string | undefined }[] = [
		{ level: "off", expected: "none" },
		{ level: "high", expected: "high" },
		{ level: "low", expected: "high" },
	];
	for (const { level, expected } of cases) {
		let captured: Record<string, unknown> | undefined;
		const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
			apiKey: "test-key",
			reasoning: level,
			fetch: async (_url: unknown, init?: RequestInit) => {
				captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
				return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]);
			},
			maxRetries: 0,
		} as never);
		for await (const _event of stream) {
			// drain
		}
		assert.equal(captured!.reasoning_effort, expected, `level=${level}`);
	}
});

test("request without explicit maxTokens clamps to the wire-enforced completion ceiling", async () => {
	// mistral-large-4 has a wire-enforced completion ceiling of 262144 (400
	// code 3058 above it); without options.maxTokens the request path must
	// derive max_tokens from that ceiling, not the 1M context window. The
	// prompt does not count against the completion ceiling (the API accepts
	// max_tokens 262144), so the clamp is exactly the ceiling here.
	let captured: Record<string, unknown> | undefined;
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		fetch: async (_url: unknown, init?: RequestInit) => {
			captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
			return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]);
		},
		maxRetries: 0,
	} as never);
	for await (const _event of stream) {
		// drain
	}
	assert.ok(captured);
	assert.equal(captured!.max_tokens, 262144);
	assert.ok((captured!.max_tokens as number) <= 262144, "max_tokens exceeds the completion ceiling");
});

test("request path rescues a stale snapshot with an oversized maxTokens catalog value", async () => {
	// A v0.1.0 persisted snapshot carried maxTokens 1048576 (the context
	// window); the request-path clamp must still cap max_tokens at the
	// wire-enforced ceiling so the request cannot hit 400 code 3058.
	let captured: Record<string, unknown> | undefined;
	const stream = mistralStreamSimple(
		makeModel({ maxTokens: 1048576 }) as never,
		CONTEXT,
		{
			apiKey: "test-key",
			fetch: async (_url: unknown, init?: RequestInit) => {
				captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
				return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]);
			},
			maxRetries: 0,
		} as never,
	);
	for await (const _event of stream) {
		// drain
	}
	assert.ok(captured);
	assert.ok((captured!.max_tokens as number) <= 262144, "max_tokens exceeds the completion ceiling");
	assert.equal(captured!.max_tokens, 262144);
});

test("request path keeps the context clamp under prompt pressure below the ceiling", async () => {
	// With ~800k estimated transcript tokens the remaining context is far
	// below the ceiling: the context clamp (not the ceiling) must bound
	// max_tokens, but never below MIN_MAX_TOKENS.
	let captured: Record<string, unknown> | undefined;
	const messages: Message[] = [
		{ role: "system", content: "You are a test harness.", timestamp: 1 },
		{ role: "user", content: "x".repeat(2800000), timestamp: 2 },
	];
	const stream = mistralStreamSimple(makeModel() as never, { messages } as never, {
		apiKey: "test-key",
		fetch: async (_url: unknown, init?: RequestInit) => {
			captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
			return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]);
		},
		maxRetries: 0,
	} as never);
	for await (const _event of stream) {
		// drain
	}
	assert.ok(captured);
	const maxTokens = captured!.max_tokens as number;
	// Estimated transcript: 7 + ceil(2800000/3.5) = 800007 tokens, so the
	// context clamp yields 1048576 - 800007 - 4096 = 244473 — the context
	// (not the ceiling) is the binding constraint.
	assert.equal(maxTokens, 244473);
	assert.ok(maxTokens > 1, "max_tokens fell to MIN_MAX_TOKENS");
	assert.ok(maxTokens <= 262144, "max_tokens exceeds the completion ceiling");
});

test("tool results and assistant tool calls replay in the request", async () => {
	let captured: Record<string, unknown> | undefined;
	const messages: Message[] = [
		{ role: "system", content: "You are a test harness.", timestamp: 1 },
		{ role: "user", content: "Weather in Paris?", timestamp: 2 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Paris" } }],
			api: "mistral-chat",
			provider: "mistral-native",
			model: "mistral-large-4",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "get_weather",
			content: [{ type: "text", text: "18C, sunny" }],
			isError: false,
			timestamp: 4,
		},
	];
	const stream = mistralStreamSimple(makeModel() as never, { messages } as never, {
		apiKey: "test-key",
		fetch: async (_url: unknown, init?: RequestInit) => {
			captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
			return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]);
		},
		maxRetries: 0,
	} as never);
	for await (const _event of stream) {
		// drain
	}
	const wireMessages = captured!.messages as Record<string, unknown>[];
	assert.deepEqual(
		wireMessages.map((m) => m.role),
		["system", "user", "assistant", "tool"],
	);
	const assistant = wireMessages[2]!;
	const toolCalls = assistant.tool_calls as { id: string; function: { name: string; arguments: string } }[];
	assert.equal(toolCalls.length, 1);
	assert.equal(toolCalls[0]!.id, "call_1");
	assert.equal(toolCalls[0]!.function.name, "get_weather");
	assert.deepEqual(JSON.parse(toolCalls[0]!.function.arguments), { city: "Paris" });
	assert.equal(wireMessages[3]!.tool_call_id, "call_1");
});

test("onPayload, onResponse, and onProviderStreamEvent hooks are honored", async () => {
	const seen: string[] = [];
	const onPayloadCalls: unknown[] = [];
	const streamEvents: unknown[] = [];
	const replacementBody = {
		model: "mistral-large-4",
		messages: [{ role: "user", content: "replaced" }],
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: 64,
	};
	let requestCount = 0;
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		fetch: async (_url: unknown, init?: RequestInit) => {
			requestCount++;
			const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
			assert.deepEqual(body.messages, replacementBody.messages, "onPayload replacement not used");
			seen.push(`fetch:${requestCount}`);
			return sseResponse([chunk({ role: "assistant", content: "ok" }), finalChunk("stop")]);
		},
		maxRetries: 0,
		onPayload: (payload: unknown) => {
			onPayloadCalls.push(payload);
			return replacementBody;
		},
		onResponse: (response: { status: number }) => {
			seen.push(`onResponse:${response.status}`);
		},
		onProviderStreamEvent: (data: unknown) => {
			streamEvents.push(data);
		},
	} as never);
	for await (const _event of stream) {
		// drain
	}
	assert.equal(onPayloadCalls.length, 1);
	assert.ok(seen.includes("onResponse:200"));
	assert.equal(streamEvents.length, 2, "one event per parsed SSE data line");
	assert.equal((streamEvents[0] as { choices?: unknown[] }).choices?.length, 1);
});

test("mid-conversation system messages are collapsed into the leading prompt", async () => {
	let captured: Record<string, unknown> | undefined;
	const messages: Message[] = [
		{ role: "system", content: "Base prompt.", timestamp: 1 },
		{ role: "user", content: "Hi", timestamp: 2 },
		{ role: "system", content: "Additional instruction.", timestamp: 3 },
		{ role: "user", content: "Again", timestamp: 4 },
	];
	const stream = mistralStreamSimple(makeModel() as never, { messages } as never, {
		apiKey: "test-key",
		fetch: async (_url: unknown, init?: RequestInit) => {
			captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
			return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]);
		},
		maxRetries: 0,
	} as never);
	for await (const _event of stream) {
		// drain
	}
	const wireMessages = captured!.messages as { role: string; content: string }[];
	assert.deepEqual(
		wireMessages.map((m) => m.role),
		["system", "user", "user"],
	);
	assert.match(wireMessages[0]!.content, /Base prompt\./);
	assert.match(wireMessages[0]!.content, /Additional instruction\./);
});

test("empty response content produces an empty message with stop reason", async () => {
	const { message, events } = await runStream([
		chunk({ role: "assistant", content: null }),
		finalChunk("stop"),
	]);
	assert.deepEqual(message.content, []);
	assert.equal(message.stopReason, "stop");
	assert.equal(events[events.length - 1]!.type, "done");
});

test("finish_reason length maps to stopReason length", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "trunc" }),
		finalChunk("length"),
	]);
	assert.equal(message.stopReason, "length");
});

test("finish_reason content_filter maps to an error terminal", async () => {
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		finalChunk("content_filter"),
	]);
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage as string, /content_filter/);
});

test("empty assistant turns are skipped in replay", async () => {
	let captured: Record<string, unknown> | undefined;
	const messages: Message[] = [
		{ role: "system", content: "You are a test harness.", timestamp: 1 },
		{
			role: "assistant",
			content: [],
			api: "mistral-chat",
			provider: "mistral-native",
			model: "mistral-large-4",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: 2,
		},
		{ role: "user", content: "Try again", timestamp: 3 },
	];
	const stream = mistralStreamSimple(makeModel() as never, { messages } as never, {
		apiKey: "test-key",
		fetch: async (_url: unknown, init?: RequestInit) => {
			captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
			return sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]);
		},
		maxRetries: 0,
	} as never);
	for await (const _event of stream) {
		// drain
	}
	const wireMessages = captured!.messages as { role: string }[];
	assert.deepEqual(
		wireMessages.map((m) => m.role),
		["system", "user"],
	);
});

// =============================================================================
// Robustness edge cases (abort, retry, mid-stream truncation)
// =============================================================================

test("abort during a split tool-call stream strips scratch fields from the error message", async () => {
	const controller = new AbortController();
	const events: { type: string; [key: string]: unknown }[] = [];
	const chunkWithArgs = (args: string) =>
		chunk({
			content: null,
			tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: args } }],
		});
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			const encode = (data: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
			c.enqueue(encode(chunkWithArgs('{"city":')));
			// Second delta never arrives; the consumer aborts mid-call.
			controller.signal.addEventListener("abort", () => c.close(), { once: true });
		},
	});
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		signal: controller.signal,
		fetch: () =>
			Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })),
		maxRetries: 0,
	} as never);
	const consuming = (async () => {
		for await (const event of stream) events.push(event as never);
	})();
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	await consuming;

	const last = events[events.length - 1]!;
	assert.equal(last.type, "error");
	assert.equal(last.reason, "aborted");
	const error = last.error as { content: Record<string, unknown>[] };
	const toolCall = error.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall, "aborted toolCall block survives");
	assert.ok(!("partialArgs" in toolCall), "partialArgs leaked into the aborted message");
	assert.ok(!("streamIndex" in toolCall), "streamIndex leaked into the aborted message");
});

test("abort terminates the stream even when the transport does not close it", async () => {
	const controller = new AbortController();
	const events: { type: string; [key: string]: unknown }[] = [];
	// A stalled body: one chunk, then nothing (no close, no further data).
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "par" }))}\n\n`));
		},
	});
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		signal: controller.signal,
		fetch: () =>
			Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })),
		maxRetries: 0,
	} as never);
	const consuming = (async () => {
		for await (const event of stream) events.push(event as never);
	})();
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	// The loop must end without the server closing the body: race with a
	// generous margin, then assert completion.
	const finished = await Promise.race([
		consuming.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
	]);
	assert.ok(finished, "abort did not terminate the stalled stream");
	const last = events[events.length - 1]!;
	assert.equal(last.type, "error");
	assert.equal(last.reason, "aborted");
});

test("unicode content across chunk boundaries and emoji assemble without corruption", async () => {
	// Surrogate pair (🙈) delivered across two string deltas; the assembled
	// text must contain the intact emoji and no [object Object] junk.
	const emoji = "🙈";
	const high = emoji.slice(0, 1);
	const low = emoji.slice(1);
	const { message } = await runStream([
		chunk({ role: "assistant", content: "" }),
		chunk({ content: `Hi ${high}` }),
		chunk({ content: `${low} there` }),
		finalChunk("stop"),
	]);
	assert.equal(message.content[0]!.text, `Hi ${emoji} there`);
});

test("retried 429 with retry-after eventually succeeds", async () => {
	const events: { type: string; [key: string]: unknown }[] = [];
	let calls = 0;
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		maxRetries: 2,
		fetch: async () => {
			calls++;
			if (calls === 1) {
				return new Response(JSON.stringify({ message: "Too many requests" }), {
					status: 429,
					headers: { "retry-after": "0.01" },
				});
			}
			return sseResponse([chunk({ role: "assistant", content: "ok" }), finalChunk("stop")]);
		},
	} as never);
	for await (const event of stream) events.push(event as never);
	assert.equal(calls, 2, "expected one retry after the 429");
	const last = events[events.length - 1]!;
	assert.equal(last.type, "done");
	assert.equal(((last.message as { content: { text?: string }[] }).content[0]!.text), "ok");
});

test("truncated stream (connection closed mid-event) terminates with an error", async () => {
	// The SSE body ends inside a data line: the tail flush must fail the
	// stream rather than silently truncating the response.
	const { message } = await runStream([], {
		response: new Response("data: {\"choices\":[{", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	});
	assert.equal(message.stopReason, "error");
});

// =============================================================================
// Catalog and registration
// =============================================================================

test("DEFAULT_RATES covers all model families, is most-specific-first, and ends with a catch-all entry", () => {
	assert.equal(DEFAULT_RATES[DEFAULT_RATES.length - 1]?.match, "", "the last entry is the catch-all");
	const matches = new Set(DEFAULT_RATES.map((entry) => entry.match));
	for (const family of [
		"mistral-large",
		"mistral-medium",
		"mistral-small",
		"magistral",
		"codestral",
		"ministral",
		"pixtral-large",
		"pixtral",
		"devstral",
		"open-mistral",
	]) {
		assert.ok(matches.has(family), `missing rate-card family: ${family}`);
	}
	// Most-specific-first: pixtral-large shadows pixtral.
	assert.ok(
		DEFAULT_RATES.findIndex((entry) => entry.match === "pixtral-large") <
			DEFAULT_RATES.findIndex((entry) => entry.match === "pixtral"),
		"pixtral-large must precede pixtral",
	);
	// Regression anchors: the shipped card values (verified 2026-10-31).
	const large = DEFAULT_RATES.find((entry) => entry.match === "mistral-large");
	assert.ok(large);
	assert.deepEqual(large.rates, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });
	assert.deepEqual(DEFAULT_RATES[DEFAULT_RATES.length - 1]?.rates, {
		input: 0.7,
		output: 2.1,
		cacheRead: 0.07,
		cacheWrite: 0,
	});
});

// =============================================================================
// Per-family rate card
// =============================================================================

/*
 * DEFAULT_RATES matches model families most-specific-first and ends with
 * a catch-all entry; ids with no family match take the catch-all rates.
 *
 * ADR 0013 — Per-family rate card with sourced prices and visible fall-through
 */

/** Chat-capable model card with defaults, for rate-card fixtures. */
function familyCard(id: string): { id: string; capabilities: { completion_chat: true }; type: "base" } {
	return { id, capabilities: { completion_chat: true }, type: "base" };
}

test("per-family rate card: one model id per family maps to its researched rates", () => {
	const fixture = {
		object: "list",
		data: [
			familyCard("mistral-large-4"),
			familyCard("mistral-medium-3-5-latest"),
			familyCard("mistral-small-4-0-26-03"),
			familyCard("magistral-medium-latest"),
			familyCard("codestral-latest"),
			familyCard("ministral-3-8b-latest"),
			familyCard("pixtral-large-latest"),
			familyCard("pixtral-12b-2409"),
			familyCard("devstral-latest"),
			familyCard("open-mistral-nemo-2407"),
			// Catch-all: no family match (mistral-saba is retired and unpriced).
			familyCard("mistral-saba-latest"),
		],
	};
	const expected: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
		"mistral-large-4": { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 },
		"mistral-medium-3-5-latest": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
		"mistral-small-4-0-26-03": { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
		"magistral-medium-latest": { input: 2, output: 5, cacheRead: 0.2, cacheWrite: 0 },
		"codestral-latest": { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0 },
		"ministral-3-8b-latest": { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 },
		"pixtral-large-latest": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
		"pixtral-12b-2409": { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 },
		"devstral-latest": { input: 0.4, output: 2, cacheRead: 0.04, cacheWrite: 0 },
		"open-mistral-nemo-2407": { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 },
		"mistral-saba-latest": { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 },
	};
	for (const model of mapModelList(fixture)) {
		assert.deepEqual(
			model.cost,
			expected[model.id],
			`rate card for ${model.id}`,
		);
	}
	// Pixtral-large must get its own rates, not the pixtral family's.
	assert.deepEqual(mapModelList({ data: [familyCard("pixtral-large-2411")] })[0]?.cost, {
		input: 2,
		output: 6,
		cacheRead: 0.2,
		cacheWrite: 0,
	});
});

// =============================================================================
// Config overrides and fall-through visibility
// =============================================================================

test("a config rateCard entry overrides a built-in family (config checked first)", () => {
	setMistralConfigForTests({
		models: {
			rateCard: [{ match: "codestral", rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } }],
			fallThrough: undefined,
		},
	});
	try {
		const codestral = mapModelList({ data: [familyCard("codestral-latest")] })[0];
		assert.ok(codestral);
		assert.deepEqual(codestral.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
		// The override only shadows the matched family; others keep their rates.
		const large = mapModelList({ data: [familyCard("mistral-large-4")] })[0];
		assert.ok(large);
		assert.deepEqual(large.cost, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });
	} finally {
		setMistralConfigForTests(null); // restore this suite's no-file baseline
	}
});

test("a config entry with a new match string applies (most-specific-first before built-ins)", () => {
	setMistralConfigForTests({
		models: {
			rateCard: [{ match: "my-ft-model", rates: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 } }],
			fallThrough: undefined,
		},
	});
	try {
		const custom = mapModelList({ data: [familyCard("my-ft-model-7b")] })[0];
		assert.ok(custom);
		assert.deepEqual(custom.cost, { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 });
		// The new match is priced, not fall-through.
		assert.ok(!ratesAndFallThroughForModel("my-ft-model-7b").fallThrough);
	} finally {
		setMistralConfigForTests(null);
	}
});

test("fallThrough=false gives unpriced ids zero-cost placeholder rates while priced families keep theirs", () => {
	setMistralConfigForTests({ models: { rateCard: undefined, fallThrough: false } });
	try {
		const saba = mapModelList({ data: [familyCard("mistral-saba-latest")] })[0];
		assert.ok(saba);
		assert.deepEqual(saba.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// Still counted as fall-through (approximate marker).
		assert.ok(ratesAndFallThroughForModel("mistral-saba-latest").fallThrough);

		const large = mapModelList({ data: [familyCard("mistral-large-4")] })[0];
		assert.ok(large);
		assert.deepEqual(large.cost, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });
	} finally {
		setMistralConfigForTests(null);
	}
});

test("fallThrough=true (or unset) keeps catch-all rates for unpriced ids", () => {
	try {
		// Unset (no models section at all).
		const unset = mapModelList({ data: [familyCard("mistral-saba-latest")] })[0];
		assert.ok(unset);
		assert.deepEqual(unset.cost, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });

		// Explicitly true.
		setMistralConfigForTests({ models: { rateCard: undefined, fallThrough: true } });
		const explicit = mapModelList({ data: [familyCard("mistral-saba-latest")] })[0];
		assert.ok(explicit);
		assert.deepEqual(explicit.cost, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });
	} finally {
		setMistralConfigForTests(null);
	}
});

test("fallThroughModelIds lists exactly the ids that hit the catch-all", () => {
	const fixture = {
		object: "list",
		data: [
			familyCard("mistral-large-4"),
			familyCard("mistral-saba-latest"),
			familyCard("some-unknown-gateway-model"),
			// Filtered out before pricing: not chat-capable.
			{ id: "mistral-embed", capabilities: { completion_chat: false }, type: "base" },
		],
	};
	assert.deepEqual(fallThroughModelIds(fixture), ["mistral-saba-latest", "some-unknown-gateway-model"]);

	// A priced-only catalog does not trigger it.
	const pricedOnly = {
		object: "list",
		data: [familyCard("mistral-large-4"), familyCard("codestral-latest")],
	};
	assert.deepEqual(fallThroughModelIds(pricedOnly), []);

	// A config override that prices a previously unpriced id removes it from the list.
	setMistralConfigForTests({
		models: {
			rateCard: [{ match: "some-unknown-gateway-model", rates: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 } }],
			fallThrough: undefined,
		},
	});
	try {
		assert.deepEqual(fallThroughModelIds(fixture), ["mistral-saba-latest"]);
	} finally {
		setMistralConfigForTests(null);
	}
});

test("refreshMistralModels records the fall-through notice once per network refresh cycle", async () => {
	// TWO fall-through ids (the set of the fallThroughModelIds test): a
	// single-id fixture could not distinguish per-batch recording from a
	// per-model last-write-wins bug — the assertion below is what makes the
	// once-per-refresh claim non-vacuous.
	const fixture = {
		object: "list",
		data: [
			familyCard("mistral-large-4"),
			familyCard("mistral-saba-latest"),
			familyCard("some-unknown-gateway-model"),
			familyCard("codestral-latest"),
		],
	};
	setMistralFetch((async () => new Response(JSON.stringify(fixture), { status: 200 })) as typeof fetch);
	try {
		const { context } = makeContext({ credential: { type: "api_key", key: "test-key" } });
		const before = Date.now();
		await refreshMistralModels(context);
		// One notice per refresh cycle — not per model call — carrying BOTH
		// ids that got approximate pricing from the single refresh.
		const notice = lastFallThroughNotice();
		assert.ok(notice, "a refresh with fall-through ids records a notice");
		assert.deepEqual([...notice.ids], ["mistral-saba-latest", "some-unknown-gateway-model"]);
		assert.ok(notice.at >= before, "the notice carries the refresh timestamp");

		// A priced-only catalog records nothing (clears the stale notice).
		const pricedOnly = {
			object: "list",
			data: [familyCard("mistral-large-4"), familyCard("codestral-latest")],
		};
		setMistralFetch((async () => new Response(JSON.stringify(pricedOnly), { status: 200 })) as typeof fetch);
		await refreshMistralModels(context);
		assert.equal(lastFallThroughNotice(), undefined, "priced-only catalogs record no notice");
	} finally {
		setMistralFetch();
	}
});

test("the session_start surfacing path surfaces a recorded notice at most once per notice", async () => {
	const refreshWith = async (data: unknown[]) => {
		setMistralFetch((async () => new Response(JSON.stringify({ object: "list", data }), { status: 200 })) as typeof fetch);
		const { context } = makeContext({ credential: { type: "api_key", key: "test-key" } });
		await refreshMistralModels(context);
	};
	try {
		// First refresh: a notice is recorded and surfaces once.
		await refreshWith([familyCard("mistral-saba-latest")]);
		const first = takeFallThroughNoticeForTests();
		assert.ok(first, "a fresh notice surfaces");
		assert.match(first, /approximate fall-through pricing/);
		assert.match(first, /mistral-saba-latest/);

		// A repeated session_start does not repeat an already-surfaced notice.
		assert.equal(takeFallThroughNoticeForTests(), undefined, "dedup: a surfaced notice does not resurface");

		// A new refresh records a fresh notice (new `at`); it surfaces again.
		await refreshWith([familyCard("mistral-saba-latest")]);
		const second = takeFallThroughNoticeForTests();
		assert.ok(second, "a notice from a new refresh surfaces");
		assert.match(second, /mistral-saba-latest/);
		assert.equal(takeFallThroughNoticeForTests(), undefined, "the fresh notice is deduped after surfacing");
	} finally {
		setMistralFetch();
	}
});

/** ModelList fixture covering the mapping rules (see vendor/mistral-openapi.yaml, ModelList). */
function modelListFixture(): { object: string; data: unknown[] } {
	return {
		object: "list",
		data: [
			{
				id: "mistral-large-4",
				object: "model",
				created: 1756746619,
				owned_by: "mistralai",
				capabilities: {
					completion_chat: true,
					completion_fim: false,
					function_calling: true,
					fine_tuning: false,
					vision: true,
					reasoning: true,
					classification: false,
					moderation: false,
					ocr: false,
					audio: false,
				},
				name: "Mistral Large 4",
				description: "Flagship model",
				max_context_length: 409600,
				aliases: [],
				deprecation: null,
				deprecation_replacement_model: null,
				default_model_temperature: null,
				internal: false,
				billing_model_name: null,
				type: "base",
			},
			{
				id: "codestral-latest",
				object: "model",
				capabilities: { completion_chat: true, vision: false, reasoning: false, function_calling: true },
				name: "Codestral",
				max_context_length: 256000,
				internal: false,
				type: "base",
			},
			{
				// Family rate card (magistral) with reasoning, no vision.
				id: "magistral-medium-latest",
				object: "model",
				capabilities: { completion_chat: true, vision: false, reasoning: true },
				name: "Magistral Medium",
				max_context_length: 40000,
				type: "base",
			},
			{
				// No rate-card family match: final fallback rates.
				id: "mistral-saba-latest",
				object: "model",
				capabilities: { completion_chat: true, vision: false, reasoning: false },
				name: null,
				max_context_length: null,
				type: "base",
			},
			{
				// Missing name -> falls back to id; missing max_context_length -> 32768.
				id: "ministral-8b-latest",
				object: "model",
				capabilities: { completion_chat: true, vision: false, reasoning: false },
				type: "base",
			},
			{
				// Not chat-capable: dropped.
				id: "mistral-embed",
				object: "model",
				capabilities: { completion_chat: false, vision: false, reasoning: false },
				type: "base",
			},
			{
				// Internal model: dropped.
				id: "mistral-internal-test",
				object: "model",
				capabilities: { completion_chat: true, vision: false, reasoning: false },
				internal: true,
				type: "base",
			},
			{
				// Archived fine-tuned model: dropped.
				id: "my-ft-model",
				object: "model",
				capabilities: { completion_chat: true, vision: false, reasoning: false },
				archived: true,
				type: "fine-tuned",
			},
			{
				// Deprecated model: dropped when other models remain.
				id: "devstral-old",
				object: "model",
				capabilities: { completion_chat: true, vision: false, reasoning: false },
				deprecation: "2020-01-01T00:00:00Z",
				type: "base",
			},
		],
	};
}

test("mapModelList filters, maps, and sorts the ModelList wire format", () => {
	const models = mapModelList(modelListFixture());

	assert.deepEqual(
		models.map((m) => m.id),
		["codestral-latest", "magistral-medium-latest", "ministral-8b-latest", "mistral-large-4", "mistral-saba-latest"],
		"chat-capable models kept, non-chat/internal/archived/deprecated dropped, sorted by id",
	);

	for (const model of models) {
		assert.equal(model.api, "mistral-chat");
	}

	const large = models.find((m) => m.id === "mistral-large-4");
	assert.ok(large);
	assert.equal(large.name, "Mistral Large 4");
	assert.equal(large.reasoning, true);
	assert.deepEqual(large.input, ["text", "image"]);
	assert.deepEqual(large.cost, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });
	assert.equal(large.contextWindow, 409600);
	// Wire-enforced ceiling (262144) capped at the context window.
	assert.equal(large.maxTokens, 262144);

	const codestral = models.find((m) => m.id === "codestral-latest");
	assert.ok(codestral);
	assert.equal(codestral.reasoning, false);
	assert.deepEqual(codestral.input, ["text"]);
	assert.deepEqual(codestral.cost, { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0 });
	assert.equal(codestral.contextWindow, 256000);
	assert.equal(codestral.maxTokens, 256000);

	const magistral = models.find((m) => m.id === "magistral-medium-latest");
	assert.ok(magistral);
	assert.deepEqual(magistral.cost, { input: 2, output: 5, cacheRead: 0.2, cacheWrite: 0 });

	const saba = models.find((m) => m.id === "mistral-saba-latest");
	assert.ok(saba);
	assert.equal(saba.name, "mistral-saba-latest"); // null name falls back to id
	assert.deepEqual(saba.cost, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 }); // final fallback

	const ministral = models.find((m) => m.id === "ministral-8b-latest");
	assert.ok(ministral);
	assert.equal(ministral.name, "ministral-8b-latest"); // missing name falls back to id
	assert.deepEqual(ministral.cost, { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 });
	assert.equal(ministral.contextWindow, 32768); // default max_context_length
	assert.equal(ministral.maxTokens, 32768); // ceiling capped at the context window
});

test("maxTokens mapping: wire-enforced completion ceiling caps the context window when no documented output limit exists", () => {
	// The API enforces a per-model completion-token ceiling the model pages
	// do not document (400 code 3058 when exceeded); unknown models get the
	// conservative fallback, capped at the context window.
	assert.equal(documentedMaxTokensForModel("mistral-large-4", 1048576), 262144);
	assert.equal(documentedMaxTokensForModel("mistral-small-2603", 262144), 262144);
	assert.equal(documentedMaxTokensForModel("ministral-3-8b-2512", 262144), 262144);
});

test("maxTokens mapping: documented output limit wins and is capped at the context window", () => {
	// Hosted third-party models are the only ones with a documented output
	// token limit (128k on docs.mistral.ai, verified 2026-11-02) — the
	// documented limit wins over the wire-enforced ceiling.
	assert.equal(documentedMaxTokensForModel("zai-glm-5-3", 1048576), 131072);
	assert.equal(documentedMaxTokensForModel("zai-glm-5-3-flash", 1048576), 131072);
	assert.equal(documentedMaxTokensForModel("deepseek-v4-1-flash-1017", 1048576), 131072);
	// A stale override can never exceed the context window.
	assert.equal(documentedMaxTokensForModel("zai-glm-5-3", 65536), 65536);
	// DOCUMENTED_OUTPUT_LIMITS is checked most-specific-first (mirrors the rate card).
	for (const entry of DOCUMENTED_OUTPUT_LIMITS) {
		assert.ok(entry.maxOutputTokens > 0);
	}
});

test("completion ceiling table maps wire-verified ceilings and falls back conservatively", () => {
	// mistral-large-4 (and the -0 alias) is the wire-verified entry: 262144
	// (400 code 3058 message names the ceiling, probed 2026-11-03).
	assert.equal(completionCeilingForModel("mistral-large-4"), 262144);
	assert.equal(completionCeilingForModel("mistral-large-4-0"), 262144);
	// Unknown ids get the conservative fallback: a too-small value merely
	// caps output, a too-large one hard-fails requests with 400 code 3058.
	assert.equal(completionCeilingForModel("mistral-medium-latest"), COMPLETION_CEILING_FALLBACK);
	assert.equal(completionCeilingForModel("codestral-2508"), COMPLETION_CEILING_FALLBACK);
	assert.equal(COMPLETION_CEILING_FALLBACK, 262144);
	for (const entry of API_ENFORCED_COMPLETION_CEILINGS) {
		assert.ok(entry.completionCeiling > 0);
	}
});

test("mapModelList applies the documented max-output mapping to live cards", () => {
	const models = mapModelList({
		object: "list",
		data: [
			{
				id: "zai-glm-5-3",
				capabilities: { completion_chat: true },
				name: "GLM 5.3",
				max_context_length: 1048576,
				type: "base",
			},
			{
				id: "mistral-small-2603",
				capabilities: { completion_chat: true },
				name: "Mistral Small 4",
				max_context_length: 262144,
				type: "base",
			},
			{
				id: "mistral-large-4",
				capabilities: { completion_chat: true },
				name: "Mistral Large 4",
				max_context_length: 1048576,
				type: "base",
			},
		],
	});
	const glm = models.find((m) => m.id === "zai-glm-5-3");
	assert.ok(glm);
	assert.equal(glm.contextWindow, 1048576);
	assert.equal(glm.maxTokens, 131072, "documented 128k limit overrides the context window");
	const small = models.find((m) => m.id === "mistral-small-2603");
	assert.ok(small);
	assert.equal(small.maxTokens, 262144, "unknown model: conservative fallback capped at the context window");
	const large = models.find((m) => m.id === "mistral-large-4");
	assert.ok(large);
	assert.equal(large.maxTokens, 262144, "wire-enforced ceiling caps the 1M context window");
});

test("mapModelList ignores the deprecation filter when every eligible model is deprecated", () => {
	const models = mapModelList({
		object: "list",
		data: [
			{
				id: "legacy-chat",
				capabilities: { completion_chat: true },
				deprecation: "2020-01-01T00:00:00Z",
				type: "base",
			},
			{ id: "legacy-embed", capabilities: { completion_chat: false }, type: "base" },
		],
	});
	assert.deepEqual(
		models.map((m) => m.id),
		["legacy-chat"],
	);
});

test("mapModelList throws on malformed input", async () => {
	assert.throws(() => mapModelList({}), /malformed/);
	assert.throws(() => mapModelList("nope"), /malformed/);
	assert.throws(() => mapModelList({ object: "list", data: "not-an-array" }), /malformed/);
});

test("fetchMistralModels requests {baseUrl}/models with bearer auth and maps the response", async () => {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	setMistralFetch((async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		return new Response(JSON.stringify(modelListFixture()), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch);
	try {
		const cards = await fetchMistralModels(MISTRAL_BASE_URL, "test-key");
		assert.equal(cards.length, 9);
		assert.equal(cards[0]?.id, "mistral-large-4");

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, "https://api.mistral.ai/v1/models");
		assert.equal(calls[0]?.headers["Authorization"], "Bearer test-key");
		assert.equal(calls[0]?.headers["Accept"], "application/json");
	} finally {
		setMistralFetch();
	}
});

test("fetchMistralModels throws a descriptive error with status on non-200 responses", async () => {
	setMistralFetch((async () => new Response("Unauthorized", { status: 401 })) as typeof fetch);
	try {
		await assert.rejects(
			() => fetchMistralModels(MISTRAL_BASE_URL, "test-key"),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /HTTP 401/);
				assert.equal((error as { status?: number }).status, 401);
				return true;
			},
		);
	} finally {
		setMistralFetch();
	}
});

test("fetchMistralModels throws on a malformed response body", async () => {
	setMistralFetch((async () => new Response(JSON.stringify({ object: "list" }), { status: 200 })) as typeof fetch);
	try {
		await assert.rejects(() => fetchMistralModels(MISTRAL_BASE_URL, "test-key"), /malformed/);
	} finally {
		setMistralFetch();
	}
});

/** Build a fake refresh context with a recording publish. */
function makeContext(overrides: {
	credential?: RefreshModelsContext["credential"];
	stored?: ModelsStoreEntry;
	allowNetwork?: boolean;
	signal?: AbortSignal;
	publishResult?: boolean;
}): { context: RefreshModelsContext; publications: unknown[] } {
	const publications: unknown[] = [];
	const context: RefreshModelsContext = {
		allowNetwork: overrides.allowNetwork ?? true,
		signal: overrides.signal ?? new AbortController().signal,
		...(overrides.credential ? { credential: overrides.credential } : {}),
		...(overrides.stored ? { stored: overrides.stored } : {}),
		publish: async (publication) => {
			publications.push(publication);
			return overrides.publishResult ?? true;
		},
	};
	return { context, publications };
}

/** Full chat model snapshot as persisted by pi (ModelsStoreEntry.models). */
function storedModel(id: string, name: string): Model<string> {
	return {
		type: "chat",
		id,
		name,
		api: "mistral-chat",
		provider: "mistral-native",
		baseUrl: MISTRAL_BASE_URL,
		input: ["text"],
		cost: { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 256000,
		maxTokens: 256000,
	};
}

test("network refresh maps a live /models response to chat model configs", async () => {
	setMistralFetch((async () => new Response(JSON.stringify(modelListFixture()), { status: 200 })) as typeof fetch);
	try {
		const { context } = makeContext({
			credential: { type: "api_key", key: "test-key" },
		});
		const models = asChatConfigs(await refreshMistralModels(context));
		assert.deepEqual(
			models.map((m) => m.id),
			["codestral-latest", "magistral-medium-latest", "ministral-8b-latest", "mistral-large-4", "mistral-saba-latest"],
		);
		const large = models.find((m) => m.id === "mistral-large-4");
		assert.ok(large);
		assert.equal(large.api, "mistral-chat");
		assert.equal(large.reasoning, true);
		assert.deepEqual(large.input, ["text", "image"]);
	} finally {
		setMistralFetch();
	}
});

test("a successful network refresh publishes the full chat models for persistence exactly once", async () => {
	setMistralFetch((async () => new Response(JSON.stringify(modelListFixture()), { status: 200 })) as typeof fetch);
	try {
		const before = Date.now();
		const { context, publications } = makeContext({
			credential: { type: "api_key", key: "test-key" },
		});
		const models = asChatConfigs(await refreshMistralModels(context));

		assert.equal(publications.length, 1, "exactly one publication on success");
		const publication = publications[0] as {
			persist?: { models: { type?: string; provider?: string; baseUrl?: string; id?: string }[]; checkedAt?: number };
		};
		assert.ok(publication.persist, "the publication persists the fetched catalog");
		assert.equal(publication.persist.models.length, models.length);
		assert.deepEqual(
			publication.persist.models.map((m) => m.id),
			models.map((m) => m.id),
		);
		for (const persisted of publication.persist.models) {
			assert.equal(persisted.type, "chat", "persisted models are full chat Model objects");
			assert.equal(persisted.provider, "mistral-native");
			assert.equal(persisted.baseUrl, "https://api.mistral.ai/v1");
		}
		assert.ok(
			publication.persist.checkedAt !== undefined && publication.persist.checkedAt >= before,
			"checkedAt is a fresh timestamp",
		);
	} finally {
		setMistralFetch();
	}
});

test("a successful fetch mapping to an empty catalog returns the last-known list without persisting", async () => {
	const emptyCatalog = {
		object: "list",
		data: [
			{ id: "mistral-embed", capabilities: { completion_chat: false }, type: "base" },
			{ id: "mistral-internal-test", capabilities: { completion_chat: true }, internal: true, type: "base" },
		],
	};
	setMistralFetch((async () => new Response(JSON.stringify(emptyCatalog), { status: 200 })) as typeof fetch);
	try {
		// Without a stored snapshot: static fallback.
		const { context, publications } = makeContext({
			credential: { type: "api_key", key: "test-key" },
		});
		const models = await refreshMistralModels(context);
		assert.deepEqual(models, MODELS);
		assert.equal(publications.length, 0, "an empty mapping must not persist or publish anything");

		// With a stored snapshot: restored list.
		const stored: ModelsStoreEntry = { models: [storedModel("codestral-latest", "Codestral")] };
		const { context: storedContext, publications: storedPublications } = makeContext({
			credential: { type: "api_key", key: "test-key" },
			stored,
		});
		const storedModels = await refreshMistralModels(storedContext);
		assert.deepEqual(
			storedModels.map((m) => m.id),
			["codestral-latest"],
		);
		assert.equal(storedPublications.length, 0, "an empty mapping must not persist or publish anything");
	} finally {
		setMistralFetch();
	}
});

test("HTTP 500 returns the last-known list without throwing", async () => {
	setMistralFetch((async () => new Response("Internal Server Error", { status: 500 })) as typeof fetch);
	try {
		// Without a stored snapshot: static fallback.
		const { context } = makeContext({
			credential: { type: "api_key", key: "test-key" },
		});
		const models = await refreshMistralModels(context);
		assert.deepEqual(models, MODELS);

		// With a stored snapshot: restored list.
		const stored: ModelsStoreEntry = { models: [storedModel("codestral-latest", "Codestral")] };
		const { context: storedContext } = makeContext({
			credential: { type: "api_key", key: "test-key" },
			stored,
		});
		const storedModels = await refreshMistralModels(storedContext);
		assert.deepEqual(
			storedModels.map((m) => m.id),
			["codestral-latest"],
		);
	} finally {
		setMistralFetch();
	}
});

test("auth failure (HTTP 401) rejects with a clean error that surfaces in the UI", async () => {
	setMistralFetch((async () => new Response("Unauthorized", { status: 401 })) as typeof fetch);
	try {
		const { context } = makeContext({
			credential: { type: "api_key", key: "test-key" },
		});
		await assert.rejects(
			() => refreshMistralModels(context),
			(error: unknown) => {
				assert.ok(error instanceof Error, "must reject with an Error, not resolve silently");
				assert.match(error.message, /unauthorized \(HTTP 401\)/);
				return true;
			},
		);
	} finally {
		setMistralFetch();
	}
});

test("restore preserves optional model fields from the stored snapshot", async () => {
	const stored: ModelsStoreEntry = {
		models: [
			{
				...storedModel("mistral-large-4", "Mistral Large 4"),
				thinkingLevelMap: { high: null, medium: "auto" },
				inputLimits: { maxRequestBytes: 1000000 },
				headers: { "X-Mistral-Test": "1" },
				samplingParams: { temperature: 0.7 },
			},
		],
	};
	const { context } = makeContext({ stored, allowNetwork: false });
	const models = asChatConfigs(await refreshMistralModels(context));
	assert.equal(models.length, 1);
	const model = models[0];
	assert.ok(model);
	assert.deepEqual(model.thinkingLevelMap, { high: null, medium: "auto" });
	assert.deepEqual(model.inputLimits, { maxRequestBytes: 1000000 });
	assert.deepEqual(model.headers, { "X-Mistral-Test": "1" });
	assert.deepEqual(model.samplingParams, { temperature: 0.7 });
});

test("offline phase restores the stored snapshot as config models", async () => {
	const stored: ModelsStoreEntry = {
		models: [storedModel("codestral-latest", "Codestral"), storedModel("mistral-large-4", "Mistral Large 4")],
		checkedAt: 1750000000000,
	};
	const { context, publications } = makeContext({
		credential: { type: "api_key", key: "test-key" },
		stored,
		allowNetwork: false,
	});
	const models = asChatConfigs(await refreshMistralModels(context));

	assert.deepEqual(
		models.map((m) => m.id).sort(),
		["codestral-latest", "mistral-large-4"],
	);
	const codestral = models.find((m) => m.id === "codestral-latest");
	assert.ok(codestral);
	assert.equal(codestral.name, "Codestral");
	assert.equal(codestral.api, "mistral-chat");
	assert.equal(codestral.reasoning, false);
	assert.deepEqual(codestral.cost, { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0 });
	assert.equal(codestral.contextWindow, 256000);
	assert.equal(codestral.maxTokens, 256000);

	assert.equal(publications.length, 0, "offline restore does not rewrite the store; the composer publishes the returned list");
});

test("offline phase falls back to the static MODELS catalog when no snapshot is stored", async () => {
	let fetchCalls = 0;
	setMistralFetch((async () => {
		fetchCalls += 1;
		throw new Error("must not be called");
	}) as typeof fetch);
	try {
		const { context, publications } = makeContext({ allowNetwork: false });
		const models = await refreshMistralModels(context);
		assert.deepEqual(models, MODELS);
		assert.equal(publications.length, 0, "no publish without a stored snapshot");
		assert.equal(fetchCalls, 0, "no network access during the offline phase");
	} finally {
		setMistralFetch();
	}
});

test("offline phase with a stored snapshot containing only non-chat models falls back to the static catalog", async () => {
	const stored: ModelsStoreEntry = {
		models: [
			{
				type: "image",
				id: "mistral-image-fake",
				name: "Fake Image Model",
				api: "openrouter-images",
				provider: "mistral-native",
				baseUrl: MISTRAL_BASE_URL,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				output: ["image"],
			},
		],
		checkedAt: 1750000000000,
	};
	const { context } = makeContext({ stored, allowNetwork: false });
	const models = await refreshMistralModels(context);
	assert.deepEqual(models, MODELS, "no restorable chat models -> static fallback, not an empty catalog");
});

test("a superseded network persist returns [] (consistent with the offline phase)", async () => {
	setMistralFetch((async () => new Response(JSON.stringify(modelListFixture()), { status: 200 })) as typeof fetch);
	try {
		const { context, publications } = makeContext({
			credential: { type: "api_key", key: "test-key" },
			publishResult: false,
		});
		const models = await refreshMistralModels(context);
		assert.deepEqual(models, []);
		assert.equal(publications.length, 1, "the persist publication was attempted before the supersede short-circuit");
	} finally {
		setMistralFetch();
	}
});

test("network unavailability keeps the stored list without throwing", async () => {
	setMistralFetch((async () => {
		throw new TypeError("fetch failed");
	}) as typeof fetch);
	try {
		const stored: ModelsStoreEntry = {
			models: [storedModel("codestral-latest", "Codestral")],
			checkedAt: 1750000000000,
		};
		const { context } = makeContext({
			credential: { type: "api_key", key: "test-key" },
			stored,
		});
		const models = await refreshMistralModels(context);
		assert.deepEqual(
			models.map((m) => m.id),
			["codestral-latest"],
		);
	} finally {
		setMistralFetch();
	}
});

test("network unavailability without a stored snapshot falls back to the static catalog", async () => {
	setMistralFetch((async () => {
		throw new TypeError("fetch failed");
	}) as typeof fetch);
	try {
		const { context } = makeContext({
			credential: { type: "api_key", key: "test-key" },
		});
		const models = await refreshMistralModels(context);
		assert.deepEqual(models, MODELS);
	} finally {
		setMistralFetch();
	}
});

test("an aborted signal skips the fetch and returns the last-known list quietly", async () => {
	let fetchCalls = 0;
	setMistralFetch((async () => {
		fetchCalls += 1;
		throw new Error("must not be called");
	}) as typeof fetch);
	try {
		const controller = new AbortController();
		controller.abort();
		const { context } = makeContext({
			credential: { type: "api_key", key: "test-key" },
			signal: controller.signal,
		});
		const models = await refreshMistralModels(context);
		assert.deepEqual(models, MODELS);
		assert.equal(fetchCalls, 0);

		const stored: ModelsStoreEntry = { models: [storedModel("codestral-latest", "Codestral")] };
		const { context: storedContext } = makeContext({
			credential: { type: "api_key", key: "test-key" },
			stored,
			signal: controller.signal,
		});
		const storedModels = await refreshMistralModels(storedContext);
		assert.deepEqual(
			storedModels.map((m) => m.id),
			["codestral-latest"],
		);
		assert.equal(fetchCalls, 0);
	} finally {
		setMistralFetch();
	}
});

test("network phase without a resolved credential returns [] and performs no fetch", async () => {
	let fetchCalls = 0;
	setMistralFetch((async () => {
		fetchCalls += 1;
		throw new Error("must not be called");
	}) as typeof fetch);
	try {
		const { context } = makeContext({});
		const models = await refreshMistralModels(context);
		assert.deepEqual(models, []);
		assert.equal(fetchCalls, 0);
	} finally {
		setMistralFetch();
	}
});

test("an OAuth credential's access token is used as the API key", async () => {
	const calls: string[] = [];
	setMistralFetch((async (_url: string | URL | Request, init?: RequestInit) => {
		calls.push(((init?.headers ?? {}) as Record<string, string>)["Authorization"] ?? "");
		return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
	}) as typeof fetch);
	try {
		const { context } = makeContext({
			credential: {
				type: "oauth",
				refresh: "test-refresh",
				access: "test-access",
				expires: Date.now() + 100000,
			},
		});
		const models = asChatConfigs(await refreshMistralModels(context));
		// The mocked empty catalog maps to [] which falls back to the static list;
		// the Authorization header is the assertion under test.
		assert.deepEqual(models, MODELS);
		assert.deepEqual(calls, ["Bearer test-access"]);
	} finally {
		setMistralFetch();
	}
});

// =============================================================================
// Region routing and surcharge
// =============================================================================

/**
 * Region-endpoint URLs (mirrors MISTRAL_REGION_BASE_URLS in
 * extensions/mistral/config.ts; asserted locally so a URL typo in the mapping
 * fails the routing tests, not just the config tests).
 *
 * ADR 0012 — Selectable region endpoint with per-family routing
 */
const EU_BASE_URL = "https://api.eu.mistral.ai/v1";
const US_BASE_URL = "https://api.us.mistral.ai/v1";

/** Minimal ModelList body with one chat-capable card (for regional refresh). */
function singleCardFixture(): { object: string; data: unknown[] } {
	return {
		object: "list",
		data: [
			{
				id: "mistral-large-4",
				object: "model",
				capabilities: { completion_chat: true, vision: false, reasoning: true },
				name: "Mistral Large 4",
				max_context_length: 409600,
				type: "base",
			},
		],
	};
}

/**
 * Run a stream with a fetch capture recording the request URL; `model`
 * overrides the runtime model (e.g. a gateway baseUrl), `streamOptions`
 * flows into the streamSimple options.
 */
async function runCapturedStreamUrl(
	options: { model?: RuntimeModel; streamOptions?: Record<string, unknown> } = {},
): Promise<string> {
	let url = "";
	const stream = mistralStreamSimple((options.model ?? makeModel()) as never, CONTEXT, {
		apiKey: "test-key",
		fetch: async (requestUrl: unknown) => {
			url = String(requestUrl);
			return sseResponse([chunk({ role: "assistant", content: "ok" }), finalChunk("stop")]);
		},
		maxRetries: 0,
		...(options.streamOptions ?? {}),
	} as never);
	const events: { type: string }[] = [];
	for await (const event of stream) events.push(event as never);
	const last = events[events.length - 1]!;
	assert.ok(last.type === "done" || last.type === "error", `stream ended with ${last.type}`);
	return url;
}

test("chat stream posts to the global base by default (no JSON, no env)", async () => {
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests(null);
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, `${MISTRAL_BASE_URL}/chat/completions`);
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("chat stream posts to the eu base when the effective config says so (JSON region)", async () => {
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests({ endpoint: { region: "eu", baseUrl: undefined } });
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, `${EU_BASE_URL}/chat/completions`);
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("chat stream posts to the us base when MISTRAL_REGION=us and no JSON is present", async () => {
	await withEnv({ MISTRAL_REGION: "us" }, async () => {
		setMistralConfigForTests(null);
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, `${US_BASE_URL}/chat/completions`);
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("JSON region wins over MISTRAL_REGION env in the stream URL", async () => {
	await withEnv({ MISTRAL_REGION: "us" }, async () => {
		setMistralConfigForTests({ endpoint: { region: "eu", baseUrl: undefined } });
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, `${EU_BASE_URL}/chat/completions`);
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("agent mode still posts to the GLOBAL agents/completions even when region=eu", async () => {
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests({ agentId: "file-agent", endpoint: { region: "eu", baseUrl: undefined } });
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, `${MISTRAL_BASE_URL}/agents/completions`);
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("with MISTRAL_REGION unset and no JSON, the stream URL is byte-for-byte today's behavior", async () => {
	// Env-only regression: null override + unset env → the global chat URL,
	// exactly the no-endpoint-config behavior.
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests(null);
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, "https://api.mistral.ai/v1/chat/completions");
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("catalog refresh fetches {regional}/models and persists models with the regional baseUrl (context.baseUrl unset)", async () => {
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests({ endpoint: { region: "eu", baseUrl: undefined } });
		const calls: string[] = [];
		setMistralFetch((async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(JSON.stringify(singleCardFixture()), { status: 200 });
		}) as typeof fetch);
		try {
			const { context, publications } = makeContext({
				credential: { type: "api_key", key: "test-key" },
			});
			const models = asChatConfigs(await refreshMistralModels(context));
			assert.equal(models.length, 1);
			assert.deepEqual(calls, [`${EU_BASE_URL}/models`]);
			const publication = publications[0] as {
				persist?: { models: { baseUrl?: string }[] };
			};
			assert.ok(publication.persist);
			assert.equal(publication.persist.models.length, 1);
			assert.equal(publication.persist.models[0]?.baseUrl, EU_BASE_URL);
		} finally {
			setMistralFetch();
			setMistralConfigForTests(null);
		}
	});
});

test("explicit context.baseUrl still wins over the region in catalog refresh", async () => {
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests({ endpoint: { region: "eu", baseUrl: undefined } });
		const calls: string[] = [];
		setMistralFetch((async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(JSON.stringify(singleCardFixture()), { status: 200 });
		}) as typeof fetch);
		try {
			const { context, publications } = makeContext({
				credential: { type: "api_key", key: "test-key" },
			});
			// pi's own override (a models.json snapshot or harness) wins.
			(context as RefreshModelsContext & { baseUrl: string }).baseUrl = "https://pi-override.example/v1";
			const models = asChatConfigs(await refreshMistralModels(context));
			assert.equal(models.length, 1);
			assert.deepEqual(calls, ["https://pi-override.example/v1/models"]);
			const publication = publications[0] as {
				persist?: { models: { baseUrl?: string }[] };
			};
			assert.equal(publication.persist?.models[0]?.baseUrl, "https://pi-override.example/v1");
		} finally {
			setMistralFetch();
			setMistralConfigForTests(null);
		}
	});
});

test("mapModelList with region=eu produces costs = global rates × 1.1 (4-decimal rounded); global unchanged", async () => {
	// Global (module baseline: null config, env unset) → identity rates;
	// DEFAULT_RATES itself is untouched by any region setting.
	await withEnv({ MISTRAL_REGION: undefined }, () => {
		setMistralConfigForTests(null);
		const globalModels = mapModelList(modelListFixture());
		const globalLarge = globalModels.find((m) => m.id === "mistral-large-4")!;
		// Sourced prices: mistral-large-4 = 0.70/2.10/0.07.
		assert.deepEqual(globalLarge.cost, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });
		assert.deepEqual(DEFAULT_RATES[0]!.rates, { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 });
	});

	// JSON region eu → surcharged rates.
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests({ endpoint: { region: "eu", baseUrl: undefined } });
		try {
			const euModels = mapModelList(modelListFixture());
			// Costs are the global rates × 1.1, rounded to 4 decimals
			// (0.70/2.10/0.07 → 0.77/2.31/0.077).
			const euLarge = euModels.find((m) => m.id === "mistral-large-4")!;
			assert.deepEqual(euLarge.cost, { input: 0.77, output: 2.31, cacheRead: 0.077, cacheWrite: 0 });
			const euCodestral = euModels.find((m) => m.id === "codestral-latest")!;
			assert.deepEqual(euCodestral.cost, { input: 0.33, output: 0.99, cacheRead: 0.033, cacheWrite: 0 });
		} finally {
			setMistralConfigForTests(null);
		}
	});

	// Env-only region (no JSON present) drives the same surcharge.
	await withEnv({ MISTRAL_REGION: "us" }, () => {
		setMistralConfigForTests(null);
		const usModels = mapModelList(modelListFixture());
		const usLarge = usModels.find((m) => m.id === "mistral-large-4")!;
		assert.deepEqual(usLarge.cost, { input: 0.77, output: 2.31, cacheRead: 0.077, cacheWrite: 0 });
	});
});

test("server-side tools keep chat requests on the global endpoint under region=eu", async () => {
	// Server-execution surfaces are not available regionally: the request
	// carries `{type:"web_search"}` server-tool entries, so it posts globally
	// even though plain chat would route regionally.
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests({ serverTools: ["web_search"], endpoint: { region: "eu", baseUrl: undefined } });
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, "https://api.mistral.ai/v1/chat/completions");
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("an explicit endpoint.baseUrl routes the chat stream and wins over the region", async () => {
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests({ endpoint: { region: "eu", baseUrl: "https://gateway.example/v1" } });
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, "https://gateway.example/v1/chat/completions");
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("an explicit endpoint.baseUrl applies to server-tools chat too", async () => {
	// The gateway escape hatch declares "my Mistral API lives there" — it
	// applies to every chat mode, server-execution surfaces included.
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests({
			serverTools: ["web_search"],
			endpoint: { region: "eu", baseUrl: "https://gateway.example/v1" },
		});
		try {
			const url = await runCapturedStreamUrl();
			assert.equal(url, "https://gateway.example/v1/chat/completions");
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("with no endpoint configuration the stream honors the model's baseUrl", async () => {
	// Regression pin: with no endpoint configuration the override is
	// undefined and pi's models.json model-level baseUrl override flows
	// through — byte-for-byte the no-endpoint-config behavior.
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests(null);
		try {
			const url = await runCapturedStreamUrl({ model: makeModel({ baseUrl: "https://gateway.example/v1" }) });
			assert.equal(url, "https://gateway.example/v1/chat/completions");
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("agent mode with a gateway model.baseUrl and no endpoint config posts to the gateway (no-endpoint-config behavior)", async () => {
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests(null);
		try {
			const url = await runCapturedStreamUrl({
				model: makeModel({ baseUrl: "https://gateway.example/v1" }),
				streamOptions: { env: { MISTRAL_AGENT_ID: "agent" } },
			});
			assert.equal(url, "https://gateway.example/v1/agents/completions");
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

test("MISTRAL_REGION in pi's provider env routes the chat stream", async () => {
	// The stream honors pi's provider-scoped env (the same env precedence
	// as parseServerToolsConfig), not just process.env.
	await withEnv({ MISTRAL_REGION: undefined }, async () => {
		setMistralConfigForTests(null);
		try {
			const url = await runCapturedStreamUrl({ streamOptions: { env: { MISTRAL_REGION: "us" } } });
			assert.equal(url, "https://api.us.mistral.ai/v1/chat/completions");
		} finally {
			setMistralConfigForTests(null);
		}
	});
});

// =============================================================================
// Session-start region notice
// =============================================================================

/**
 * Drive the real extension factory through a fake pi ExtensionAPI and fire
 * the captured session_start handler with a fake ctx (the captureRegistration
 * pattern of test/auth.test.ts). Returns the recorded notifications.
 *
 * Determinism: the handler's refreshMistralConfig reloads the scopes from
 * disk, so the user-scope chain is isolated into a temp dir (no real machine
 * config leaks in) and the testConfig override still wins for the effective
 * config. The temp dir doubles as the session cwd (trusted), which is empty
 * of a project scope.
 */
async function fireSessionStart(): Promise<{ message: string; type: string }[]> {
	const notifications: { message: string; type: string }[] = [];
	const sessionStartHandlers: ((event: unknown, ctx: unknown) => void | Promise<void>)[] = [];
	const pi = {
		registerProvider: () => undefined,
		registerTool: () => undefined,
		registerCommand: () => undefined,
		on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => {
			// Real pi runs EVERY handler for an event; the connector loader
			// adds a second session_start listener next to the
			// config/region one, so capture and fire them all, in order.
			if (event === "session_start") sessionStartHandlers.push(handler);
		},
	} as never;
	registerExtension(pi);
	assert.ok(sessionStartHandlers.length > 0, "extension did not register a session_start handler");
	const dir = mkdtempSync(join(tmpdir(), "mistral-region-notice-"));
	try {
		const ctx = {
			cwd: dir,
			isProjectTrusted: () => true,
			ui: { notify: (message: string, type?: string) => notifications.push({ message, type: type ?? "info" }) },
		};
		for (const handler of sessionStartHandlers) await Promise.resolve(handler(undefined, ctx));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return notifications;
}

test("session_start warns once, as a warning, when the effective region is non-global (JSON)", async () => {
	// Isolate the user-scope chain so no real machine config leaks into the
	// handler's disk refresh (the testConfig override still wins for the
	// effective config).
	await withEnv({ PI_CODING_AGENT_DIR: undefined, XDG_CONFIG_HOME: undefined, HOME: undefined, MISTRAL_REGION: undefined }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "mistral-region-env-"));
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		process.env.XDG_CONFIG_HOME = join(dir, "xdg");
		process.env.HOME = join(dir, "home");
		try {
			setMistralConfigForTests({ endpoint: { region: "eu", baseUrl: undefined } });
			const notifications = await fireSessionStart();
			assert.equal(notifications.length, 1, "exactly one notify");
			const notice = notifications[0]!;
			assert.equal(notice.type, "warning");
			assert.match(notice.message, /region "eu"/);
			assert.ok(notice.message.includes("https://api.eu.mistral.ai/v1"), "names the regional base");
			assert.ok(notice.message.includes(MISTRAL_BASE_URL), "names the global endpoint for the other families");
			assert.ok(notice.message.includes("+10%"), "mentions the surcharge");
			assert.ok(notice.message.includes("Control-plane data"), "carries the control-plane caveat");
		} finally {
			setMistralConfigForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("session_start does not notify when the effective region is global", async () => {
	await withEnv({ PI_CODING_AGENT_DIR: undefined, XDG_CONFIG_HOME: undefined, HOME: undefined, MISTRAL_REGION: undefined }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "mistral-region-env-"));
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		process.env.XDG_CONFIG_HOME = join(dir, "xdg");
		process.env.HOME = join(dir, "home");
		try {
			setMistralConfigForTests(null);
			const notifications = await fireSessionStart();
			assert.equal(notifications.length, 0, "no notify at all for the global region");
		} finally {
			setMistralConfigForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("session_start warns from the MISTRAL_REGION env layer when no JSON is present", async () => {
	await withEnv(
		{ PI_CODING_AGENT_DIR: undefined, XDG_CONFIG_HOME: undefined, HOME: undefined, MISTRAL_REGION: "us" },
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "mistral-region-env-"));
			process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
			process.env.XDG_CONFIG_HOME = join(dir, "xdg");
			process.env.HOME = join(dir, "home");
			try {
				setMistralConfigForTests(null);
				const notifications = await fireSessionStart();
				assert.equal(notifications.length, 1, "exactly one notify");
				const notice = notifications[0]!;
				assert.equal(notice.type, "warning");
				assert.match(notice.message, /region "us"/);
				assert.ok(notice.message.includes("https://api.us.mistral.ai/v1"), "names the us regional base");
			} finally {
				setMistralConfigForTests(null);
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

// =============================================================================
// Native-provider catalog round-trip (createProvider persistence)
// =============================================================================

/**
 * Regression suite for the native `createProvider` registration:
 * `createProvider`'s fetchModels wrapper PERSISTS the list our adapter
 * returns — a second persist after `refreshMistralModels`'s own, into the same
 * store slot — so the returned entries must be complete chat models
 * (provider/type/baseUrl). Incomplete entries would clobber the good
 * snapshot: the next session's offline restore (`createProvider` filters
 * `stored.models` by `model.provider === input.id`) would keep NOTHING —
 * the dynamic catalog would be lost after every restart. These
 * tests drive the REAL built provider end-to-end, exactly like pi's runtime:
 * refresh through `provider.refreshModels`, then a restart-style offline
 * restore from the persisted snapshot.
 */
test("native provider round-trip: a network refresh persists complete chat models that survive a restart", async () => {
	setMistralFetch((async () => new Response(JSON.stringify(modelListFixture()), { status: 200 })) as typeof fetch);
	try {
		// Phase 1: network refresh through the REAL provider's refreshModels
		// (the createProvider wrapper) — pi's own models.json override unset.
		const provider = buildMistralNativeProvider();
		assert.ok(provider.refreshModels, "createProvider must wrap fetchModels into refreshModels");
		const publications: { persist?: { models: readonly { id: string; provider?: string; baseUrl?: string; type?: string }[]; checkedAt?: number } | null | undefined }[] = [];
		let persisted: ModelsStoreEntry | undefined;
		await provider.refreshModels!({
			allowNetwork: true,
			signal: new AbortController().signal,
			credential: { type: "api_key", key: "test-key" },
			publish: async (publication) => {
				publications.push(publication);
				if (publication.persist === null) persisted = undefined;
				else if (publication.persist !== undefined) {
					persisted = structuredClone(publication.persist) as typeof persisted;
				}
				publication.update?.();
				return true;
			},
		});

		// At least one persist reached the store; the LAST one wins the slot.
		const persists = publications.filter((p) => p.persist !== undefined);
		assert.ok(persists.length > 0, "the refresh must persist the fetched catalog");
		const last = persists[persists.length - 1]!.persist!;
		// The regression guard: EVERY entry of the winning persist must be a
		// complete chat model — an entry without `provider` is dropped by the
		// next session's offline restore filter.
		assert.ok(last.models.length > 0, "the persisted catalog must not be empty");
		for (const model of last.models) {
			assert.equal(model.provider, "mistral-native", `persisted model ${model.id} must carry the provider id`);
			assert.equal(model.type, "chat", `persisted model ${model.id} must be typed chat`);
			assert.ok(
				typeof model.baseUrl === "string" && model.baseUrl.length > 0,
				`persisted model ${model.id} must carry a non-empty baseUrl`,
			);
		}
		assert.ok(
			last.models.some((model) => model.id === "codestral-latest"),
			"a fetched (non-static) model must be in the persisted catalog",
		);

		// Phase 2: restart — offline restore from the persisted snapshot through
		// a fresh provider instance (createProvider's restore path filters by
		// provider id; a static MODELS entry is restored too, so assert on a
		// FETCHED id that exists only in the snapshot).
		const restarted = buildMistralNativeProvider();
		await restarted.refreshModels!({
			allowNetwork: false,
			signal: new AbortController().signal,
			stored: persisted!,
			// pi's runtime runs publication.update() after persisting; the mock
			// must do the same or the provider-private dynamic list never fills.
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		const restoredIds = restarted.getModels().map((model) => model.id);
		assert.ok(
			restoredIds.includes("codestral-latest"),
			`the offline restore must keep the fetched catalog (got: ${restoredIds.join(", ")})`,
		);
	} finally {
		setMistralFetch();
	}
});

test("native provider round-trip: a network failure's last-known return must not clobber the snapshot with provider-less entries", async () => {
	// Secondary aspect of the same invariant: on network failure
	// refreshMistralModels returns lastKnown() — bare configs — and the
	// createProvider wrapper persists that return value; those entries must
	// be complete too, so a failed refresh cannot degrade the store.
	const provider = buildMistralNativeProvider();
	const publications: { persist?: { models: readonly { id: string; provider?: string }[] } | null | undefined }[] = [];
	let persisted: ModelsStoreEntry | undefined;
	// A stored snapshot with one complete model — what must survive.
	const snapshot: ModelsStoreEntry = {
		models: [storedModel("mistral-saba-latest", "Mistral Saba")],
		checkedAt: Date.now(),
	};
	setMistralFetch((async () => new Response("gateway unreachable", { status: 503 })) as typeof fetch);
	try {
		await provider.refreshModels!({
			allowNetwork: true,
			signal: new AbortController().signal,
			credential: { type: "api_key", key: "test-key" },
			stored: snapshot,
			publish: async (publication) => {
				publications.push(publication);
				if (publication.persist === null) persisted = undefined;
				else if (publication.persist !== undefined) {
					persisted = structuredClone(publication.persist) as typeof persisted;
				}
				publication.update?.();
				return true;
			},
		});

		// The 503 keeps the last-known catalog (restored snapshot) and the
		// wrapper persists the returned list — complete entries only.
		const persists = publications.filter((p) => p.persist !== undefined);
		const last = persists[persists.length - 1]?.persist;
		assert.ok(last, "the failed refresh still persists the returned last-known list");
		for (const model of last!.models) {
			assert.equal(model.provider, "mistral-native", `persisted model ${model.id} must carry the provider id`);
		}
		assert.ok(
			last!.models.some((model) => model.id === "mistral-saba-latest"),
			"the last-known (stored) model must survive in the persisted list",
		);
	} finally {
		setMistralFetch();
	}
});
