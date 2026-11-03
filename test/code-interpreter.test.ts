/**
 * Mocked-HTTP unit tests for the Mistral code-interpreter tool.
 *
 * All HTTP is mocked via an injected fetch implementation; no network access
 * and no real API keys ("test-key" literal only). The fixtures mirror the
 * live-probed Conversations wire shapes (2026-11-03): a tool.execution entry
 * whose info.result is an ARRAY of content chunks (text and file_url), plus
 * info.code / info.code_output, a message.output entry (discarded by the
 * tool), and the 3004 refusal of models without builtin-connector support.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMistralClient } from "../extensions/tools/mistral-client.js";
import { createCodeInterpreterTool } from "../extensions/tools/code-interpreter.js";
import { setMistralConfigForTests } from "../extensions/mistral/config.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// Force a deterministic no-file config baseline for this suite: the default
// search model must hold regardless of the developer's real
// mistral-native.json. Per-test overrides set explicit configs and restore
// the baseline.
setMistralConfigForTests(null);

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
		return new Response(response.body, {
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

/** Builds the tool with a client bound to the mock fetch. */
function buildTool(mockFetch: typeof fetch) {
	return createCodeInterpreterTool({
		getClient: async () => createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch }),
	});
}

/** Calls a tool's execute with the standard pi signature. */
async function execute(tool: ToolDefinition<any, any>, params: unknown, signal?: AbortSignal) {
	const result = await tool.execute("call-1", params as never, signal, undefined, undefined as never);
	return result as {
		content: { type: string; text?: string }[];
		structuredContent?: Record<string, unknown>;
		details?: unknown;
		isError?: boolean;
		usage?: unknown;
	};
}

/**
 * The trimmed code_interpreter fixture: exact wire shape (tool.execution
 * with info.result as an ARRAY of chunks — a text chunk and a file_url
 * chunk — plus code/code_output, a message.output with tool_file chunks,
 * usage with connector tokens) — inline so the wire contract is visible in
 * the test itself.
 */
const CODE_INTERPRETER_RESPONSE = {
	object: "conversation.response",
	conversation_id: "conv_01b29cdeacca75888ae71f664c67840b",
	outputs: [
		{
			object: "entry",
			type: "tool.execution",
			model: "mistral-small-latest",
			id: "tool_exec_01b29cdeaedd75f886354952c63cf67c",
			name: "code_interpreter",
			arguments: JSON.stringify({ prompt: "plot sin(x)" }),
			function: "code_interpreter",
			info: {
				result: [
					{ type: "text", text: "Here is the plot of sin(x):" },
					{
						type: "file_url",
						file_url: "https://cdn.mistral.ai/blobs/abc123/sin_x_plot.png?sig=SIGNED",
						file_name: "sin_x_plot.png",
						file_type: "png",
						summary: null,
					},
				],
				code: "import numpy as np\nimport matplotlib.pyplot as plt\nx = np.linspace(0, 10, 100)\nplt.plot(x, np.sin(x))\nplt.savefig('sin_x_plot.png')",
				code_output: "",
			},
		},
		{
			object: "entry",
			type: "message.output",
			model: "mistral-small-latest",
			id: "msg_01b29cdeb4b1735b9fc004d59247ed25",
			role: "assistant",
			content: [
				{ type: "text", text: "SECRET-ASSISTANT-TEXT: I plotted sin(x) for you." },
				{
					type: "tool_file",
					tool: "code_interpreter",
					file_id: "file_01b29cde",
					file_name: "sin_x_plot.png",
					file_type: "png",
				},
			],
		},
	],
	usage: { prompt_tokens: 512, completion_tokens: 180, total_tokens: 4210, connector_tokens: 3518, connectors: { code_interpreter: 1 } },
	guardrails: null,
};

test("mistral_code_interpreter posts a stateless one-shot Conversations request and maps the chunks", async () => {
	const mock = createMockFetch();
	mock.respond(200, CODE_INTERPRETER_RESPONSE);
	const tool = buildTool(mock.mockFetch);
	const result = await execute(tool, { prompt: "plot sin(x) from 0 to 10 and save the figure" });

	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "POST");
	assert.ok(request.url.endsWith("/v1/conversations"), `unexpected url ${request.url}`);
	assert.equal(request.headers.Authorization, "Bearer test-key");
	assert.equal(request.headers["Content-Type"], "application/json");
	const body = JSON.parse(String(request.body)) as Record<string, unknown>;
	// Wire contract (live-verified 2026-11-03): inputs[], never messages[];
	// stateless one-shot flags; exactly the code_interpreter declaration.
	assert.ok(Array.isArray(body.inputs), "the request must use inputs[]");
	assert.equal(body.messages, undefined, "messages[] must not be sent");
	assert.deepEqual(body.inputs, [{ role: "user", content: "plot sin(x) from 0 to 10 and save the figure" }]);
	assert.equal(body.model, "mistral-small-latest");
	assert.deepEqual(body.tools, [{ type: "code_interpreter" }]);
	assert.equal(body.stream, false);
	assert.equal(body.store, false);
	// The fixed instructions string steers the server-side agent to run the
	// code interpreter (wire-verified lever; tool_choice forcing is
	// 422-rejected on this endpoint).
	assert.equal(
		body.instructions,
		"Always use the code_interpreter tool to run Python code before answering. Never answer from memory.",
	);

	// Chunks: text chunk verbatim, file_url chunk mapped to camelCase.
	const output = result.structuredContent?.output as Record<string, unknown>[];
	assert.equal(output?.length, 2);
	// Executed means the skip marker stays absent.
	assert.equal(result.structuredContent?.skipped, undefined);
	assert.deepEqual(output?.[0], { type: "text", text: "Here is the plot of sin(x):" });
	assert.deepEqual(output?.[1], {
		type: "file_url",
		fileUrl: "https://cdn.mistral.ai/blobs/abc123/sin_x_plot.png?sig=SIGNED",
		fileName: "sin_x_plot.png",
		fileType: "png",
	});
	// code/code_output surface in structuredContent when strings.
	assert.equal(typeof result.structuredContent?.code, "string");
	assert.match(String(result.structuredContent?.code), /np\.sin/);
	assert.equal(result.structuredContent?.codeOutput, "");

	// The model-facing text carries the chunk text and the file url+name…
	const text = String(result.content[0]?.text);
	assert.match(text, /Here is the plot of sin\(x\):/);
	assert.match(text, /sin_x_plot\.png \(png\): https:\/\/cdn\.mistral\.ai\/blobs\/abc123\/sin_x_plot\.png\?sig=SIGNED/);
	// …but never the discarded message.output content.
	assert.doesNotMatch(text, /SECRET-ASSISTANT-TEXT/);
	assert.equal(result.isError, undefined);

	// details stay log-safe: no signed URLs, no server payload.
	const details = result.details as Record<string, unknown>;
	assert.equal(details.tool, "mistral_code_interpreter");
	assert.equal(details.model, "mistral-small-latest");
	assert.equal(details.prompt, "plot sin(x) from 0 to 10 and save the figure");
	assert.equal(details.chunks, 2);
	assert.doesNotMatch(JSON.stringify(details), /sig=SIGNED/);
	assert.doesNotMatch(JSON.stringify(details), /SECRET-ASSISTANT-TEXT/);

	// Usage: prompt/completion mapped to input/output; cost stays 0
	// (pay-per-use connector tokens are not priceable locally).
	assert.ok(result.usage !== undefined);
	assert.equal((result.usage as Record<string, unknown> | undefined)?.input, 512);
	assert.equal((result.usage as Record<string, unknown> | undefined)?.output, 180);
	assert.deepEqual((result.usage as Record<string, unknown> | undefined)?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("a skip response (no tool.execution entry) maps to a distinct skipped ok result", async () => {
	// Fixture shape: the backend answered without executing the tool (the
	// mistral-large-4 behavior — accepts the request, silently skips).
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv_01b29cdfb96577c788883a769586b43f",
		outputs: [
			{
				object: "entry",
				type: "message.output",
				model: "mistral-large-4",
				id: "msg_01b29cdfbd68741f991c9c38169e6699",
				role: "assistant",
				content: "SECRET-SKIP-TEXT: I answered directly without running code.",
			},
		],
		usage: { prompt_tokens: 640, completion_tokens: 75, total_tokens: 715 },
		guardrails: null,
	});
	const tool = buildTool(mock.mockFetch);
	const result = await execute(tool, { prompt: "compute 2+2" });

	assert.equal(result.isError, undefined, "a skip is not an error");
	assert.deepEqual(result.structuredContent?.output, []);
	// The skip is programmatically distinguishable from an executed run.
	assert.equal(result.structuredContent?.skipped, true);
	const text = String(result.content[0]?.text);
	// The skipped message is distinct from the executed-empty message: it
	// reports the skip (retry-worthy), never "produced no output".
	assert.match(text, /skipped/);
	assert.match(text, /did not execute any code/);
	assert.match(text, /retried/);
	assert.doesNotMatch(text, /produced no output/);
	// The assistant's direct answer is discarded, not surfaced.
	assert.doesNotMatch(text, /SECRET-SKIP-TEXT/);
	// Usage still maps when the response carries it.
	assert.equal((result.usage as Record<string, unknown> | undefined)?.input, 640);
	assert.equal((result.usage as Record<string, unknown> | undefined)?.output, 75);
});

test("a tool.execution entry with an empty result array maps to the executed-empty ok result", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv_01b29cdfc8b0f68eb0f1a2c3d4e5f679",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01b29cdfc9c6d79ec4b6a3d2f1e0c9d8",
				name: "code_interpreter",
				arguments: JSON.stringify({ prompt: "print nothing" }),
				function: "code_interpreter",
				info: { result: [], code: "pass", code_output: "" },
			},
			{
				object: "entry",
				type: "message.output",
				model: "mistral-small-latest",
				id: "msg_01b29cdfca57de7c0a9b8e6f5d4c3b2a",
				role: "assistant",
				content: "SECRET-EMPTY-TEXT: the run printed nothing.",
			},
		],
		usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340, connector_tokens: 12, connectors: { code_interpreter: 1 } },
		guardrails: null,
	});
	const tool = buildTool(mock.mockFetch);
	const result = await execute(tool, { prompt: "run code that prints nothing" });

	assert.equal(result.isError, undefined, "an executed run with no output is not an error");
	assert.deepEqual(result.structuredContent?.output, []);
	// Executed, empty — the skip marker stays absent.
	assert.equal(result.structuredContent?.skipped, undefined);
	assert.equal(String(result.content[0]?.text), "The code interpreter ran but produced no output.");
	assert.doesNotMatch(String(result.content[0]?.text), /skipped/);
	assert.doesNotMatch(String(result.content[0]?.text), /SECRET-EMPTY-TEXT/);
});

test("a 400 code 3004 refusal maps to the friendly search-model error", async () => {
	// Config: knowledge.searchModel = mistral-large-4 (the refusing model,
	// wire-verified 2026-11-03).
	setMistralConfigForTests({ knowledge: { streaming: undefined, searchModel: "mistral-large-4" } });
	try {
		const mock = createMockFetch();
		mock.respond(400, {
			object: "Error",
			message: "Model mistral-large-4 currently does not support builtin connectors.",
			type: "invalid_request_error",
			code: 3004,
		});
		const tool = buildTool(mock.mockFetch);
		const result = await execute(tool, { prompt: "compute 2+2" });

		const body = JSON.parse(String(mock.requests[0]?.body)) as Record<string, unknown>;
		assert.equal(body.model, "mistral-large-4");
		assert.equal(result.isError, true);
		const text = String(result.content[0]?.text);
		assert.match(text, /mistral-large-4/);
		assert.match(text, /3004/);
		assert.match(text, /knowledge\.searchModel/);
		assert.match(text, /mistral-small-latest/);
		// No raw error dump: the server's raw JSON body stays out.
		assert.doesNotMatch(text, /invalid_request_error/);
		assert.doesNotMatch(text, /"object"/);
	} finally {
		setMistralConfigForTests(null);
	}
});

test("knowledge.searchModel from the config file overrides the request's model", async () => {
	setMistralConfigForTests({ knowledge: { streaming: undefined, searchModel: "magistral-medium-latest" } });
	try {
		const mock = createMockFetch();
		mock.respond(200, CODE_INTERPRETER_RESPONSE);
		const tool = buildTool(mock.mockFetch);
		await execute(tool, { prompt: "plot sin(x)" });
		const body = JSON.parse(String(mock.requests[0]?.body)) as Record<string, unknown>;
		assert.equal(body.model, "magistral-medium-latest");
	} finally {
		setMistralConfigForTests(null);
	}
});

test("an unreadable info.result fails with the unreadable-result message, never a raw dump", async () => {
	// info.result as a string (the web-search shape) is NOT a readable
	// chunk array for the code interpreter — the unreadable path.
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv-broken",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				name: "code_interpreter",
				function: "code_interpreter",
				info: { result: "SECRET-RAW-RESULT-STRING" },
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		guardrails: null,
	});
	const tool = buildTool(mock.mockFetch);
	const result = await execute(tool, { prompt: "q" });
	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /unreadable code-interpreter result/);
	assert.match(text, /not a chunk array/);
	assert.doesNotMatch(text, /SECRET-RAW-RESULT-STRING/);
});

test("a matching tool.execution entry without a readable info fails with the unreadable-result message", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv-no-info",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01b29cdfd0e1b2c3d4e5f6a7b8c9d0e1f",
				name: "code_interpreter",
				arguments: JSON.stringify({ prompt: "q" }),
				function: "code_interpreter",
				info: null,
			},
		],
		usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
		guardrails: null,
	});
	const tool = buildTool(mock.mockFetch);
	const result = await execute(tool, { prompt: "q" });
	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /unreadable code-interpreter result/);
	assert.match(text, /no readable info/);
	// No raw dump of the fixture body.
	assert.doesNotMatch(text, /tool_execution/);
});

test("multiple matching tool.execution entries concatenate their chunks in outputs order", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv_01b29cdfd7c1f2e3a4b5c6d7e8f9a0b1",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01b29cdfd8a0b1c2d3e4f5a6b7c8d9e0f",
				name: "code_interpreter",
				arguments: JSON.stringify({ prompt: "first" }),
				function: "code_interpreter",
				info: {
					result: [{ type: "text", text: "first run output" }],
					code: "print('first')",
					code_output: "first",
				},
			},
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01b29cdfd9f1e2d3c4b5a69788796a5b4",
				name: "code_interpreter",
				arguments: JSON.stringify({ prompt: "second" }),
				function: "code_interpreter",
				info: {
					result: [
						{ type: "text", text: "second run output" },
						{
							type: "file_url",
							file_url: "https://cdn.mistral.ai/blobs/def456/second.csv?sig=SIGNED2",
							file_name: "second.csv",
							file_type: "csv",
							summary: null,
						},
						{ type: "unknown_future_chunk", payload: "SECRET-UNKNOWN-CHUNK" },
					],
					code: "print('second')",
					code_output: "second",
				},
			},
			{
				object: "entry",
				type: "message.output",
				model: "mistral-small-latest",
				id: "msg_01b29cdfdaf2e3d4c5b6a798897a6b5c4",
				role: "assistant",
				content: "SECRET-ASSISTANT-TEXT: both runs finished.",
			},
		],
		usage: { prompt_tokens: 700, completion_tokens: 260, total_tokens: 5100, connector_tokens: 4140, connectors: { code_interpreter: 2 } },
		guardrails: null,
	});
	const tool = buildTool(mock.mockFetch);
	const result = await execute(tool, { prompt: "run twice" });

	assert.equal(result.isError, undefined);
	const output = result.structuredContent?.output as Record<string, unknown>[];
	// Both executions contribute, in outputs order; the unknown chunk shape
	// is folded away.
	assert.equal(output?.length, 3);
	assert.deepEqual(output?.[0], { type: "text", text: "first run output" });
	assert.deepEqual(output?.[1], { type: "text", text: "second run output" });
	assert.deepEqual(output?.[2], {
		type: "file_url",
		fileUrl: "https://cdn.mistral.ai/blobs/def456/second.csv?sig=SIGNED2",
		fileName: "second.csv",
		fileType: "csv",
	});
	// The skip marker stays absent; message.output stays discarded; unknown
	// chunk payloads never leak.
	assert.equal(result.structuredContent?.skipped, undefined);
	const text = String(result.content[0]?.text);
	assert.match(text, /first run output/);
	assert.match(text, /second\.csv \(csv\): https:\/\/cdn\.mistral\.ai/);
	assert.doesNotMatch(text, /SECRET-ASSISTANT-TEXT/);
	assert.doesNotMatch(text, /SECRET-UNKNOWN-CHUNK/);
	// code/code_output of the last execution that carries them win.
	assert.equal(result.structuredContent?.code, "print('second')");
	assert.equal(result.structuredContent?.codeOutput, "second");
});

test("code_output is rendered ahead of the chunk lines in the result text", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv_01b29cdfout1",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_out1",
				name: "code_interpreter",
				function: "code_interpreter",
				info: {
					result: [{ type: "text", text: "chunk text after output" }],
					code: "print('captured stdout')",
					code_output: "captured stdout",
				},
			},
		],
		usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
		guardrails: null,
	});
	const tool = buildTool(mock.mockFetch);
	const result = await execute(tool, { prompt: "print something" });
	assert.equal(result.isError, undefined);
	const text = String(result.content[0]?.text);
	assert.ok(text.indexOf("captured stdout") < text.indexOf("chunk text after output"), "code_output must come first");
});

test("registerCodeInterpreterTool registers mistral_code_interpreter with the extension", async () => {
	const { default: mistralExtension } = await import("../extensions/mistral.js");
	const registeredTools: { name: string }[] = [];
	const stubPi = {
		registerProvider: (providerOrName: unknown) => {
			void (providerOrName as { id: string });
		},
		on: () => undefined,
		registerTool: (tool: { name: string }) => {
			registeredTools.push(tool);
		},
		registerCommand: () => undefined,
	};
	mistralExtension(stubPi as never);
	const names = registeredTools.map((tool) => tool.name);
	assert.ok(names.includes("mistral_code_interpreter"), "mistral_code_interpreter must be registered");
	// Registered right after the web-search tools (the extension's order).
	const searchIndex = names.indexOf("mistral_web_search");
	const interpreterIndex = names.indexOf("mistral_code_interpreter");
	assert.ok(searchIndex >= 0 && interpreterIndex === searchIndex + 2, "code interpreter registers right after the web-search tools");
});
