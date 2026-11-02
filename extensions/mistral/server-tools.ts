/**
 * Server-side tools and connectors: pure configuration, request
 * and report helpers for Mistral's server-executed tools (web_search,
 * web_search_premium, image_generation, code_interpreter), custom connectors
 * and the /v1/agents/completions agent mode. No fetch, no I/O — the stream
 * in extensions/mistral.ts owns transport, these functions own the wire
 * shapes.
 *
 * Enablement is environment-driven, per key
 * `env?.[key] ?? process.env[key]` (pi's ProviderEnv overrides process.env):
 * - `MISTRAL_SERVER_TOOLS` — comma/space separated server tool names;
 *   unknown values are ignored, never thrown.
 * - `MISTRAL_CONNECTORS` — comma/space separated connector ids or names.
 * - `MISTRAL_AGENT_ID` — non-empty value switches the stream to the agent
 *   completions endpoint with a minimal request body.
 *
 * When a `mistral-native.json` file config is passed,
 * its validated `serverTools`/`connectors`/`agentId` keys win over the
 * environment variables; the environment still applies for keys the file
 * leaves unset.
 *
 * ADR 0007 — Server-side tools as opaque content
 * ADR 0010 — Configuration via mistral-native.json
 */

import type { MistralFileConfig } from "./config.js";

/** Server-side tool types accepted in a chat request's `tools` array. */
export type MistralServerToolType = "web_search" | "web_search_premium" | "image_generation" | "code_interpreter";

/**
 * Server tool types the Chat Completions endpoint accepts
 * (wire-verified 2026-11-03: web_search, web_search_premium and
 * code_interpreter return 400 code 1800 there — they are
 * Conversations/Agents-API-only; image_generation and connector entries
 * are accepted).
 */
export const CHAT_COMPLETIONS_SERVER_TOOLS: readonly MistralServerToolType[] = ["image_generation"];

/** Server-side tool configuration resolved from the environment. */
export interface ServerToolsConfig {
	/** Enabled Mistral built-in server-side tools. */
	serverTools: MistralServerToolType[];
	/** Enabled connector ids or names (chat request `{type:"connector"}` entries). */
	connectorIds: string[];
	/** Agent id for /v1/agents/completions; undefined = normal chat completions. */
	agentId: string | undefined;
	/** Whether any server-side execution surface is enabled. */
	serverExecutionPossible: boolean;
}

/** Known server tool names (wire `type` values, vendor/mistral-openapi.yaml). */
const KNOWN_SERVER_TOOLS: readonly string[] = [
	"web_search",
	"web_search_premium",
	"image_generation",
	"code_interpreter",
];

/** Split a comma/space separated list into trimmed non-empty values. */
function splitList(value: string | undefined): string[] {
	if (typeof value !== "string") return [];
	return value
		.split(/[,\s]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Resolve the server-side tool configuration from the environment: for each
 * key, `env?.[key] ?? process.env[key]`. Unknown `MISTRAL_SERVER_TOOLS`
 * values are ignored (never thrown); an empty-string value suppresses the
 * process.env fallback for that key.
 *
 * With `fileConfig` (the effective `mistral-native.json` config),
 * its validated keys take precedence over the environment: a defined
 * `fileConfig.serverTools` wins over `MISTRAL_SERVER_TOOLS`, `connectors`
 * over `MISTRAL_CONNECTORS`, and a non-undefined `agentId` over
 * `MISTRAL_AGENT_ID`. The `fileConfig` argument is optional: calls that
 * omit it resolve from the environment only.
 */
export function parseServerToolsConfig(
	env: Record<string, string | undefined> | undefined,
	fileConfig?: MistralFileConfig,
): ServerToolsConfig {
	const read = (key: string): string | undefined => env?.[key] ?? process.env[key];
	const serverTools = (fileConfig?.serverTools ?? splitList(read("MISTRAL_SERVER_TOOLS"))).filter(
		(name): name is MistralServerToolType => (KNOWN_SERVER_TOOLS as readonly string[]).includes(name),
	);
	const connectorIds = fileConfig?.connectors ?? splitList(read("MISTRAL_CONNECTORS"));
	const agentIdFromEnv = read("MISTRAL_AGENT_ID");
	const agentId =
		fileConfig?.agentId !== undefined
		? fileConfig.agentId
			: typeof agentIdFromEnv === "string" && agentIdFromEnv.trim().length > 0
				? agentIdFromEnv.trim()
				: undefined;
	return {
		serverTools,
		connectorIds,
		agentId,
		serverExecutionPossible: serverTools.length > 0 || connectorIds.length > 0 || agentId !== undefined,
	};
}

/**
 * Chat-request `tools` entries for the configured server-side surfaces:
 * `{type:"web_search"}` style entries for built-ins, `{type:"connector",
 * connector_id:"..."}` (CustomConnector) for connectors. The optional
 * `tool_configuration` field is deliberately omitted.
 */
export function serverToolWireEntries(
	config: ServerToolsConfig,
): Array<{ type: MistralServerToolType } | { type: "connector"; connector_id: string }> {
	const entries: Array<{ type: MistralServerToolType } | { type: "connector"; connector_id: string }> = [];
	for (const tool of config.serverTools) {
		entries.push({ type: tool });
	}
	for (const connectorId of config.connectorIds) {
		entries.push({ type: "connector", connector_id: connectorId });
	}
	return entries;
}

/**
 * Chat-request `tools` entries the Chat Completions endpoint accepts:
 * built-ins filtered to `CHAT_COMPLETIONS_SERVER_TOOLS` plus connector
 * entries (same entry shapes as `serverToolWireEntries`). The dropped
 * built-ins are the complement — see `unsupportedChatCompletionsServerTools`.
 */
export function chatCompletionsServerToolEntries(
	config: ServerToolsConfig,
): Array<{ type: MistralServerToolType } | { type: "connector"; connector_id: string }> {
	const entries: Array<{ type: MistralServerToolType } | { type: "connector"; connector_id: string }> = [];
	for (const tool of config.serverTools) {
		if ((CHAT_COMPLETIONS_SERVER_TOOLS as readonly string[]).includes(tool)) {
			entries.push({ type: tool });
		}
	}
	for (const connectorId of config.connectorIds) {
		entries.push({ type: "connector", connector_id: connectorId });
	}
	return entries;
}

/**
 * Configured server tool types the Chat Completions endpoint rejects
 * (the complement of `CHAT_COMPLETIONS_SERVER_TOOLS`), deduped,
 * config order preserved.
 */
export function unsupportedChatCompletionsServerTools(config: ServerToolsConfig): MistralServerToolType[] {
	const dropped: MistralServerToolType[] = [];
	for (const tool of config.serverTools) {
		if (!(CHAT_COMPLETIONS_SERVER_TOOLS as readonly string[]).includes(tool) && !dropped.includes(tool)) {
			dropped.push(tool);
		}
	}
	return dropped;
}

/**
 * Minimal `/v1/agents/completions` request body
 * (AgentsCompletionRequest, `additionalProperties: false`): exactly
 * `agent_id`, `messages` and `stream: true`, plus `max_tokens` when defined.
 * No `model`, `temperature` or `stream_options` — the schema rejects them.
 */
export function buildAgentsRequestBody(
	messages: unknown,
	agentId: string,
	maxTokens: number | undefined,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		agent_id: agentId,
		messages,
		stream: true,
	};
	if (maxTokens !== undefined) {
		body.max_tokens = maxTokens;
	}
	return body;
}

/**
 * Opaque assistant-text report for one server-executed tool call
 * (server-side executions never become pi toolCall blocks, which pi's agent
 * loop would execute client-side).
 *
 * ADR 0007 — Server-side tools as opaque content
 */
export function formatServerToolReport(name: string, argumentsText: string, resultText: string | undefined, failed: boolean): string {
	return (
		`[Mistral server-side tool: ${name} — executed by Mistral${failed ? ", FAILED" : ""}]\n` +
		`Arguments: ${argumentsText}\n` +
		`Result: ${resultText ?? "(no result returned)"}`
	);
}
