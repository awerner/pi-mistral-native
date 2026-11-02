/**
 * pi tools for Mistral's web search: `mistral_web_search` and
 * `mistral_web_search_premium` over stateless one-shot Conversations API
 * calls. The chat path stays on Chat Completions (ADR 0002); these tools
 * never continue a conversation — every call is a fresh
 * POST /v1/conversations with `store: false`, and the returned
 * `conversation_id` is discarded.
 *
 * Wire facts (Lead-probed 2026-11-03, fixtures in the test suite): the
 * request body uses `inputs[]`, NOT `messages[]` (the endpoint rejects
 * `messages` as extra_forbidden); the response's `outputs[]` carries a
 * `tool.execution` entry whose `info.result` is a JSON string mapping
 * opaque hit ids to { url, title, description, snippets }, plus a
 * `message.output` entry that is DISCARDED here (only the hits are the
 * tool's payload). mistral-large-4 refuses builtin connectors on
 * /v1/conversations (400 code 3004), so the search model is configured
 * separately from the chat model (default `mistral-small-latest`).
 *
 * ADR 0018 — Web search as a Conversations-backed tool.
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
 * Parses the Conversations usage block (loose subset of the wire shape:
 * prompt_tokens/completion_tokens, optional prompt_tokens_details) into
 * pi's tool-result Usage. Cost stays 0: pay-per-use connector tokens
 * (`connector_tokens`) are not priceable locally. Same shape as
 * parseRagUsage in knowledge.ts.
 */
function parseSearchUsage(raw: Record<string, unknown>): NonNullable<AgentToolResult<any>["usage"]> {
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	const details = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
	const input = num(raw.prompt_tokens);
	const output = num(raw.completion_tokens);
	const cacheRead = num(details.cached_tokens);
	const cacheWrite = num(details.cache_write_tokens);
	return {
		input: Math.max(0, input - cacheRead - cacheWrite),
		output,
		cacheRead,
		cacheWrite,
		totalTokens: Math.max(0, input - cacheRead - cacheWrite) + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Extracts the `info.result` JSON string from the tool.execution entry of a
 * /v1/conversations response and maps the hit object's VALUES (opaque ids
 * discarded) to SearchHit records. The message.output entry is never read —
 * its text is not the tool's payload.
 */
function parseSearchHits(response: unknown, toolType: SearchToolType): SearchHit[] {
	if (response === null || typeof response !== "object" || Array.isArray(response)) {
		throw new Error("unreadable search result: the response is not an object");
	}
	const outputs = (response as Record<string, unknown>).outputs;
	if (!Array.isArray(outputs)) {
		throw new Error("unreadable search result: the response has no outputs array");
	}
	let resultJson: string | undefined;
	for (const entry of outputs) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "tool.execution") continue;
		const name = record.name;
		const func = record.function;
		// Wire-verified 2026-11-03: `name` carries the requested tool type,
		// `function` stays "web_search" for both variants — match on either.
		if (name !== toolType && name !== func && func !== toolType) continue;
		const info = record.info;
		if (info !== null && typeof info === "object" && typeof (info as Record<string, unknown>).result === "string") {
			resultJson = (info as Record<string, string>).result;
		}
	}
	if (resultJson === undefined) return [];
	const hitsObject: unknown = JSON.parse(resultJson);
	if (hitsObject === null || typeof hitsObject !== "object" || Array.isArray(hitsObject)) {
		throw new Error("unreadable search result: the tool result is not a hit map");
	}
	const hits: SearchHit[] = [];
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
	return hits;
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

/** Builds the two search tools sharing one handler over the toolType. */
function defineSearchTool(
	deps: WebSearchToolsDeps,
	name: "mistral_web_search" | "mistral_web_search_premium",
	label: string,
	description: string,
	toolType: SearchToolType,
): AnyToolDefinition {
	const { getClient } = deps;
	return defineTool({
		name,
		label,
		description,
		parameters: Type.Object({
			query: Type.String({ description: "The web search query" }),
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
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const model = getEffectiveSearchModel();
			const baseDetails: Record<string, unknown> = { tool: name, model, query: params.query };
			try {
				const client = await getClient(ctx, signal);
				const response = await client.createConversation({
					model,
					toolType,
					query: params.query,
					signal,
				});
				// Zero hits is the legitimate search-skip case (the backend
				// decided not to search): an ok result, never an error.
				let hits: SearchHit[];
				try {
					hits = parseSearchHits(response, toolType);
				} catch (error) {
					return fail(
						`${name} returned an unreadable search result: ${errorMessage(error)}`,
						baseDetails,
					);
				}
				const structured: Record<string, unknown> = { hits: hits as unknown as Record<string, unknown>[] };
				const record = response as Record<string, unknown>;
				const rawUsage = record.usage;
				const usage = rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage)
					? parseSearchUsage(rawUsage as Record<string, unknown>)
					: undefined;
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
				return fail(`${name} failed: ${errorMessage(error)}`, { ...baseDetails, error: errorMessage(error) });
			}
		},
	});
}

/**
 * Builds the two web-search tools. `getClient` is called once per execute
 * call so each request uses the currently resolved API key and signal.
 */
export function createWebSearchTools(deps: WebSearchToolsDeps): AnyToolDefinition[] {
	const standard = defineSearchTool(
		deps,
		"mistral_web_search",
		"Mistral web search",
		"Search the web with Mistral's web_search connector and return the hits (url, title, description, snippets) for the query.",
		"web_search",
	);
	const premium = defineSearchTool(
		deps,
		"mistral_web_search_premium",
		"Mistral web search (premium)",
		"Search the web with Mistral's premium web_search_premium connector and return the hits for the query. " +
			"Premium search quality is pay-per-use — it costs extra per call, and the caller opts in deliberately by using this tool.",
		"web_search_premium",
	);
	return [standard, premium];
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
 * Registers the web-search tools with pi, wiring a lazy client factory that
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
