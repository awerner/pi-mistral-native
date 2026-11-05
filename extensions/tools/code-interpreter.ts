/**
 * pi tool for Mistral's code interpreter: `mistral_code_interpreter` over a
 * stateless one-shot Conversations API call. The chat path stays on Chat
 * Completions (ADR 0002) — `code_interpreter` is rejected there with HTTP
 * 400 code 1800 — so like web search (ADR 0018) this tool never continues a
 * conversation: every call is a fresh POST /v1/conversations with
 * `store: false`, and the returned `conversation_id` is discarded.
 *
 * Wire facts (live-probed 2026-11-03, fixtures in the test suite): the
 * request body uses `inputs[]`, NOT `messages[]`; the response's
 * `outputs[]` carries a `tool.execution` entry whose `info.result` is an
 * ARRAY of content chunks (NOT a JSON string, unlike web search) —
 * observed shapes are `{type:"text", text}` and
 * `{type:"file_url", file_url, file_name, file_type}` — plus `info.code`
 * (the executed Python source) and `info.code_output` (captured
 * stdout/stderr). A `message.output` entry also appears (carrying
 * `tool_file` chunks referencing the generated files) but is DISCARDED
 * here: only the tool.execution info is the tool's payload. Every request
 * carries a fixed top-level `instructions` string steering the
 * server-side agent to run the code interpreter (`tool_choice` hard
 * forcing is 422-rejected for builtin connectors). Two empty outcomes are
 * distinct wire shapes: a response with NO `tool.execution` entry means
 * the backend skipped execution (reported as skipped, retry-worthy —
 * mistral-large-4 accepts the request but silently skips the tool), while
 * a `tool.execution` entry with an empty `result` array is a genuinely
 * executed run with no output. Generated files arrive as signed blob URLs:
 * they go into the model-facing content/structuredContent but never into
 * the persisted `details` (docs/reference/tools.mdx, security rules).
 * mistral-small-latest / mistral-medium-latest / magistral-medium-latest
 * run the tool; the model comes from `knowledge.searchModel`
 * (default `mistral-small-latest`), and a 400 code 3004 refusal is mapped
 * to the same friendly error as web search.
 *
 * ADR 0020 — Code interpreter as a Conversations-backed tool.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import { getEffectiveSearchModel } from "../mistral/config.js";
import type { MistralClient } from "./mistral-client.js";
import { MistralApiError, createMistralClient } from "./mistral-client.js";

/** Dependencies of {@link createCodeInterpreterTool}: a lazy per-call client factory. */
export interface CodeInterpreterDeps {
	/** Resolves a client for one execute call (fresh API key + abort signal). */
	getClient: (ctx: ExtensionToolContext | undefined, signal?: AbortSignal) => Promise<MistralClient>;
}

type AnyToolDefinition = ToolDefinition<any, any>;

/** The tool type wire name. */
const TOOL_TYPE = "code_interpreter";

/** One mapped output chunk of a code-interpreter execution. */
interface OutputChunk {
	type: string;
	text?: string;
	fileUrl?: string;
	fileName?: string;
	fileType?: string;
}

/** Two-outcome parse of a Conversations code-interpreter response. */
interface ParsedInterpreterResult {
	/** False when no `tool.execution` entry matched: the backend skipped execution. */
	executed: boolean;
	chunks: OutputChunk[];
	code?: string;
	codeOutput?: string;
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
 * parseSearchUsage in web-search.ts.
 */
function parseInterpreterUsage(raw: Record<string, unknown>): NonNullable<AgentToolResult<any>["usage"]> {
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

/** Maps one raw result chunk defensively; unknown chunk shapes are skipped. */
function mapChunk(chunk: unknown): OutputChunk | undefined {
	if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) return undefined;
	const record = chunk as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") {
		return { type: "text", text: record.text };
	}
	if (record.type === "file_url" && typeof record.file_url === "string") {
		return {
			type: "file_url",
			fileUrl: record.file_url,
			...(typeof record.file_name === "string" ? { fileName: record.file_name } : {}),
			...(typeof record.file_type === "string" ? { fileType: record.file_type } : {}),
		};
	}
	// Unknown chunk types (e.g. future shapes) are folded away, never dumped.
	return undefined;
}

/**
 * Parses the `info` of the tool.execution entries of a /v1/conversations
 * response and maps `info.result` — an ARRAY of content chunks, NOT a JSON
 * string (unlike web search) — to OutputChunk records. The message.output
 * entry is never read — its text is not the tool's payload. Distinguishes
 * the two empty outcomes: `executed: false` (no tool.execution entry
 * matched — the backend skipped execution) from `executed: true` with an
 * empty chunk list (a genuinely executed run with no output). A matching
 * entry whose info.result is not a readable array throws so the caller can
 * fail loudly. Multiple executions concatenate their chunks in outputs
 * order, losing none.
 */
function parseInterpreterResult(response: unknown): ParsedInterpreterResult {
	if (response === null || typeof response !== "object" || Array.isArray(response)) {
		throw new Error("unreadable code-interpreter result: the response is not an object");
	}
	const outputs = (response as Record<string, unknown>).outputs;
	if (!Array.isArray(outputs)) {
		throw new Error("unreadable code-interpreter result: the response has no outputs array");
	}
	let sawExecution = false;
	const infos: Record<string, unknown>[] = [];
	for (const entry of outputs) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "tool.execution") continue;
		const name = record.name;
		const func = record.function;
		// Wire-verified 2026-11-03: `name`/`function` carry the requested
		// tool type — match on either.
		if (name !== TOOL_TYPE && func !== TOOL_TYPE) continue;
		sawExecution = true;
		const info = record.info;
		if (info !== null && typeof info === "object" && !Array.isArray(info)) {
			infos.push(info as Record<string, unknown>);
		}
	}
	if (!sawExecution) return { executed: false, chunks: [] };
	if (infos.length === 0) {
		throw new Error("unreadable code-interpreter result: the tool execution carries no readable info");
	}
	// The agent may execute the code interpreter more than once per turn —
	// concatenate the chunks of every execution in outputs order.
	const chunks: OutputChunk[] = [];
	let code: string | undefined;
	let codeOutput: string | undefined;
	for (const info of infos) {
		const result = info.result;
		if (!Array.isArray(result)) {
			throw new Error("unreadable code-interpreter result: info.result is not a chunk array");
		}
		for (const chunk of result) {
			const mapped = mapChunk(chunk);
			if (mapped !== undefined) chunks.push(mapped);
		}
		// code/code_output of the last execution that carries them wins.
		if (typeof info.code === "string") code = info.code;
		if (typeof info.code_output === "string") codeOutput = info.code_output;
	}
	return { executed: true, chunks, ...(code !== undefined ? { code } : {}), ...(codeOutput !== undefined ? { codeOutput } : {}) };
}

/** Renders the model-facing result text: code output first, then per-chunk lines. */
function formatChunks(chunks: OutputChunk[], codeOutput?: string): string {
	const lines: string[] = [];
	if (codeOutput !== undefined && codeOutput.length > 0) {
		lines.push(codeOutput);
	}
	for (const chunk of chunks) {
		if (chunk.type === "text" && chunk.text !== undefined) {
			lines.push(chunk.text);
		} else if (chunk.type === "file_url" && chunk.fileUrl !== undefined) {
			// Signed blob URL — model-facing content only, never persisted
			// into details.
			const name = chunk.fileName ?? "file";
			const type = chunk.fileType !== undefined ? ` (${chunk.fileType})` : "";
			lines.push(`${name}${type}: ${chunk.fileUrl}`);
		}
	}
	return lines.join("\n");
}

/**
 * Detects the wire-verified 3004 refusal (models without builtin-connector
 * support reject builtin connectors on /v1/conversations; live
 * 2026-11-03) in a 400 MistralApiError body. Parses defensively — anything
 * unparseable is not a 3004.
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

/** Builds the `mistral_code_interpreter` tool. */
function defineCodeInterpreterTool(deps: CodeInterpreterDeps): AnyToolDefinition {
	const { getClient } = deps;
	const name = "mistral_code_interpreter";
	return defineTool({
		name,
		label: "Mistral code interpreter",
		description:
			"Run Python code with Mistral's code_interpreter connector and return the output: captured stdout/stderr, printed text and generated files (as download links). " +
			"Use it for computations, data analysis, plotting and any task where executing code is more reliable than answering from memory.",
		parameters: Type.Object({
			prompt: Type.String({
				description: "The Python task for the code interpreter: what to compute, analyze or generate (the code itself is written server-side)",
			}),
		}),
		outputSchema: Type.Object({
			output: Type.Array(
				Type.Object({
					type: Type.String(),
					text: Type.Optional(Type.String()),
					fileUrl: Type.Optional(Type.String()),
					fileName: Type.Optional(Type.String()),
					fileType: Type.Optional(Type.String()),
				}),
			),
			code: Type.Optional(Type.String()),
			codeOutput: Type.Optional(Type.String()),
			// Present (true) only on the skipped-execution path; absent for
			// an executed run with no output and for chunks — callers
			// distinguish the outcomes programmatically.
			skipped: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const model = getEffectiveSearchModel();
			// details stay log-safe: no signed URLs, no server payload —
			// only identifiers, the prompt and outcome counters.
			const baseDetails: Record<string, unknown> = { tool: name, model, prompt: params.prompt };
			try {
				const client = await getClient(ctx, signal);
				const response = await client.createConversation({
					model,
					toolType: TOOL_TYPE,
					query: params.prompt,
					signal,
				});
				// Two distinct ok outcomes, never errors: the backend skipping
				// execution (no tool.execution entry — the message.output text
				// is discarded, so the model must learn about the skip from the
				// result text) is retry-worthy, while an executed run with an
				// empty result array genuinely produced no output.
				let parsed: ParsedInterpreterResult;
				try {
					parsed = parseInterpreterResult(response);
				} catch (error) {
					return fail(
						`${name} returned an unreadable code-interpreter result: ${errorMessage(error)}`,
						baseDetails,
					);
				}
				const chunks = parsed.chunks;
				const structured: Record<string, unknown> = {
					output: chunks as unknown as Record<string, unknown>[],
					...(parsed.code !== undefined ? { code: parsed.code } : {}),
					...(parsed.codeOutput !== undefined ? { codeOutput: parsed.codeOutput } : {}),
				};
				const record = response as Record<string, unknown>;
				const rawUsage = record.usage;
				const usage = rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage)
					? parseInterpreterUsage(rawUsage as Record<string, unknown>)
					: undefined;
				if (!parsed.executed) {
					return ok(
						"The code interpreter was skipped: the backend did not execute any code, so no output was produced. The prompt can be retried.",
						{ ...structured, skipped: true },
						{ ...baseDetails, skipped: true, chunks: 0 },
						usage,
					);
				}
				if (chunks.length === 0 && (parsed.codeOutput === undefined || parsed.codeOutput.length === 0)) {
					return ok(
						"The code interpreter ran but produced no output.",
						structured,
						{ ...baseDetails, chunks: 0 },
						usage,
					);
				}
				const text = formatChunks(chunks, parsed.codeOutput);
				return ok(text, structured, { ...baseDetails, chunks: chunks.length }, usage);
			} catch (error) {
				if (isConnectorRefusal(error)) {
					return fail(
						`The configured search model '${model}' does not support builtin connectors (Mistral error 3004). Set knowledge.searchModel to a code-interpreter-capable model (e.g. mistral-small-latest).`,
						baseDetails,
					);
				}
				return fail(`${name} failed: ${errorMessage(error)}`, { ...baseDetails, error: errorMessage(error) });
			}
		},
	});
}

/**
 * Builds the code-interpreter tool. `getClient` is called once per execute
 * call so each request uses the currently resolved API key and signal.
 */
export function createCodeInterpreterTool(deps: CodeInterpreterDeps): AnyToolDefinition {
	return defineCodeInterpreterTool(deps);
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
 * Registers the code-interpreter tool with pi, wiring a lazy client factory
 * that resolves the API key per execute call. The tool passes pi's per-call
 * abort signal through to the client request.
 */
export function registerCodeInterpreterTool(pi: ExtensionAPI): void {
	const getClient = async (ctx: ExtensionToolContext | undefined, _signal?: AbortSignal) => {
		const apiKey = await resolveApiKey(ctx);
		return createMistralClient({ apiKey });
	};
	pi.registerTool(createCodeInterpreterTool({ getClient }));
}
