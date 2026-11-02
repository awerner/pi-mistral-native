/**
 * Integration-scenario tests for the native `mistral-chat` streamSimple
 * implementation — the custom-provider.md "Test the integration"
 * checklist gaps left by test/mistral.test.ts.
 *
 * test/mistral.test.ts covers the repro scenarios and the event,
 * usage, abort, overflow, and error paths. This suite covers the request
 * mapping corners that only surface with mixed transcripts and model
 * shapes: image input and image tool results, orphaned tool calls after an
 * abort, cross-provider session handoff (foreign-api assistant and tool
 * results replay instead of being dropped), capability-gated image
 * support, reasoning replay suppression, zeroed usage without a usage
 * chunk, and the max_tokens context clamp.
 *
 * All provider HTTP is a mocked fetch returning an SSE `Response`; no
 * network access, no real keys ("test-key" literal only).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AssistantMessage, Message, Model, TranscriptContext } from "@earendil-works/pi-ai";

import { MISTRAL_BASE_URL, MODELS, mistralStreamSimple } from "../extensions/mistral.js";
import { setMistralConfigForTests } from "../extensions/mistral/config.js";

// Force the no-file baseline for this suite: each test file runs in its own
// node --test process, so this module-top override keeps the stream tests
// env-only deterministic regardless of the developer's real
// mistral-native.json.
setMistralConfigForTests(null);

// =============================================================================
// Harness (mirror of test/mistral.test.ts, trimmed to the capture pattern)
// =============================================================================

type RegisteredModel = (typeof MODELS)[number];

/** The model shape the runtime passes to streamSimple (registration-enriched). */
type RuntimeModel = RegisteredModel & { provider: string; baseUrl: string };

function makeModel(overrides: Partial<RuntimeModel> = {}): RuntimeModel {
	return {
		...MODELS[0]!,
		provider: "mistral-native",
		baseUrl: MISTRAL_BASE_URL,
		...overrides,
	};
}

type SseChunk = Record<string, unknown>;

function sseResponse(chunks: SseChunk[]): Response {
	const body =
		chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chunk = (delta: Record<string, unknown>): SseChunk => ({
	id: "integration-1",
	object: "chat.completion.chunk",
	created: 1793048657,
	model: "mistral-large-4",
	choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
});

const finalChunk = (finishReason: string | null): SseChunk => ({
	id: "integration-1",
	object: "chat.completion.chunk",
	created: 1793048657,
	model: "mistral-large-4",
	choices: [{ index: 0, delta: {}, finish_reason: finishReason, logprobs: null }],
});

const okChunks = (): SseChunk[] => [chunk({ role: "assistant", content: "" }), finalChunk("stop")];

interface WireMessage {
	role: string;
	content: unknown;
	tool_calls?: { id: string; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
	name?: string;
}

/**
 * Run streamSimple against a mocked fetch and return the captured request
 * body and the final assistant message (from the terminal event).
 */
async function runCapture(
	messages: Message[],
	options: { model?: RuntimeModel; streamOptions?: Record<string, unknown> } = {},
): Promise<{ body: Record<string, unknown>; message: Record<string, unknown> }> {
	let captured: Record<string, unknown> | undefined;
	let terminal: Record<string, unknown> | undefined;
	const model = options.model ?? makeModel();
	const stream = mistralStreamSimple(model as never, { messages } as unknown as TranscriptContext, {
		apiKey: "test-key",
		maxRetries: 0,
		...options.streamOptions,
		fetch: async (_url: unknown, init?: RequestInit) => {
			assert.ok(!captured, "fetch must be called exactly once");
			captured = JSON.parse(String(init!.body)) as Record<string, unknown>;
			return sseResponse(okChunks());
		},
	} as never);
	for await (const event of stream) {
		const type = (event as { type: string }).type;
		if (type === "done" || type === "error") {
			assert.ok(!terminal, "exactly one terminal event");
			terminal = event as Record<string, unknown>;
		}
	}
	assert.ok(captured, "request was not sent");
	assert.ok(terminal, "stream produced no terminal event");
	const message = (terminal.type === "done" ? terminal.message : terminal.error) as Record<string, unknown>;
	assert.ok(message, "terminal event carried no message");
	return { body: captured!, message };
}

const wireMessages = (body: Record<string, unknown>): WireMessage[] =>
	body.messages as WireMessage[];

// =============================================================================
// Shared transcript fixtures
// =============================================================================

const SYSTEM: Message = { role: "system", content: "You are a test harness.", timestamp: 1 };

function userMessage(content: Message["role"] extends never ? never : string | (Message & { role: "user" })["content"], timestamp: number): Message {
	return { role: "user", content, timestamp };
}

function imageContent(): { type: "image"; data: string; mimeType: string } {
	return { type: "image", data: "aXBtZy1ieXRlcw==", mimeType: "image/png" };
}

function assistantToolCall(
	options: { api?: string; provider?: string; stopReason?: AssistantMessage["stopReason"] } = {},
): Message {
	const { api = "mistral-chat", provider = "mistral-native", stopReason = "toolUse" } = options;
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Let me check." },
			{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
		],
		api,
		provider,
		model: "mistral-large-4",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 3,
	};
}

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function toolResult(content: ContentBlock[], toolCallId = "call_1"): Message {
	return { role: "toolResult", toolCallId, toolName: "get_weather", content, isError: false, timestamp: 4 };
}

// =============================================================================
// Image input (custom-provider.md: image input when supported)
// =============================================================================

test("user image blocks map to data-URL image_url parts in the request", async () => {
	const { body } = await runCapture([
		SYSTEM,
		userMessage([
			{ type: "text", text: "What is in this picture?" },
			imageContent(),
		], 2),
	]);
	const wire = wireMessages(body);
	assert.deepEqual(wire.map((m) => m.role), ["system", "user"]);
	const content = wire[1]!.content as { type: string; text?: string; image_url?: { url: string } }[];
	assert.deepEqual(
		content.map((part) => part.type),
		["text", "image_url"],
	);
	assert.equal(content[0]!.text, "What is in this picture?");
	assert.equal(content[1]!.image_url?.url, "data:image/png;base64,aXBtZy1ieXRlcw==");
});

test("a text-only model (input: [\"text\"]) drops user image blocks", async () => {
	const { body } = await runCapture(
		[
			SYSTEM,
			userMessage([{ type: "text", text: "Look at this." }, imageContent()], 2),
		],
		{ model: makeModel({ input: ["text"] }) },
	);
	const wire = wireMessages(body);
	const content = wire[1]!.content as { type: string }[];
	// The image part is silently skipped; the text part survives.
	assert.deepEqual(content.map((part) => part.type), ["text"]);
});

// =============================================================================
// Image tool results (custom-provider.md: image tool results when supported)
// =============================================================================

test("image tool results replay as a following user message with image_url parts", async () => {
	const { body } = await runCapture([
		SYSTEM,
		userMessage("Weather in Paris?", 2),
		assistantToolCall(),
		toolResult([
			{ type: "text", text: "" },
			imageContent(),
		]),
	]);
	const wire = wireMessages(body);
	assert.deepEqual(
		wire.map((m) => m.role),
		["system", "user", "assistant", "tool", "user"],
		"a following user message carries the tool-result images",
	);
	// The tool message itself gets the placeholder (no useful text).
	assert.equal(wire[3]!.content, "(see attached image)");
	// The following user message: caption text + data-URL image part.
	const attached = wire[4]!.content as { type: string; text?: string; image_url?: { url: string } }[];
	assert.equal(attached[0]!.type, "text");
	assert.equal(attached[0]!.text, "Attached image(s) from tool result:");
	assert.equal(attached[1]!.type, "image_url");
	assert.equal(attached[1]!.image_url?.url, "data:image/png;base64,aXBtZy1ieXRlcw==");
});

test("a text-only model keeps the tool placeholder but sends no tool-result images", async () => {
	const { body } = await runCapture(
		[
			SYSTEM,
			userMessage("Weather in Paris?", 2),
			assistantToolCall(),
			toolResult([imageContent()]),
		],
		{ model: makeModel({ input: ["text"] }) },
	);
	const wire = wireMessages(body);
	// No trailing user message: image collection is capability-gated.
	assert.deepEqual(
		wire.map((m) => m.role),
		["system", "user", "assistant", "tool"],
	);
	assert.equal(wire[3]!.content, "(see attached image)");
});

// =============================================================================
// Orphaned tool calls (abort survival: replay after a tool call with no result)
// =============================================================================

test("orphaned tool calls get a synthetic empty tool result in the replay", async () => {
	const { body } = await runCapture([
		SYSTEM,
		userMessage("Weather in Paris?", 2),
		assistantToolCall({ stopReason: "aborted" }),
		// No toolResult follows: the turn was aborted after the tool call.
		// stopReason "aborted" pins the aborted-turn replay shape (an aborted
		// turn is NOT skipped when it carries a tool call).
	]);
	const wire = wireMessages(body);
	assert.deepEqual(
		wire.map((m) => m.role),
		["system", "user", "assistant", "tool"],
	);
	const synthetic = wire[3]!;
	assert.equal(synthetic.tool_call_id, "call_1");
	assert.equal(synthetic.content, "(no tool output)");
	// The assistant message keeps its tool_calls for the server to match.
	const toolCalls = wire[2]!.tool_calls!;
	assert.equal(toolCalls[0]!.id, "call_1");
});

// =============================================================================
// Cross-provider session handoff (custom-provider.md)
// =============================================================================

test("foreign-provider assistant turns and tool results replay instead of being dropped", async () => {
	const { body } = await runCapture([
		SYSTEM,
		userMessage("Weather in Paris?", 2),
		// A turn produced by a different provider/api (session handoff).
		assistantToolCall({ api: "openai-completions", provider: "openrouter" }),
		toolResult([{ type: "text", text: "18C, sunny" }]),
	]);
	const wire = wireMessages(body);
	assert.deepEqual(
		wire.map((m) => m.role),
		["system", "user", "assistant", "tool"],
	);
	const assistant = wire[2]!;
	assert.equal(assistant.content, "Let me check.");
	assert.equal(assistant.tool_calls!.length, 1);
	assert.equal(assistant.tool_calls![0]!.function.name, "get_weather");
	// Tool-call/result matching is id-based, not provider-scoped: the
	// foreign tool result answers the foreign tool call by tool_call_id.
	assert.equal(wire[3]!.tool_call_id, "call_1");
	assert.equal(assistant.tool_calls![0]!.id, wire[3]!.tool_call_id);
	assert.equal(wire[3]!.content, "18C, sunny");
});

// =============================================================================
// Assistant history replay: reasoning is not part of the wire contract
// =============================================================================

test("assistant thinking blocks in history are not replayed to the wire", async () => {
	const assistant: Message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Secret reasoning.", thinkingSignature: "sig" },
			{ type: "text", text: "The answer is 4." },
		],
		api: "mistral-chat",
		provider: "mistral-native",
		model: "mistral-large-4",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 3,
	};
	const { body } = await runCapture([SYSTEM, userMessage("What is 2+2?", 2), assistant]);
	const wire = wireMessages(body);
	const replayed = wire[2]!;
	assert.equal(replayed.content, "The answer is 4.");
	// Thinking is dropped: no reasoning content and no signature on the wire.
	assert.doesNotMatch(JSON.stringify(body), /Secret reasoning\.|sig/);
});

// =============================================================================
// Usage without a usage chunk: zeroed counters and cost
// =============================================================================

test("no usage in the stream ends with zeroed usage and cost (no undefined/NaN)", async () => {
	let terminal: Record<string, unknown> | undefined;
	const stream = mistralStreamSimple(makeModel() as never, {
		messages: [SYSTEM, userMessage("Hi", 2)],
	} as unknown as TranscriptContext, {
		apiKey: "test-key",
		maxRetries: 0,
		fetch: async () => sseResponse([chunk({ role: "assistant", content: "" }), finalChunk("stop")]),
	} as never);
	for await (const event of stream) {
		const type = (event as { type: string }).type;
		if (type === "done") terminal = event as Record<string, unknown>;
	}
	assert.ok(terminal, "stream did not end with done");
	const message = terminal.message as AssistantMessage;
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(message.usage, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	// Mistral reports no reasoning breakdown without a usage chunk; pi's
	// Usage.reasoning is optional and stays undefined (not 0) then.
	assert.ok(!("reasoning" in message.usage));
	// Consumers read usage.cost.total directly; it must be a finite number.
	assert.ok(Number.isFinite(message.usage.cost.total));
});

test("gateway usage on the choice level is parsed when the chunk carries none", async () => {
	let terminal: Record<string, unknown> | undefined;
	const usageChunk: SseChunk = {
		id: "integration-1",
		object: "chat.completion.chunk",
		created: 1793048657,
		model: "mistral-large-4",
		choices: [
			{
				index: 0,
				delta: {},
				finish_reason: "stop",
				logprobs: null,
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			},
		],
	};
	const stream = mistralStreamSimple(makeModel() as never, {
		messages: [SYSTEM, userMessage("Hi", 2)],
	} as unknown as TranscriptContext, {
		apiKey: "test-key",
		maxRetries: 0,
		fetch: async () => sseResponse([chunk({ role: "assistant", content: "ok" }), usageChunk]),
	} as never);
	for await (const event of stream) {
		const type = (event as { type: string }).type;
		if (type === "done") terminal = event as Record<string, unknown>;
	}
	assert.ok(terminal);
	const usage = (terminal.message as AssistantMessage).usage;
	assert.equal(usage.input, 10);
	assert.equal(usage.output, 5);
	assert.equal(usage.totalTokens, 15);
});

// =============================================================================
// max_tokens context clamp (clampMaxTokensToContext)
// =============================================================================

test("max_tokens is clamped to contextWindow minus estimated tokens and the safety margin", async () => {
	// Estimated context is per message (CHARS_PER_TOKEN = 3.5):
	// ceil(23/3.5) + ceil(5400/3.5) = 7 + 1543 = 1550 tokens, so the clamp is
	// 20000 - 1550 - 4096 (CONTEXT_SAFETY_TOKENS) = 14354.
	const longUser = "a".repeat(5400);
	const { body } = await runCapture([SYSTEM, userMessage(longUser, 2)], {
		model: makeModel({ contextWindow: 20000, maxTokens: 262144 }),
	});
	assert.equal(body.max_tokens, 14354);
});

test("max_tokens falls back to at least 1 when the clamp underflows", async () => {
	// contextWindow smaller than the safety margin alone: available <= 0.
	const longUser = "a".repeat(35000); // ≈ 10000 estimated tokens
	const { body } = await runCapture([SYSTEM, userMessage(longUser, 2)], {
		model: makeModel({ contextWindow: 5000, maxTokens: 1000 }),
	});
	assert.equal(body.max_tokens, 1);
});

test("a non-positive contextWindow passes max_tokens through (lower-bounded at 1)", async () => {
	const { body } = await runCapture([SYSTEM, userMessage("Hi", 2)], {
		model: makeModel({ contextWindow: 0, maxTokens: 777 }),
	});
	assert.equal(body.max_tokens, 777);
});
