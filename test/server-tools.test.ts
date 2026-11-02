/**
 * Tests for server-side tools, connectors and agent mode.
 *
 * The SSE harness mirrors test/mistral.test.ts; the connector-tool HTTP
 * harness mirrors test/knowledge-tools.test.ts. All HTTP is mocked; no
 * network access, no real API keys ("test-key" literal only).
 *
 * The stream scenarios mirror the live-probed multi-message wire shape:
 * (1) delta.tool_calls[] carrying server-side metadata, often with
 * finish_reason "tool_calls" on the same chunk; (2) role:"tool" deltas
 * with tool_call_id carrying the executed result and
 * metadata.tool_call_result; (3) assistant text deltas; (4) a final
 * finish_reason "stop" chunk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Message, Model, TranscriptContext } from "@earendil-works/pi-ai";

import {
	MISTRAL_BASE_URL,
	MODELS,
	mistralStreamSimple,
} from "../extensions/mistral.js";
import {
	buildAgentsRequestBody,
	formatServerToolReport,
	parseServerToolsConfig,
	serverToolWireEntries,
} from "../extensions/mistral/server-tools.js";
import { createMistralClient } from "../extensions/tools/mistral-client.js";
import { createConnectorTools } from "../extensions/tools/connectors.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setMistralConfigForTests } from "../extensions/mistral/config.js";

// Force the no-file baseline for this suite: each test file runs in its own
// node --test process, so this module-top override keeps the stream tests
// env-only deterministic regardless of the developer's real
// mistral-native.json.
setMistralConfigForTests(null);

// =============================================================================
// SSE harness (mirrors test/mistral.test.ts)
// =============================================================================

type RegisteredModel = (typeof MODELS)[number];
type RuntimeModel = RegisteredModel & { provider: string; baseUrl: string };

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

function sseResponse(chunks: SseChunk[]): Response {
	const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
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

interface StreamOutcome {
	events: { type: string; [key: string]: unknown }[];
	message: Record<string, unknown> & { content: { type: string; [key: string]: unknown }[] };
}

/** Runs the stream against mocked SSE chunks with the given stream options. */
async function runStream(
	chunks: SseChunk[],
	options: {
		model?: RuntimeModel;
		messages?: Message[];
		streamOptions?: Record<string, unknown>;
	} = {},
): Promise<StreamOutcome> {
	const events: { type: string; [key: string]: unknown }[] = [];
	const model = options.model ?? makeModel();
	const context = options.messages
		? ({ messages: options.messages } as unknown as TranscriptContext)
		: CONTEXT;
	const stream = mistralStreamSimple(model as never, context, {
		apiKey: "test-key",
		fetch: () => Promise.resolve(sseResponse(chunks)),
		maxRetries: 0,
		...options.streamOptions,
	} as never);
	for await (const event of stream) events.push(event as never);
	const last = events[events.length - 1];
	assert.ok(last && (last.type === "done" || last.type === "error"), `stream ended with ${last?.type}`);
	return {
		events,
		message: ((last.type === "done" ? last.message : last.error) as StreamOutcome["message"])!,
	};
}

/** Runs the stream and additionally captures the outgoing request (URL + body). */
async function runCapturedStream(
	chunks: SseChunk[],
	streamOptions: Record<string, unknown> = {},
	messages?: Message[],
): Promise<{ outcome: StreamOutcome; url: string; body: Record<string, unknown> }> {
	let url = "";
	let body: Record<string, unknown> = {};
	const stream = mistralStreamSimple(makeModel() as never, messages ? ({ messages } as never) : CONTEXT, {
		apiKey: "test-key",
		fetch: async (requestUrl: unknown, init?: RequestInit) => {
			url = String(requestUrl);
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse(chunks);
		},
		maxRetries: 0,
		...streamOptions,
	} as never);
	const events: { type: string; [key: string]: unknown }[] = [];
	for await (const event of stream) events.push(event as never);
	const last = events[events.length - 1];
	assert.ok(last && (last.type === "done" || last.type === "error"), `stream ended with ${last?.type}`);
	return {
		outcome: { events, message: ((last.type === "done" ? last.message : last.error) as StreamOutcome["message"])! },
		url,
		body,
	};
}

// =============================================================================
// parseServerToolsConfig unit tests
// =============================================================================

test("parseServerToolsConfig: empty env yields no server execution", () => {
	const previousServerTools = process.env.MISTRAL_SERVER_TOOLS;
	const previousConnectors = process.env.MISTRAL_CONNECTORS;
	const previousAgentId = process.env.MISTRAL_AGENT_ID;
	delete process.env.MISTRAL_SERVER_TOOLS;
	delete process.env.MISTRAL_CONNECTORS;
	delete process.env.MISTRAL_AGENT_ID;
	try {
		const config = parseServerToolsConfig(undefined);
		assert.deepEqual(config.serverTools, []);
		assert.deepEqual(config.connectorIds, []);
		assert.equal(config.agentId, undefined);
		assert.equal(config.serverExecutionPossible, false);
	} finally {
		if (previousServerTools !== undefined) process.env.MISTRAL_SERVER_TOOLS = previousServerTools;
		if (previousConnectors !== undefined) process.env.MISTRAL_CONNECTORS = previousConnectors;
		if (previousAgentId !== undefined) process.env.MISTRAL_AGENT_ID = previousAgentId;
	}
});

test("parseServerToolsConfig: env overrides take precedence over process.env", () => {
	const previousServerTools = process.env.MISTRAL_SERVER_TOOLS;
	const previousAgentId = process.env.MISTRAL_AGENT_ID;
	process.env.MISTRAL_SERVER_TOOLS = "web_search";
	process.env.MISTRAL_AGENT_ID = "agent-from-process";
	try {
		const config = parseServerToolsConfig({ MISTRAL_SERVER_TOOLS: "image_generation" });
		assert.deepEqual(config.serverTools, ["image_generation"]);
		assert.equal(config.agentId, "agent-from-process");

		// An empty-string env value suppresses the process.env fallback.
		const suppressed = parseServerToolsConfig({ MISTRAL_SERVER_TOOLS: "" });
		assert.deepEqual(suppressed.serverTools, []);
	} finally {
		if (previousServerTools !== undefined) process.env.MISTRAL_SERVER_TOOLS = previousServerTools;
		else delete process.env.MISTRAL_SERVER_TOOLS;
		if (previousAgentId !== undefined) process.env.MISTRAL_AGENT_ID = previousAgentId;
		else delete process.env.MISTRAL_AGENT_ID;
	}
});

test("parseServerToolsConfig: comma and space separated lists; unknown server tools ignored", () => {
	const previous = process.env.MISTRAL_SERVER_TOOLS;
	const previousConnectors = process.env.MISTRAL_CONNECTORS;
	delete process.env.MISTRAL_SERVER_TOOLS;
	delete process.env.MISTRAL_CONNECTORS;
	try {
		const config = parseServerToolsConfig({
			MISTRAL_SERVER_TOOLS: "web_search, bogus_tool image_generation space_separated",
			MISTRAL_CONNECTORS: "notion, 8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f",
		});
		assert.deepEqual(config.serverTools, ["web_search", "image_generation"]);
		assert.deepEqual(config.connectorIds, ["notion", "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f"]);
		assert.equal(config.serverExecutionPossible, true);
	} finally {
		if (previous !== undefined) process.env.MISTRAL_SERVER_TOOLS = previous;
		if (previousConnectors !== undefined) process.env.MISTRAL_CONNECTORS = previousConnectors;
	}
});

test("formatServerToolReport renders name, arguments and result (and FAILED)", () => {
	assert.equal(
		formatServerToolReport("generate_image", '{"prompt":"cat"}', '{"url":"https://x/cat.png"}', false),
		'[Mistral server-side tool: generate_image — executed by Mistral]\n' +
			'Arguments: {"prompt":"cat"}\n' +
			'Result: {"url":"https://x/cat.png"}',
	);
	assert.equal(
		formatServerToolReport("web_search", "", undefined, true),
		"[Mistral server-side tool: web_search — executed by Mistral, FAILED]\n" +
			"Arguments: \n" +
			"Result: (no result returned)",
	);
});

test("serverToolWireEntries emits built-in entries then connector entries", () => {
	const config = parseServerToolsConfig({
		MISTRAL_SERVER_TOOLS: "web_search, image_generation",
		MISTRAL_CONNECTORS: "notion",
	});
	assert.deepEqual(serverToolWireEntries(config), [
		{ type: "web_search" },
		{ type: "image_generation" },
		{ type: "connector", connector_id: "notion" },
	]);
});

// =============================================================================
// Request mapping
// =============================================================================

test("MISTRAL_SERVER_TOOLS entries are appended after pi function tools", async () => {
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
	const { body } = await runCapturedStream(
		[chunk({ role: "assistant", content: "" }), finalChunk("stop")],
		{ env: { MISTRAL_SERVER_TOOLS: "web_search,image_generation" } },
		messages,
	);
	const tools = body.tools as { type: string; function?: { name: string }; connector_id?: string }[];
	assert.equal(tools.length, 3);
	assert.equal(tools[0]!.type, "function");
	assert.equal(tools[0]!.function!.name, "get_weather");
	assert.deepEqual(tools[1], { type: "web_search" });
	assert.deepEqual(tools[2], { type: "image_generation" });
});

test("MISTRAL_CONNECTORS maps to {type:\"connector\", connector_id} entries", async () => {
	const uuid = "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f";
	const { body } = await runCapturedStream([chunk({ role: "assistant", content: "" }), finalChunk("stop")], {
		env: { MISTRAL_CONNECTORS: `notion,${uuid}` },
	});
	const tools = body.tools as { type: string; connector_id?: string }[];
	assert.deepEqual(tools, [
		{ type: "connector", connector_id: "notion" },
		{ type: "connector", connector_id: uuid },
	]);
});

test("unknown MISTRAL_SERVER_TOOLS values are ignored without throwing", async () => {
	const { body } = await runCapturedStream([chunk({ role: "assistant", content: "hi" }), finalChunk("stop")], {
		env: { MISTRAL_SERVER_TOOLS: "totally_unknown,also-bogus" },
	});
	assert.equal(body.tools, undefined, "no server entries and no function tools -> no tools array");
	const outcome = await runStream([chunk({ role: "assistant", content: "hi" }), finalChunk("stop")], {
		streamOptions: { env: { MISTRAL_SERVER_TOOLS: "totally_unknown" } },
	});
	assert.equal(outcome.message.stopReason, "stop");
});

test("no server-tool env: regression pin — request carries no extra tool entries", async () => {
	const { body } = await runCapturedStream([chunk({ role: "assistant", content: "" }), finalChunk("stop")], {
		env: {},
	});
	assert.equal(body.tools, undefined);
	assert.equal(body.model, "mistral-large-4");
	assert.deepEqual(body.stream_options, { include_usage: true });
	// The pre-existing request shape is pinned by its exact keys.
	assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "reasoning_effort", "stream", "stream_options"]);
});

// =============================================================================
// Server-execution folding
// =============================================================================

/** A recorded live server-execution stream (image_generation, 2026-10-30 probe). */
function serverExecutionChunks(options: { failed?: boolean; withResult?: boolean; finishToolCalls?: boolean } = {}): SseChunk[] {
	const { failed = false, withResult = true, finishToolCalls = true } = options;
	const chunks: SseChunk[] = [
		chunk({ role: "assistant", content: "" }),
		chunk({
			content: "",
			tool_calls: [
				{
					index: 0,
					id: "call_server_1",
					type: "function",
					function: { name: "generate_image", arguments: '{"prompt":"a cat"}' },
					metadata: { tool_type: "image_generation", integration_id: "mistral", locale: null },
				},
			],
			...(finishToolCalls ? { finish_reason: "tool_calls" } : {}),
		}),
	];
	if (withResult) {
		chunks.push(
			chunk({
				role: "tool",
				tool_call_id: "call_server_1",
				content: failed ? "Image generation failed: safety filter" : '{"url":"https://images.mistral.ai/cat.png"}',
				metadata: failed
					? { tool_call_result: { type: "error", errors: [{ code: "safety_filter" }] } }
					: { tool_call_result: { type: "success" } },
			}),
		);
	}
	chunks.push(chunk({ role: "assistant", content: "Here" }), chunk({ content: " is your cat." }));
	chunks.push(finalChunk("stop"));
	return chunks;
}

test("server execution folds into text blocks, never toolCall blocks", async () => {
	const outcome = await runStream(serverExecutionChunks(), {
		streamOptions: { env: { MISTRAL_SERVER_TOOLS: "image_generation" } },
	});
	const { message, events } = outcome;
	assert.ok(!message.content.some((block) => block.type === "toolCall"), "no toolCall block may exist");
	const reportBlock = message.content.find(
		(block) => block.type === "text" && String(block.text).includes("[Mistral server-side tool:"),
	);
	assert.ok(reportBlock, "a text block with the server tool report must exist");
	const report = String(reportBlock.text);
	assert.match(report, /generate_image/);
	assert.match(report, /https:\/\/images\.mistral\.ai\/cat\.png/);
	assert.match(report, /executed by Mistral\]/);
	assert.equal(message.stopReason, "stop");
	// Balanced text events for the folded block (fresh block; full text in one delta).
	const types = events.map((event) => event.type);
	const textStarts = types.filter((t) => t === "text_start").length;
	const textEnds = types.filter((t) => t === "text_end").length;
	assert.equal(textStarts, textEnds);
	assert.equal(types.filter((t) => t === "done" || t === "error").length, 1);
	// Ordering pin: the folded report block's start/delta/end
	// share one contentIndex, that index sits strictly between the surrounding
	// text blocks' indices, and no event for another index interleaves between
	// its start and its end.
	const textBlocks = message.content.filter((block) => block.type === "text");
	const reportIndex = textBlocks.indexOf(reportBlock);
	const reportContentIndex = message.content.indexOf(reportBlock);
	if (reportIndex > 0) {
		const leadingIndex = message.content.indexOf(textBlocks[reportIndex - 1]!);
		assert.ok(
			leadingIndex < reportContentIndex,
			"report index must be greater than the first assistant text block's (if any)",
		);
	}
	if (reportIndex < textBlocks.length - 1) {
		const trailingIndex = message.content.indexOf(textBlocks[reportIndex + 1]!);
		assert.ok(reportContentIndex < trailingIndex, "report index must be less than the final text block's");
	}
	const reportEvents = events.filter((event) => event.contentIndex === reportContentIndex);
	assert.deepEqual(
		reportEvents.map((event) => event.type),
		["text_start", "text_delta", "text_end"],
		"the folded report emits exactly start→delta→end on its own index",
	);
	// No other-index event may interleave between the report's start and end.
	const startAt = events.findIndex(
		(event) => event.type === "text_start" && event.contentIndex === reportContentIndex,
	);
	const endAt = events.findIndex(
		(event) => event.type === "text_end" && event.contentIndex === reportContentIndex,
	);
	assert.ok(startAt !== -1 && endAt !== -1 && startAt < endAt);
	for (const event of events.slice(startAt + 1, endAt)) {
		assert.equal(event.contentIndex, reportContentIndex, "no interleaved event for another index inside the report block");
	}
});

test("failed server executions mark the report FAILED", async () => {
	const outcome = await runStream(serverExecutionChunks({ failed: true }), {
		streamOptions: { env: { MISTRAL_SERVER_TOOLS: "image_generation" } },
	});
	const report = outcome.message.content
		.filter((block) => block.type === "text")
		.map((block) => String(block.text))
		.join("\n");
	assert.match(report, /FAILED/);
	assert.match(report, /safety filter/);
	assert.ok(!outcome.message.content.some((block) => block.type === "toolCall"));
});

test("server call with metadata but no result folds at finalization with (no result returned)", async () => {
	const outcome = await runStream(serverExecutionChunks({ withResult: false }), {
		streamOptions: { env: { MISTRAL_SERVER_TOOLS: "image_generation" } },
	});
	const report = outcome.message.content
		.filter((block) => block.type === "text")
		.map((block) => String(block.text))
		.join("\n");
	assert.match(report, /generate_image/);
	assert.match(report, /\(no result returned\)/);
	assert.ok(!outcome.message.content.some((block) => block.type === "toolCall"));
});

test("client function calls in server-tools mode still become toolCall blocks", async () => {
	const outcome = await runStream(
		[
			chunk({ role: "assistant", content: null }),
			chunk({
				content: null,
				tool_calls: [
					{ index: 0, id: "call_client_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } },
				],
			}),
			chunk({ content: null, tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
			finalChunk("tool_calls"),
		],
		{ streamOptions: { env: { MISTRAL_SERVER_TOOLS: "web_search" } } },
	);
	const { message, events } = outcome;
	const toolCall = message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall, "client call must become a toolCall block");
	assert.equal((toolCall as unknown as { name: string }).name, "get_weather");
	assert.deepEqual((toolCall as unknown as { arguments: Record<string, string> }).arguments, { city: "Paris" });
	assert.equal(message.stopReason, "toolUse");
	// Balanced toolcall events; arguments parsed by toolcall_end.
	const toolTypes = events.map((event) => event.type).filter((t) => t.startsWith("toolcall"));
	assert.deepEqual(toolTypes, ["toolcall_start", "toolcall_delta", "toolcall_end"]);
	const end = events.find((event) => event.type === "toolcall_end")!;
	assert.deepEqual((end.toolCall as { arguments: Record<string, string> }).arguments, { city: "Paris" });
});

test("mixed server execution and client call: stopReason stays toolUse", async () => {
	const outcome = await runStream(
		[
			chunk({ role: "assistant", content: null }),
			chunk({
				content: "",
				tool_calls: [
					{
						index: 0,
						id: "call_server_1",
						type: "function",
						function: { name: "web_search", arguments: '{"query":"cats"}' },
						metadata: { tool_type: "web_search" },
					},
				],
			}),
			chunk({
				role: "tool",
				tool_call_id: "call_server_1",
				content: '{"results":["cat facts"]}',
				metadata: { tool_call_result: { type: "success" } },
			}),
			chunk({
				content: null,
				tool_calls: [
					{ index: 1, id: "call_client_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
				],
			}),
			finalChunk("tool_calls"),
		],
		{ streamOptions: { env: { MISTRAL_SERVER_TOOLS: "web_search" } } },
	);
	const { message } = outcome;
	const report = message.content
		.filter((block) => block.type === "text")
		.map((block) => String(block.text))
		.join("\n");
	assert.match(report, /web_search/);
	assert.match(report, /cat facts/);
	const toolCall = message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall, "client call must become a toolCall block");
	assert.equal(message.stopReason, "toolUse");
});

test("mid-stream finish_reason tool_calls with only server calls remaps to stop", async () => {
	const outcome = await runStream(
		[
			chunk({ role: "assistant", content: "" }),
			chunk({
				content: "",
				tool_calls: [
					{
						index: 0,
						id: "call_server_1",
						type: "function",
						function: { name: "web_search", arguments: '{"query":"cats"}' },
						metadata: { tool_type: "web_search" },
					},
				],
				finish_reason: "tool_calls",
			}),
			chunk({
				role: "tool",
				tool_call_id: "call_server_1",
				content: '{"results":[]}',
				metadata: { tool_call_result: { type: "success" } },
			}),
			chunk({ role: "assistant", content: "All done." }),
			finalChunk("stop"),
		],
		{ streamOptions: { env: { MISTRAL_SERVER_TOOLS: "web_search" } } },
	);
	assert.equal(outcome.message.stopReason, "stop");
	assert.ok(!outcome.message.content.some((block) => block.type === "toolCall"));
});

test("no env: client tool calls still become toolCall blocks (regression)", async () => {
	const outcome = await runStream(
		[
			chunk({ role: "assistant", content: null }),
			chunk({
				content: null,
				tool_calls: [
					{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
				],
			}),
			finalChunk("tool_calls"),
		],
		{ streamOptions: { env: {} } },
	);
	const toolCall = outcome.message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall, "no server tools configured: unchanged tool-call path");
	assert.equal(outcome.message.stopReason, "toolUse");
});

test("a result delta arriving before its tool_calls delta still folds the report", async () => {
	// Result-before-call wire ordering — the buffered result
	// must fold the candidate as soon as the call delta arrives.
	const outcome = await runStream(
		[
			chunk({ role: "assistant", content: "" }),
			chunk({
				role: "tool",
				tool_call_id: "call_server_1",
				content: '{"url":"https://images.mistral.ai/cat.png"}',
				metadata: { tool_call_result: { type: "success" } },
			}),
			chunk({
				content: "",
				tool_calls: [
					{
						index: 0,
						id: "call_server_1",
						type: "function",
						function: { name: "generate_image", arguments: '{"prompt":"a cat"}' },
						metadata: { tool_type: "image_generation" },
					},
				],
			}),
			chunk({ role: "assistant", content: "Here is your cat." }),
			finalChunk("stop"),
		],
		{ streamOptions: { env: { MISTRAL_SERVER_TOOLS: "image_generation" } } },
	);
	const { message } = outcome;
	assert.ok(!message.content.some((block) => block.type === "toolCall"), "no toolCall block may exist");
	const report = message.content
		.filter((block) => block.type === "text")
		.map((block) => String(block.text))
		.join("\n");
	assert.match(report, /\[Mistral server-side tool: generate_image/);
	assert.match(report, /https:\/\/images\.mistral\.ai\/cat\.png/);
	assert.equal(message.stopReason, "stop");
});

test("a result with an unknown tool_call_id folds an anonymous report", async () => {
	// A result whose id never matches a candidate must not be
	// dropped; it folds as an anonymous "(unknown)" report at finalization.
	const outcome = await runStream(
		[
			chunk({ role: "assistant", content: "" }),
			chunk({
				role: "tool",
				tool_call_id: "call_never_seen",
				content: '{"results":["orphaned result"]}',
				metadata: { tool_call_result: { type: "success" } },
			}),
			chunk({ role: "assistant", content: "Done." }),
			finalChunk("stop"),
		],
		{ streamOptions: { env: { MISTRAL_SERVER_TOOLS: "web_search" } } },
	);
	const { message } = outcome;
	assert.ok(!message.content.some((block) => block.type === "toolCall"), "no toolCall block may exist");
	const anonymous = message.content.find(
			(block) => block.type === "text" && String(block.text).includes("[Mistral server-side tool: (unknown)"),
	);
	assert.ok(anonymous, "an anonymous (unknown) report text block must appear");
	assert.match(String(anonymous.text), /orphaned result/);
	assert.equal(message.stopReason, "stop");
});

test("a client call's name is backfilled from a later delta in server-tools mode", async () => {
	// The first delta carries id+arguments but no function.name; the
	// second delta (same index) carries the name and more arguments. The
	// materialized client toolCall block must have the backfilled name and
	// the fully parsed arguments.
	const outcome = await runStream(
		[
			chunk({ role: "assistant", content: null }),
			chunk({
				content: null,
				tool_calls: [{ index: 0, id: "call_client_1", type: "function", function: { arguments: '{"city":' } }],
			}),
			chunk({
				content: null,
				tool_calls: [{ index: 0, type: "function", function: { name: "get_weather", arguments: '"Paris"}' } }],
			}),
			finalChunk("tool_calls"),
		],
		{ streamOptions: { env: { MISTRAL_SERVER_TOOLS: "web_search" } } },
	);
	const toolCall = outcome.message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall, "client call must become a toolCall block");
	assert.equal((toolCall as unknown as { name: string }).name, "get_weather");
	assert.deepEqual((toolCall as unknown as { arguments: Record<string, string> }).arguments, { city: "Paris" });
	assert.equal(outcome.message.stopReason, "toolUse");
});

test("abort mid-stream with a pending server candidate leaks no scratch into the error", async () => {
	// A candidate accumulated but not yet folded (no result,
	// no metadata) must not leak into the aborted error output — no
	// partialArgs text and no un-folded report fragment.
	const controller = new AbortController();
	const events: { type: string; [key: string]: unknown }[] = [];
	const candidateChunk = chunk({
			content: "",
			tool_calls: [
				{
					index: 0,
					id: "call_pending_1",
					type: "function",
					function: { name: "web_search", arguments: '{"query":"secret pending arguments"}' },
				},
			],
		});
	const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(candidateChunk)}\n\n`));
				// No result delta, no close: the consumer aborts mid-stream.
			},
		});
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
			apiKey: "test-key",
			signal: controller.signal,
			env: { MISTRAL_SERVER_TOOLS: "web_search" },
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
	const error = last.error as { stopReason: string; content: { type: string; text?: string }[]; errorMessage?: string };
	assert.equal(error.stopReason, "aborted");
	// No pending-candidate scratch may leak: no partial arguments text, no
	// report fragment, no toolCall block for the un-folded call.
	const serialized = JSON.stringify(error.content) + (error.errorMessage ?? "");
	assert.ok(!serialized.includes("secret pending arguments"), "partialArgs leaked into the aborted output");
	assert.ok(!serialized.includes("[Mistral server-side tool:"), "an un-folded report fragment leaked");
	assert.ok(!error.content.some((block) => block.type === "toolCall"), "pending candidate leaked as a toolCall block");
});

// =============================================================================
// Agent mode (/v1/agents/completions)
// =============================================================================

test("agent mode posts a minimal body to /v1/agents/completions", async () => {
	const { url, body } = await runCapturedStream([chunk({ role: "assistant", content: "ok" }), finalChunk("stop")], {
		env: { MISTRAL_AGENT_ID: "agent-123" },
		maxTokens: 512,
	});
	assert.equal(url, `${MISTRAL_BASE_URL}/agents/completions`);
	assert.equal(body.agent_id, "agent-123");
	assert.equal(body.stream, true);
	assert.equal(typeof body.messages, "object");
	assert.equal(body.model, undefined);
	assert.equal(body.temperature, undefined);
	assert.equal(body.stream_options, undefined);
	assert.equal(body.tools, undefined);
	assert.equal(body.reasoning_effort, undefined);
	assert.deepEqual(Object.keys(body).sort(), ["agent_id", "max_tokens", "messages", "stream"]);
	assert.equal(body.max_tokens, 512);
});

test("agent mode without explicit maxTokens sends the ceiling-clamped default", async () => {
	// Without options.maxTokens the clamp falls back to the model's
	// maxTokens (262144, the wire-enforced completion ceiling for
	// mistral-large-4 under the documented max-output mapping). The prompt
	// does not count against the completion ceiling, so the request sends
	// exactly the ceiling.
	const { body } = await runCapturedStream([chunk({ role: "assistant", content: "ok" }), finalChunk("stop")], {
		env: { MISTRAL_AGENT_ID: "agent-123" },
	});
	assert.equal(body.max_tokens, 262144);
	assert.deepEqual(Object.keys(body).sort(), ["agent_id", "max_tokens", "messages", "stream"]);
});

test("agent mode still assembles streamed content", async () => {
	const outcome = await runStream(
		[chunk({ role: "assistant", content: "Hi" }), chunk({ content: " there" }), finalChunk("stop")],
		{ streamOptions: { env: { MISTRAL_AGENT_ID: "agent-123" } } },
	);
	assert.equal(outcome.message.content[0]!.text, "Hi there");
	assert.equal(outcome.message.stopReason, "stop");
});

// =============================================================================
// Connector tools (mocked HTTP, harness mirrors test/knowledge-tools.test.ts)
// =============================================================================

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	signal?: AbortSignal | undefined;
}

function createMockFetch() {
	const requests: RecordedRequest[] = [];
	let responseIndex = 0;
	const responses: { status: number; body: string }[] = [];

	const mockFetch = (async (_url: unknown, init?: RequestInit) => {
		const url = String(_url);
		requests.push({
			url,
			method: init?.method ?? "GET",
			headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
			body: init?.body,
			signal: init?.signal ?? undefined,
		});
		const response = responses[responseIndex++];
		if (!response) {
			throw new Error(`unexpected request #${responseIndex - 1} to ${url}`);
		}
		return new Response(response.body, {
			status: response.status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	return {
		mockFetch,
		requests,
		respond(status: number, body: unknown) {
			responses.push({ status, body: typeof body === "string" ? body : JSON.stringify(body) });
		},
	};
}

function buildConnectorTools(mockFetch: typeof fetch) {
	return createConnectorTools({
		getClient: async () => createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch }),
	});
}

function toolByName(tools: ToolDefinition<any, any>[], name: string) {
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `tool ${name} must exist`);
	return tool;
}

async function execute(tool: ToolDefinition<any, any>, params: unknown, signal?: AbortSignal) {
	const result = await tool.execute("call-1", params as never, signal, undefined, undefined as never);
	return result as {
		content: { type: string; text?: string }[];
		structuredContent?: Record<string, unknown>;
		details?: unknown;
		isError?: boolean;
	};
}

test("mistral_connector_list maps items and next_cursor", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		items: [
			{
				id: "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f",
				name: "notion",
				description: "Notion workspace integration",
				owner_type: "user",
				visibility: "private",
				protocol: "mcp",
			},
			{
				id: "9c7c4f3e-1a2b-4b3f-8d2f-1b3c4d5e6f70",
				name: "gdrive",
				owner_type: "user",
				visibility: "private",
				protocol: "http",
			},
		],
		pagination: { next_cursor: "cursor-2", page_size: 2 },
	});
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_list"), { cursor: "cursor-1", pageSize: 50 });

	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "GET");
	const url = new URL(request.url);
	assert.equal(url.pathname, "/v1/connectors");
	assert.equal(url.searchParams.get("cursor"), "cursor-1");
	assert.equal(url.searchParams.get("page_size"), "50");
	assert.equal(request.headers.Authorization, "Bearer test-key");
	const connectors = result.structuredContent?.connectors as { id: string; name: string }[];
	assert.equal(connectors?.length, 2);
	assert.equal(connectors?.[0]?.name, "notion");
	assert.equal(result.structuredContent?.nextCursor, "cursor-2");
	const text = String(result.content[0]?.text);
	assert.match(text, /- notion \(8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f\): Notion workspace integration/);
});

test("mistral_connector_list maps a missing next_cursor to null", async () => {
	const mock = createMockFetch();
	mock.respond(200, { items: [], pagination: {} });
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_list"), {});
	assert.equal(result.structuredContent?.nextCursor, null);
	assert.match(String(result.content[0]?.text), /No connectors found/);
});

test("mistral_connector_tools maps the bare tool array", async () => {
	const mock = createMockFetch();
	mock.respond(200, [
		{
			id: "tool-1",
			name: "search_notion",
			description: "Search Notion pages",
			inputSchema: { type: "object", properties: { query: { type: "string" } } },
			visibility: "private",
			created_at: "2026-10-30T00:00:00Z",
			modified_at: "2026-10-30T00:00:00Z",
		},
		{ id: "tool-2", name: "create_page", inputSchema: { type: "object" } },
	]);
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_tools"), { connectorIdOrName: "notion" });

	const request = mock.requests[0];
	assert.ok(request);
	assert.ok(request.url.endsWith("/v1/connectors/notion/tools"), `unexpected url ${request.url}`);
	const mapped = result.structuredContent?.tools as { name: string; description?: string }[];
	assert.equal(mapped?.length, 2);
	assert.equal(mapped?.[0]?.name, "search_notion");
	assert.equal(mapped?.[0]?.description, "Search Notion pages");
	assert.equal(mapped?.[1]?.description, undefined);
	const text = String(result.content[0]?.text);
	assert.match(text, /- search_notion: Search Notion pages/);
	assert.match(text, /- create_page: \(no description\)/);
});

test("mistral_connector_auth_url maps auth_url/ttl and keeps the URL out of details", async () => {
	const mock = createMockFetch();
	mock.respond(200, { auth_url: "https://auth.mistral.ai/oauth/notion?state=abc123", ttl: 600 });
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_auth_url"), {
		connectorIdOrName: "notion",
		appReturnUrl: "https://example.com/return",
	});

	const request = mock.requests[0];
	assert.ok(request);
	const url = new URL(request.url);
	assert.equal(url.pathname, "/v1/connectors/notion/auth_url");
	assert.equal(url.searchParams.get("app_return_url"), "https://example.com/return");
	assert.equal(result.structuredContent?.authUrl, "https://auth.mistral.ai/oauth/notion?state=abc123");
	assert.equal(result.structuredContent?.ttl, 600);
	const text = String(result.content[0]?.text);
	assert.match(text, /valid for 600 seconds/);
	assert.match(text, /https:\/\/auth\.mistral\.ai\/oauth\/notion\?state=abc123/);
	assert.match(text, /stored on Mistral's side/);
	// SECURITY: the bearer URL must never appear in details (logs/transcripts).
	assert.doesNotMatch(JSON.stringify(result.details), /auth\.mistral\.ai/);
	assert.deepEqual(result.details, { connectorIdOrName: "notion" });
});

test("mistral_connector_auth_url omits the app_return_url query param when not given", async () => {
	const mock = createMockFetch();
	mock.respond(200, { auth_url: "https://auth.mistral.ai/oauth/notion?state=xyz", ttl: 600 });
	const tools = buildConnectorTools(mock.mockFetch);
	await execute(toolByName(tools, "mistral_connector_auth_url"), { connectorIdOrName: "notion" });
	const url = new URL(mock.requests[0]!.url);
	assert.equal(url.searchParams.get("app_return_url"), null);
});

test("mistral_connector_activate posts to the consumer-scope activate path", async () => {
	const mock = createMockFetch();
	mock.respond(200, { message: "Connector activated successfully." });
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_activate"), {
		connectorId: "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f",
		consumerScope: "workspace",
	});
	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "POST");
	assert.ok(
		request.url.endsWith("/v1/connectors/8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f/workspace/activate"),
		`unexpected url ${request.url}`,
	);
	assert.equal(result.structuredContent?.message, "Connector activated successfully.");
	assert.match(String(result.content[0]?.text), /activated successfully/);
});

test("mistral_connector_activate defaults the consumer scope to user", async () => {
	const mock = createMockFetch();
	mock.respond(200, { message: "Connector activated successfully." });
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_activate"), {
		connectorId: "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f",
	});
	assert.ok(mock.requests[0]?.url.endsWith("/v1/connectors/8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f/user/activate"));
	assert.equal(result.isError, undefined);
});

test("mistral_connector_deactivate posts to the consumer-scope deactivate path", async () => {
	const mock = createMockFetch();
	mock.respond(200, { message: "Connector deactivated successfully." });
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_deactivate"), {
		connectorId: "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f",
		consumerScope: "organization",
	});
	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "POST");
	assert.ok(request.url.endsWith("/v1/connectors/8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f/organization/deactivate"));
	assert.equal(result.structuredContent?.message, "Connector deactivated successfully.");
});

test("mistral_connector_share uses PUT on the share path", async () => {
	const mock = createMockFetch();
	mock.respond(200, { message: "Connector shared successfully." });
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_share"), {
		connectorId: "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f",
	});
	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "PUT");
	assert.ok(request.url.endsWith("/v1/connectors/8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f/share"));
	assert.equal(result.structuredContent?.message, "Connector shared successfully.");
});

test("mistral_connector_unshare uses DELETE on the share path", async () => {
	const mock = createMockFetch();
	mock.respond(200, { message: "Connector unshared successfully." });
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_unshare"), {
		connectorId: "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f",
	});
	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "DELETE");
	assert.ok(request.url.endsWith("/v1/connectors/8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f/share"));
	assert.equal(result.structuredContent?.message, "Connector unshared successfully.");
});

test("a 401 detail from connector tools surfaces as isError with the server message", async () => {
	const mock = createMockFetch();
	mock.respond(401, { detail: "No credentials found for connector 'notion'. Please authenticate." });
	const tools = buildConnectorTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_connector_tools"), { connectorIdOrName: "notion" });
	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /401/);
	assert.match(text, /No credentials found for connector 'notion'\. Please authenticate\./);
	assert.doesNotMatch(text, /test-key/);
});

test("buildAgentsRequestBody returns exactly agent_id, messages, stream (+max_tokens)", () => {
	const messages = [{ role: "user", content: "hi" }];
	assert.deepEqual(buildAgentsRequestBody(messages, "agent-1", undefined), {
		agent_id: "agent-1",
		messages,
		stream: true,
	});
	assert.deepEqual(buildAgentsRequestBody(messages, "agent-1", 256), {
		agent_id: "agent-1",
		messages,
		stream: true,
		max_tokens: 256,
	});
});
