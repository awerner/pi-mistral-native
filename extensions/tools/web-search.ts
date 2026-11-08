/**
 * pi tool for Mistral's web search: `web_search` over stateless one-shot
 * Conversations API calls, with the optional `premium` parameter (default
 * false) routing to the pay-per-use `web_search_premium` tool type. The
 * chat path stays on Chat Completions (ADR 0002); the tool never
 * continues a conversation — every call is a fresh
 * POST /v1/conversations with `store: false`, and the returned
 * `conversation_id` is discarded.
 *
 * Wire facts (probed live 2026-11-03, fixtures in the test suite): the
 * request body uses `inputs[]`, NOT `messages[]` (the endpoint rejects
 * `messages` as extra_forbidden); the response's `outputs[]` carries a
 * `tool.execution` entry whose `info.result` is a JSON string mapping
 * opaque hit ids to { url, title, description, snippets }, plus a
 * `message.output` entry that is DISCARDED here (only the hits are the
 * tool's payload). mistral-large-4 refuses builtin connectors on
 * /v1/conversations (400 code 3004), so the search model is configured
 * separately from the chat model (default `mistral-small-latest`). Two
 * empty outcomes are distinct wire shapes: a response with NO
 * `tool.execution` entry means the backend skipped the search (reported
 * as skipped, retry-worthy), while a `tool.execution` entry with an
 * empty hit map is a genuinely executed search with zero hits. Every
 * request also carries a fixed top-level `instructions` string steering
 * the server-side agent to run the search tool.
 *
 * ADR 0018 — Web search as a Conversations-backed tool; ADR 0021 — Cost
 * estimates marked as not provider-billed.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import { DEFAULT_SEARCH_MODEL, getEffectiveSearchModel } from "../mistral/config.js";
import type { MistralClient } from "./mistral-client.js";
import { MistralApiError, createMistralClient } from "./mistral-client.js";

/** Dependencies of {@link createWebSearchTools}: a lazy per-call client factory. */
export interface WebSearchToolsDeps {
	/** Resolves a client for one execute call (fresh API key + abort signal). */
	getClient: (ctx: ExtensionToolContext | undefined, signal?: AbortSignal) => Promise<MistralClient>;
}

type AnyToolDefinition = ToolDefinition<any, any>;

/** The tool type wire name of one search variant. */
type SearchToolType = "web_search" | "web_search_premium";

/** One mapped search hit (description omitted when the wire value is null). */
interface SearchHit {
	url: string;
	title: string;
	description?: string;
	snippets: string[];
}

/** Two-outcome parse of a Conversations search response. */
interface ParsedSearchResult {
	/** False when no `tool.execution` entry matched the tool type: the backend skipped the search. */
	executed: boolean;
	hits: SearchHit[];
}

/** Model-facing text plus structuredContent and log-safe details. */
function ok(
	text: string,
	structured: Record<string, unknown>,
	details: Record<string, unknown>,
	usage?: NonNullable<AgentToolResult<any>["usage"]>,
): AgentToolResult<any> {
	return {
		content: [{ type: "text", text }],
		structuredContent: structured as never,
		details,
		...(usage !== undefined ? { usage } : {}),
	};
}

/** Error result: concise message for the model, log-safe details, isError. */
function fail(message: string, details: Record<string, unknown>): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details,
		isError: true,
	};
}

/** Renders any caught error as a concise, log-safe message (never headers/auth). */
function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Cost block shape including pi-ai 1.5's `totalFromProvider` flag (the
 * dev-locked pi-ai 1.4.0 types predate the field; the peer range is "*").
 */
type CostBlock = NonNullable<AgentToolResult<any>["usage"]>["cost"] & { totalFromProvider?: boolean };

/**
 * Parses the Conversations usage block (loose subset of the wire shape:
 * prompt_tokens/completion_tokens, optional prompt_tokens_details) into
 * pi's tool-result Usage. Cost stays 0 by design: pay-per-use connector
 * tokens (`connector_tokens`) are not priceable locally, and the Mistral
 * wire format carries token counts only — no billed total — so the cost
 * block is explicitly marked as a catalog estimate (`totalFromProvider:
 * false`, pi-ai 1.5+) rather than a provider-billed amount.
 * Same shape as parseRagUsage in knowledge.ts.
 * ADR 0021 — Cost estimates marked as not provider-billed.
 */
function parseSearchUsage(raw: Record<string, unknown>): NonNullable<AgentToolResult<any>["usage"]> {
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	const details = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
	const input = num(raw.prompt_tokens);
	const output = num(raw.completion_tokens);
	const cacheRead = num(details.cached_tokens);
	const cacheWrite = num(details.cache_write_tokens);
	const cost: CostBlock = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false };
	return {
		input: Math.max(0, input - cacheRead - cacheWrite),
		output,
		cacheRead,
		cacheWrite,
		totalTokens: Math.max(0, input - cacheRead - cacheWrite) + output + cacheRead + cacheWrite,
		cost,
	};
}

/**
 * Parses the `info.result` JSON string from the tool.execution entry of a
 * /v1/conversations response and maps the hit object's VALUES (opaque ids
 * discarded) to SearchHit records. The message.output entry is never read —
 * its text is not the tool's payload. Distinguishes the two empty outcomes:
 * `executed: false` (no tool.execution entry matched the tool type — the
 * backend skipped the search) from `executed: true` with an empty hits
 * list (a genuinely executed search with zero hits). Malformed/unreadable
 * bodies throw so the caller can fail loudly.
 */
function parseSearchResult(response: unknown, toolType: SearchToolType): ParsedSearchResult {
	if (response === null || typeof response !== "object" || Array.isArray(response)) {
		throw new Error("unreadable search result: the response is not an object");
	}
	const outputs = (response as Record<string, unknown>).outputs;
	if (!Array.isArray(outputs)) {
		throw new Error("unreadable search result: the response has no outputs array");
	}
	let sawExecution = false;
	const resultJsons: string[] = [];
	for (const entry of outputs) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "tool.execution") continue;
		const name = record.name;
		const func = record.function;
		// Wire-verified 2026-11-03: `name` carries the requested tool type,
		// `function` stays "web_search" for both variants — match on either.
		if (name !== toolType && func !== toolType) continue;
		sawExecution = true;
		const info = record.info;
		const result = info !== null && typeof info === "object" ? (info as Record<string, unknown>).result : undefined;
		if (typeof result === "string") {
			resultJsons.push(result);
		}
	}
	if (!sawExecution) return { executed: false, hits: [] };
	if (resultJsons.length === 0) {
		throw new Error("unreadable search result: the tool execution carries no readable info.result");
	}
	// The agent may execute the search more than once per turn (plausible
	// now every request instructs it to always search) — concatenate the hits
	// of every readable execution in outputs order, losing none.
	const hits: SearchHit[] = [];
	for (const resultJson of resultJsons) {
		const hitsObject: unknown = JSON.parse(resultJson);
		if (hitsObject === null || typeof hitsObject !== "object" || Array.isArray(hitsObject)) {
			throw new Error("unreadable search result: the tool result is not a hit map");
		}
		for (const value of Object.values(hitsObject as Record<string, unknown>)) {
			if (value === null || typeof value !== "object") continue;
			const hit = value as Record<string, unknown>;
			if (typeof hit.url !== "string" || typeof hit.title !== "string") continue;
			const snippets = Array.isArray(hit.snippets)
				? hit.snippets.filter((snippet): snippet is string => typeof snippet === "string" && snippet.length > 0)
				: [];
			hits.push({
				url: hit.url,
				title: hit.title,
				...(typeof hit.description === "string" ? { description: hit.description } : {}),
				snippets,
			});
		}
	}
	return { executed: true, hits };
}

/** Renders the model-facing result text: one compact block per hit. */
function formatHits(hits: SearchHit[]): string {
	return hits
		.map((hit) => {
			const lines = [hit.title, hit.url];
			if (hit.description !== undefined) lines.push(hit.description);
			for (const snippet of hit.snippets) {
				lines.push(snippet.replace(/\s+/g, " ").trim());
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

/**
 * Detects the wire-verified 3004 refusal (mistral-large-4 et al. reject
 * builtin connectors on /v1/conversations; live 2026-11-03) in a 400
 * MistralApiError body. Parses defensively — anything unparseable is not a
 * 3004.
 */
function isConnectorRefusal(error: unknown): boolean {
	if (!(error instanceof MistralApiError) || error.status !== 400) return false;
	try {
		const parsed: unknown = JSON.parse(error.body);
		if (parsed !== null && typeof parsed === "object") {
			return (parsed as Record<string, unknown>).code === 3004;
		}
	} catch {
		// Body is not JSON — the generic failure path applies.
	}
	return false;
}

/** Builds the web-search tool; the `premium` parameter routes to the premium tool type per call. */
function defineSearchTool(deps: WebSearchToolsDeps): AnyToolDefinition {
	const { getClient } = deps;
	return defineTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web with Mistral's web_search connector and return the hits (url, title, description, snippets) for the query. " +
			"Set premium to true for premium search quality — premium search is pay-per-use, costs extra per call, and the caller opts in deliberately.",
		parameters: Type.Object({
			query: Type.String({ description: "The web search query" }),
			premium: Type.Optional(
				Type.Boolean({
					description:
						"Set to true for premium search quality. Premium search is pay-per-use — it costs extra per call; the caller opts in deliberately. Default false.",
				}),
			),
		}),
		outputSchema: Type.Object({
			hits: Type.Array(
				Type.Object({
					url: Type.String(),
					title: Type.String(),
					description: Type.Optional(Type.String()),
					snippets: Type.Array(Type.String()),
				}),
			),
			// Present (true) only on the skipped-search path; absent for zero
			// hits and for hits — callers distinguish the outcomes
			// programmatically, complementing the distinct result texts.
			skipped: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const model = getEffectiveSearchModel();
			const toolType: SearchToolType = params.premium ? "web_search_premium" : "web_search";
			const baseDetails: Record<string, unknown> = {
				tool: "web_search",
				model,
				query: params.query,
				// The tool name no longer encodes the variant — details keep it.
				...(params.premium ? { premium: true } : {}),
			};
			try {
				const client = await getClient(ctx, signal);
				const response = await client.createConversation({
					model,
					toolType,
					query: params.query,
					signal,
				});
				// Two distinct ok outcomes, never errors: the backend skipping
				// the search (no tool.execution entry — the message.output text is
				// discarded, so the model must learn about the skip from the result
				// text) is retry-worthy, while zero hits after an executed search
				// genuinely means nothing was found.
				let parsed: ParsedSearchResult;
				try {
					parsed = parseSearchResult(response, toolType);
				} catch (error) {
					return fail(
						`web_search returned an unreadable search result: ${errorMessage(error)}`,
						baseDetails,
					);
				}
				const hits = parsed.hits;
				const structured: Record<string, unknown> = { hits: hits as unknown as Record<string, unknown>[] };
				const record = response as Record<string, unknown>;
				const rawUsage = record.usage;
				const usage = rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage)
					? parseSearchUsage(rawUsage as Record<string, unknown>)
					: undefined;
				if (!parsed.executed) {
					return ok(
						"The web search was skipped: the backend did not execute the search, so no results were fetched. The query can be retried.",
						{ ...structured, skipped: true },
						{ ...baseDetails, skipped: true, hits: 0 },
						usage,
					);
				}
				if (hits.length === 0) {
					const empty = ok("The web search returned no results for this query.", structured, { ...baseDetails, hits: 0 }, usage);
					return empty;
				}
				const text = `Web search results (${hits.length}):\n\n${formatHits(hits)}`;
				return ok(text, structured, { ...baseDetails, hits: hits.length }, usage);
			} catch (error) {
				if (isConnectorRefusal(error)) {
					return fail(
						`The configured search model '${model}' does not support builtin connectors (Mistral error 3004). Set knowledge.searchModel to a search-capable model (e.g. mistral-small-latest).`,
						baseDetails,
					);
				}
				return fail(`web_search failed: ${errorMessage(error)}`, { ...baseDetails, error: errorMessage(error) });
			}
		},
	});
}

/**
 * Builds the web-search tool. `getClient` is called once per execute
 * call so each request uses the currently resolved API key and signal.
 */
export function createWebSearchTools(deps: WebSearchToolsDeps): AnyToolDefinition[] {
	return [defineSearchTool(deps)];
}

/**
 * Resolves the Mistral API key for a tool call: the mistral-native provider's
 * registered key if available, else the MISTRAL_API_KEY environment variable.
 * The resolved key is never logged or embedded in results.
 */
async function resolveApiKey(ctx: ExtensionToolContext | undefined): Promise<string | undefined> {
	const providerKey = await ctx?.modelRegistry?.getApiKeyForProvider?.("mistral-native");
	if (providerKey) {
		return providerKey;
	}
	return process.env.MISTRAL_API_KEY;
}

/**
 * Registers the web-search tool with pi, wiring a lazy client factory that
 * resolves the API key per execute call. Tools pass pi's per-call abort
 * signal through to the client request.
 */
export function registerWebSearchTools(pi: ExtensionAPI): void {
	const getClient = async (ctx: ExtensionToolContext | undefined, _signal?: AbortSignal) => {
		const apiKey = await resolveApiKey(ctx);
		return createMistralClient({ apiKey });
	};
	const tools = createWebSearchTools({ getClient });
	for (const tool of tools) {
		pi.registerTool(tool);
	}
}

// Re-export so `DEFAULT_SEARCH_MODEL` stays importable from this module
// (the task-facing surface): the definition lives in config.ts — the only
// module-level home — because config.ts must not import the tools layer
// (that would be a circular import: web-search.ts imports config.ts).
export { DEFAULT_SEARCH_MODEL };
