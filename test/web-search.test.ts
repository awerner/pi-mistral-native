/**
 * Mocked-HTTP unit tests for the Mistral web-search tools.
 *
 * All HTTP is mocked via an injected fetch implementation; no network access
 * and no real API keys ("test-key" literal only). The fixtures mirror the
 * live-probed Conversations wire shapes (2026-11-03): a tool.execution
 * entry whose info.result is a JSON string keyed by opaque hit ids, a
 * message.output entry (discarded by the tools), and the 3004 refusal of
 * models without builtin-connector support.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMistralClient } from "../extensions/tools/mistral-client.js";
import { createWebSearchTools, DEFAULT_SEARCH_MODEL } from "../extensions/tools/web-search.js";
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

/** Builds the two tools with a client bound to the mock fetch. */
function buildTools(mockFetch: typeof fetch) {
	return createWebSearchTools({
		getClient: async () => createMistralClient({ apiKey: "test-key", fetchImpl: mockFetch }),
	});
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
		usage?: unknown;
	};
}

/**
 * The trimmed web_search fixture: exact wire shape (tool.execution with a
 * JSON-string info.result, a message.output with plain-string and chunk
 * content, usage with connector tokens) — inline so the wire contract is
 * visible in the test itself.
 */
const WEB_SEARCH_RESPONSE = {
	object: "conversation.response",
	conversation_id: "conv_01a19cdeacca75888ae71f664c67840a",
	outputs: [
		{
			object: "entry",
			type: "tool.execution",
			model: "mistral-small-latest",
			id: "tool_exec_01a19cdeaedd75f886354952c63cf67b",
			name: "web_search",
			arguments: JSON.stringify({ query: "pi coding agent" }),
			function: "web_search",
			info: {
				result: JSON.stringify({
					g1pkj9ms: {
						url: "https://en.wikipedia.org/wiki/Pi_(AI_agent)",
						title: "Pi (AI agent)",
						description: null,
						snippets: ["Pi is an open-source AI coding agent for the terminal."],
					},
					u7I0yzAG: {
						url: "https://pi.dev/",
						title: "Pi Coding Agent",
						description: "A minimal, extensible agent harness.",
						snippets: ["Extensible via TypeScript extensions.", "SDK: embed Pi in your apps."],
					},
				}),
			},
		},
		{
			object: "entry",
			type: "message.output",
			model: "mistral-small-latest",
			id: "msg_01a19cdeb4b1735b9fc004d59247ed24",
			role: "assistant",
			content: "SECRET-ASSISTANT-TEXT: Pi is a coding agent harness developed by Earendil.",
		},
	],
	usage: { prompt_tokens: 768, completion_tokens: 220, total_tokens: 6853, connector_tokens: 5865, connectors: { web_search: 1 } },
	guardrails: null,
};

test("mistral_web_search posts a stateless one-shot Conversations request and maps the hits", async () => {
	const mock = createMockFetch();
	mock.respond(200, WEB_SEARCH_RESPONSE);
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_web_search"), { query: "pi coding agent" });

	const request = mock.requests[0];
	assert.ok(request);
	assert.equal(request.method, "POST");
	assert.ok(request.url.endsWith("/v1/conversations"), `unexpected url ${request.url}`);
	assert.equal(request.headers.Authorization, "Bearer test-key");
	assert.equal(request.headers["Content-Type"], "application/json");
	const body = JSON.parse(String(request.body)) as Record<string, unknown>;
	// Wire contract (live-verified 2026-11-03): inputs[], never messages[];
	// stateless one-shot flags; exactly the search tool declaration.
	assert.ok(Array.isArray(body.inputs), "the request must use inputs[]");
	assert.equal((body as Record<string, unknown>).messages, undefined, "messages[] must not be sent");
	assert.deepEqual(body.inputs, [{ role: "user", content: "pi coding agent" }]);
	assert.equal(body.model, "mistral-small-latest");
	assert.deepEqual(body.tools, [{ type: "web_search" }]);
	assert.equal(body.stream, false);
	assert.equal(body.store, false);
	// The fixed instructions string steers the server-side agent to run
	// the search tool (wire-verified lever; tool_choice forcing is
	// 422-rejected on this endpoint).
	assert.equal(
		body.instructions,
		"Always use the web_search tool to search the web before answering. Never answer from memory.",
	);

	// Hits: opaque ids discarded, values mapped; null description omitted.
	const hits = result.structuredContent?.hits as Record<string, unknown>[];
	assert.equal(hits?.length, 2);
	// Hits means the search executed — the skip marker stays absent.
	assert.equal(result.structuredContent?.skipped, undefined);
	assert.deepEqual(hits?.[0], {
		url: "https://en.wikipedia.org/wiki/Pi_(AI_agent)",
		title: "Pi (AI agent)",
		snippets: ["Pi is an open-source AI coding agent for the terminal."],
	});
	assert.deepEqual(hits?.[1], {
		url: "https://pi.dev/",
		title: "Pi Coding Agent",
		description: "A minimal, extensible agent harness.",
		snippets: ["Extensible via TypeScript extensions.", "SDK: embed Pi in your apps."],
	});

	// The message.output text is discarded — never surfaced to the model.
	const text = String(result.content[0]?.text);
	assert.match(text, /Pi \(AI agent\)/);
	assert.match(text, /pi\.dev/);
	assert.doesNotMatch(text, /SECRET-ASSISTANT-TEXT/);
	assert.equal(result.isError, undefined);

	// Usage: prompt/completion mapped to input/output; cost stays 0
	// (pay-per-use connector tokens are not priceable locally) and is
	// explicitly marked as a catalog estimate, not provider-billed.
	assert.ok(result.usage !== undefined);
	assert.equal((result.usage as Record<string, unknown> | undefined)?.input, 768);
	assert.equal((result.usage as Record<string, unknown> | undefined)?.output, 220);
	assert.deepEqual((result.usage as Record<string, unknown> | undefined)?.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		totalFromProvider: false,
	});
});

test("mistral_web_search_premium sends the premium tool type and shares the parsing", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv_01a19cdfdded70eb9d8a0ed5b2eea394",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01a19cdfe0c677d4900351bbb9b7423d",
				name: "web_search_premium",
				arguments: JSON.stringify({ query: "latest pi coding agent release notes" }),
				function: "web_search",
				info: {
					result: JSON.stringify({
						RBI5NWi4: {
							url: "https://pi.dev/changelog",
							title: "Pi Coding Agent",
							description: "Release notes and project updates.",
							snippets: ["New version of pi. Download from npm or view release on GitHub."],
						},
					}),
				},
			},
			{
				object: "entry",
				type: "message.output",
				model: "mistral-small-latest",
				id: "msg_01a19cdfe8cc72e8976716b2922f4118",
				role: "assistant",
				content: [
					{ type: "text", text: "SECRET-CHUNK-TEXT: Here are the latest release notes." },
					{ type: "tool_reference", tool: "web_search_premium", title: "Pi Coding Agent", url: "https://pi.dev/changelog" },
				],
			},
		],
		usage: { prompt_tokens: 1054, completion_tokens: 624, total_tokens: 8787, connector_tokens: 7109, connectors: { web_search_premium: 1 } },
		guardrails: null,
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_web_search_premium"), {
		query: "latest pi coding agent release notes",
	});

	const body = JSON.parse(String(mock.requests[0]?.body)) as Record<string, unknown>;
	assert.deepEqual(body.tools, [{ type: "web_search_premium" }]);
	assert.equal(body.store, false);
	assert.equal(
		body.instructions,
		"Always use the web_search_premium tool to search the web before answering. Never answer from memory.",
	);
	const hits = result.structuredContent?.hits as Record<string, unknown>[];
	assert.equal(hits?.length, 1);
	assert.equal(hits?.[0]?.url, "https://pi.dev/changelog");
	assert.equal((result.usage as Record<string, unknown> | undefined)?.input, 1054);
	assert.equal((result.usage as Record<string, unknown> | undefined)?.output, 624);
	// message.output arrives as a content-chunk array here — still discarded.
	assert.doesNotMatch(String(result.content[0]?.text), /SECRET-CHUNK-TEXT/);
	assert.equal(result.isError, undefined);
});

test("a search-skip response (no tool.execution entry) maps to a distinct skipped ok result", async () => {
	// Fixture shape: no_tool_execution.json (live-probed 2026-11-03) — the
	// backend answered with a clarifying question instead of searching.
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv_01a19cdfb96577c788883a769586b43e",
		outputs: [
			{
				object: "entry",
				type: "message.output",
				model: "magistral-medium-latest",
				id: "msg_01a19cdfbd68741f991c9c38169e6699",
				role: "assistant",
				content: "It looks like you're asking about a \"Pi Coding Agent\"—could you clarify what you mean?",
			},
		],
		usage: { prompt_tokens: 1046, completion_tokens: 91, total_tokens: 1137 },
		guardrails: null,
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_web_search"), { query: "pi coding agent" });

	assert.equal(result.isError, undefined, "a search skip is not an error");
	assert.deepEqual(result.structuredContent?.hits, []);
	// The skip is programmatically distinguishable from zero hits.
	assert.equal(result.structuredContent?.skipped, true);
	const text = String(result.content[0]?.text);
	// The skipped-search message is distinct from the zero-hits message:
	// it reports the skip (retry-worthy), never "no results found".
	assert.match(text, /skipped/);
	assert.match(text, /did not execute the search/);
	assert.match(text, /retried/);
	assert.doesNotMatch(text, /returned no results/);
	// The assistant's clarifying question is discarded, not surfaced as hits.
	assert.doesNotMatch(text, /could you clarify/);
	// Usage still maps when the response carries it.
	assert.equal((result.usage as Record<string, unknown> | undefined)?.input, 1046);
	assert.equal((result.usage as Record<string, unknown> | undefined)?.output, 91);
});

test("a tool.execution entry with an empty hit map maps to the zero-hits ok result", async () => {
	// Fixture shape: the search genuinely executed (tool.execution present,
	// info.result an empty hit map) and found nothing.
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv_01a19cdfc8b0f68eb0f1a2c3d4e5f678",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01a19cdfc9c6d79ec4b6a3d2f1e0c9d8",
				name: "web_search",
				arguments: JSON.stringify({ query: "pi coding agent" }),
				function: "web_search",
				info: { result: "{}" },
			},
			{
				object: "entry",
				type: "message.output",
				model: "mistral-small-latest",
				id: "msg_01a19cdfca57de7c0a9b8e6f5d4c3b2a",
				role: "assistant",
				content: "I searched, but there was nothing to find.",
			},
		],
		usage: { prompt_tokens: 812, completion_tokens: 140, total_tokens: 952, connector_tokens: 5865, connectors: { web_search: 1 } },
		guardrails: null,
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_web_search"), { query: "pi coding agent" });

	assert.equal(result.isError, undefined, "zero hits is not an error");
	assert.deepEqual(result.structuredContent?.hits, []);
	// Executed search, zero hits — the skip marker stays absent.
	assert.equal(result.structuredContent?.skipped, undefined);
	const text = String(result.content[0]?.text);
	// The zero-hits message stays reserved for the executed-search case.
	assert.equal(text, "The web search returned no results for this query.");
	assert.doesNotMatch(text, /skipped/);
	assert.doesNotMatch(text, /could you clarify/);
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
		const tools = buildTools(mock.mockFetch);
		const result = await execute(toolByName(tools, "mistral_web_search"), { query: "pi coding agent" });

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
	setMistralConfigForTests({ knowledge: { streaming: undefined, searchModel: "mistral-medium-latest" } });
	try {
		const mock = createMockFetch();
		mock.respond(200, WEB_SEARCH_RESPONSE);
		const tools = buildTools(mock.mockFetch);
		await execute(toolByName(tools, "mistral_web_search"), { query: "pi coding agent" });
		const body = JSON.parse(String(mock.requests[0]?.body)) as Record<string, unknown>;
		assert.equal(body.model, "mistral-medium-latest");
	} finally {
		setMistralConfigForTests(null);
	}
});

test("the default search model is mistral-small-latest", () => {
	assert.equal(DEFAULT_SEARCH_MODEL, "mistral-small-latest");
});

test("the premium description names the pay-per-use opt-in", () => {
	const tools = buildTools((async () => new Response("{}", { status: 200 })) as typeof fetch);
	const premium = toolByName(tools, "mistral_web_search_premium");
	assert.match(premium.description, /pay-per-use/);
	assert.match(premium.description, /opts in deliberately/);
	// The standard variant carries no cost warning.
	const standard = toolByName(tools, "mistral_web_search");
	assert.doesNotMatch(standard.description, /pay-per-use/);
});

test("an unreadable info.result fails with the unreadable-search-result message, never a raw dump", async () => {
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv-broken",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				name: "web_search",
				function: "web_search",
				info: { result: "{not json" },
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		guardrails: null,
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_web_search"), { query: "q" });
	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /unreadable search result/);
	assert.doesNotMatch(text, /\{not json/);
});

test("a matching tool.execution entry without a readable info.result fails with the unreadable-search-result message", async () => {
	// Matching entry (name web_search) whose info carries no result string:
	// neither a skip nor an executed search — the unreadable path.
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv-no-result",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01a19cdfd0e1b2c3d4e5f6a7b8c9d0e1f",
				name: "web_search",
				arguments: JSON.stringify({ query: "pi coding agent" }),
				function: "web_search",
				info: {},
			},
		],
		usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
		guardrails: null,
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_web_search"), { query: "pi coding agent" });
	assert.equal(result.isError, true);
	const text = String(result.content[0]?.text);
	assert.match(text, /unreadable search result/);
	assert.match(text, /no readable info\.result/);
	// No raw dump of the fixture body.
	assert.doesNotMatch(text, /tool_execution/);
});

test("multiple matching tool.execution entries concatenate their hits in outputs order", async () => {
	// The agent may execute the search twice in one turn (plausible now
	// every request instructs it to always search) — both hit maps surface,
	// in outputs order.
	const mock = createMockFetch();
	mock.respond(200, {
		object: "conversation.response",
		conversation_id: "conv_01a19cdfd7c1f2e3a4b5c6d7e8f9a0b1",
		outputs: [
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01a19cdfd8a0b1c2d3e4f5a6b7c8d9e0f",
				name: "web_search",
				arguments: JSON.stringify({ query: "pi coding agent" }),
				function: "web_search",
				info: {
					result: JSON.stringify({
						first1: {
							url: "https://en.wikipedia.org/wiki/Pi_(AI_agent)",
							title: "Pi (AI agent)",
							description: null,
							snippets: ["Pi is an open-source AI coding agent for the terminal."],
						},
					}),
				},
			},
			{
				object: "entry",
				type: "tool.execution",
				model: "mistral-small-latest",
				id: "tool_exec_01a19cdfd9f1e2d3c4b5a69788796a5b4",
				name: "web_search",
				arguments: JSON.stringify({ query: "pi coding agent docs" }),
				function: "web_search",
				info: {
					result: JSON.stringify({
						second1: {
							url: "https://pi.dev/docs",
							title: "Pi Documentation",
							description: "The official documentation.",
							snippets: ["Guides, tutorials, and API references."],
						},
						second2: {
							url: "https://pi.dev/faq",
							title: "Pi FAQ",
							description: null,
							snippets: ["Frequently asked questions."],
						},
					}),
				},
			},
			{
				object: "entry",
				type: "message.output",
				model: "mistral-small-latest",
				id: "msg_01a19cdfdaf2e3d4c5b6a798897a6b5c4",
				role: "assistant",
				content: "SECRET-ASSISTANT-TEXT: Here is what I found.",
			},
		],
		usage: { prompt_tokens: 905, completion_tokens: 310, total_tokens: 6775, connector_tokens: 5865, connectors: { web_search: 2 } },
		guardrails: null,
	});
	const tools = buildTools(mock.mockFetch);
	const result = await execute(toolByName(tools, "mistral_web_search"), { query: "pi coding agent" });

	assert.equal(result.isError, undefined);
	const hits = result.structuredContent?.hits as Record<string, unknown>[];
	// Both executions contribute: 1 + 2 hits, in outputs order.
	assert.equal(hits?.length, 3);
	assert.equal(hits?.[0]?.url, "https://en.wikipedia.org/wiki/Pi_(AI_agent)");
	assert.equal(hits?.[1]?.url, "https://pi.dev/docs");
	assert.equal(hits?.[2]?.url, "https://pi.dev/faq");
	// The search executed — the skip marker stays absent.
	assert.equal(result.structuredContent?.skipped, undefined);
	// The message.output text is still discarded.
	assert.doesNotMatch(String(result.content[0]?.text), /SECRET-ASSISTANT-TEXT/);
});

test("registerWebSearchTools registers both tools with the extension", async () => {
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
	assert.ok(names.includes("mistral_web_search"), "mistral_web_search must be registered");
	assert.ok(names.includes("mistral_web_search_premium"), "mistral_web_search_premium must be registered");
	// Registered after the knowledge tools (the extension's order).
	const knowledgeIndex = names.indexOf("mistral_document_query");
	const searchIndex = names.indexOf("mistral_web_search");
	assert.ok(knowledgeIndex >= 0 && searchIndex > knowledgeIndex, "search tools register after the knowledge tools");
});
