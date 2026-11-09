/**
 * Native Mistral provider for the pi coding agent.
 *
 * Registers the `mistral-native` provider against Mistral's OpenAI-compatible
 * chat-completions endpoint (`https://api.mistral.ai/v1`) with a custom
 * `mistral-chat` API implemented natively via `streamSimple`. Mistral has no
 * public OAuth flow, so access is an API-key credential resolved through
 * AUTH_FALLBACK_CHAIN below. The provider is registered as a full native
 * pi-ai `Provider` (built via `createProvider`) whose `ApiKeyAuth` owns the
 * guided `/login` flow with the region picker (extensions/mistral/auth.ts);
 * pi persists the credential itself. It also registers the knowledge tools:
 * OCR, embeddings, moderation and classification, and the library/RAG tools
 * for files, libraries, documents and queries.
 *
 * The model catalog is dynamic: `refreshModels` restores pi's persisted
 * snapshot offline and fetches `GET /v1/models` when network access is
 * allowed; the static `MODELS` list is the offline fallback. Model costs
 * come from a sourced per-family rate card with config overrides and
 * visible fall-through.
 *
 * The stream implements pi's custom-provider event contract
 * (docs/custom-provider.md, "Implement custom streaming") and Mistral's
 * block-array `delta.content` wire format: reasoning models stream
 * `[{type:"thinking",...},{type:"text",...}]` instead of a plain string
 * (vendor/mistral-openapi.yaml: ContentChunk/ThinkChunk). String content,
 * block-array content, and split tool-call deltas are all assembled into
 * pi's text/thinking/toolCall blocks. The full nine-type ContentChunk union
 * is covered with no silent content loss: `text` and `thinking` map to pi
 * blocks, `reference` citation chunks map to text citation markers, and
 * every other type is rejected with a clear error.
 *
 * Implementation note: only root imports from `@earendil-works/pi-ai` are
 * used. Pi's extension loader aliases the package root to its compat
 * entrypoint, so subpath imports (e.g. `api/transform-messages`) would not
 * resolve inside the installed pi runtime. Everything not exported from the
 * root (message replay filtering, retries, SSE parsing, surrogates
 * sanitizing, token estimation) is implemented locally against the vendored
 * OpenAPI spec.
 *
 * Decisions: ADR 0002 — Mistral-native provider for pi;
 * ADR 0004 — API-key credential chain without Mistral OAuth; ADR 0005 — OCR,
 * embeddings, moderations/classifications as pi tools; ADR 0006 — Knowledge API
 * tools; ADR 0013 — Per-family rate card with sourced prices and visible
 * fall-through; ADR 0014 — Content chunk coverage: map or reject, never drop;
 * ADR 0021 — Cost estimates marked as not provider-billed.
 */

import {
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	createProvider,
	getCurrentTools,
	getIdentityHeaders,
	getSystemMessageText,
	parseStreamingJson,
	parseToolCallArguments,
	resolveTranscript,
} from "@earendil-works/pi-ai";
import type {
	AnyModel,
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Credential,
	ImageContent,
	Message,
	Model,
	ModelCost,
	ModelInputLimits,
	ModelPromptCache,
	ModelsStoreEntry,
	Provider,
	ProviderId,
	ProviderStreams,
	RefreshModelsContext,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ThinkingLevelMap,
	Tool,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { createMistralApiKeyAuth } from "./mistral/auth.js";
import { registerMistralCommands } from "./mistral/commands.js";
import { MISTRAL_BASE_URL } from "./mistral/api.js";
import { getEffectiveEndpoint, getEffectiveMistralConfig, MISTRAL_REGION_BASE_URLS, refreshMistralConfig, resolveMistralRegionBaseUrl } from "./mistral/config.js";
import type { MistralRegion } from "./mistral/config.js";
import { registerKnowledgeTools as registerOcrKnowledgeTools } from "./mistral/knowledge.js";
import {
	buildAgentsRequestBody,
	chatCompletionsServerToolEntries,
	formatServerToolReport,
	parseServerToolsConfig,
	unsupportedChatCompletionsServerTools,
} from "./mistral/server-tools.js";
import type { MistralServerToolType, ServerToolsConfig } from "./mistral/server-tools.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerWebSearchTools } from "./tools/web-search.js";
import { registerCodeInterpreterTool } from "./tools/code-interpreter.js";
import { registerConnectorTools } from "./tools/connectors.js";
import { registerConnectorLoaderTools } from "./tools/loader.js";

// Re-export for backwards compatibility; extensions/mistral/api.ts is the single source.
export { MISTRAL_BASE_URL };

/** Custom pi API id implemented by this extension's `streamSimple`. */
export const MISTRAL_API = "mistral-chat";

/** Per-million-token USD cost rates for one model. */
export interface ModelRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** One family rate-card entry; `match` is a model-id substring, `""` matches every id. */
export interface RateCardEntry {
	match: string;
	rates: ModelRates;
}

/**
 * Chat model entry as registered with pi (mutable shape of `ProviderModelConfig`).
 * The optional fields are carried over when restoring a persisted snapshot so
 * a restore round-trip does not lose model fidelity.
 */
export interface MistralModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: ModelRates & Pick<ModelCost, "tiers">;
	contextWindow: number;
	maxTokens: number;
	api: string;
	/** Maps pi thinking levels to provider/model-specific values. */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Prompt cache lifetimes per retention tier. */
	promptCache?: ModelPromptCache;
	/** Provider input limits and cache-safe image preprocessing metadata. */
	inputLimits?: ModelInputLimits;
	/** Custom headers for this model. */
	headers?: Record<string, string>;
	/** Default sampling parameters. */
	samplingParams?: Record<string, unknown>;
	/** Compatibility overrides for OpenAI-compatible APIs. */
	compat?: Model<"openai-completions">["compat"] | Model<"mistral-conversations">["compat"];
}

/** Chat model entry shape; exported as a stable alias of MistralModelConfig. */
export type MistralModel = MistralModelConfig;

/**
 * Documented per-model output limits, checked most-specific-first like the
 * rate card: the first entry whose `match` string is a substring of the model
 * id applies. Mistral-native model pages document no per-model output limit
 * at all, so the live mapping derives `maxTokens` from the wire-enforced
 * completion ceiling unless an entry here overrides it. The hosted
 * third-party models are the only ones with an officially documented
 * output token limit (128k).
 *
 * Update process: re-verify against the model pages on docs.mistral.ai and
 * record source URL and last-verified date per entry, so drift stays
 * auditable (mirrors the rate-card process).
 *
 * ADR 0017 — Documented max-output mapping over fixed clamp
 */
export const DOCUMENTED_OUTPUT_LIMITS: readonly { match: string; maxOutputTokens: number }[] = [
	// zai-glm (zai-glm-5-3, zai-glm-5-3-flash): 128k output token limit.
	// Source: https://docs.mistral.ai/models/zai-glm-5-3 and
	// https://docs.mistral.ai/models/zai-glm-5-3-flash, verified 2026-11-02.
	{ match: "zai-glm", maxOutputTokens: 131072 },
	// deepseek (deepseek-v4-1-flash-1017): 128k output token limit. Source:
	// https://docs.mistral.ai/models/deepseek-v4-flash-1017, verified 2026-11-02.
	{ match: "deepseek", maxOutputTokens: 131072 },
];

/**
 * Wire-enforced completion ceilings the model pages do not document,
 * checked most-specific-first like the rate card: the first entry whose
 * `match` string is a substring of the model id applies. Only wire-verified
 * ceilings get entries; the conservative fallback
 * (`COMPLETION_CEILING_FALLBACK`) applies to everything else — a too-small
 * value merely caps output, a too-large one hard-fails requests with 400
 * code 3058 (invalid_request_max_tokens).
 *
 * ADR 0017 — Documented max-output mapping over fixed clamp
 */
export const API_ENFORCED_COMPLETION_CEILINGS: readonly { match: string; completionCeiling: number }[] = [
	// mistral-large-4 (and the -0 alias): 262144. Wire-probed 2026-11-03:
	// POST /v1/chat/completions with an oversized max_tokens returns 400 code
	// 3058 (invalid_request_max_tokens) whose message names the ceiling;
	// max_tokens 262144 is accepted, 262145 is rejected.
	{ match: "mistral-large-4", completionCeiling: 262144 },
];

/** Conservative completion-token ceiling for models without a wire-verified entry. */
export const COMPLETION_CEILING_FALLBACK = 262144;

/**
 * Wire-enforced completion-token ceiling for one model id: the first
 * matching `API_ENFORCED_COMPLETION_CEILINGS` entry, otherwise the
 * conservative `COMPLETION_CEILING_FALLBACK`.
 *
 * ADR 0017 — Documented max-output mapping over fixed clamp
 */
export function completionCeilingForModel(id: string): number {
	for (const entry of API_ENFORCED_COMPLETION_CEILINGS) {
		if (id.includes(entry.match)) {
			return entry.completionCeiling;
		}
	}
	return COMPLETION_CEILING_FALLBACK;
}

/**
 * Maximum completion tokens for one model id: the documented output limit
 * when a `DOCUMENTED_OUTPUT_LIMITS` entry matches (documented limits are the
 * tighter, sourced facts), otherwise the wire-enforced completion ceiling
 * capped at the context window — the API rejects any larger max_tokens with
 * 400 code 3058 (invalid_request_max_tokens).
 *
 * ADR 0017 — Documented max-output mapping over fixed clamp
 */
export function documentedMaxTokensForModel(id: string, contextWindow: number): number {
	for (const entry of DOCUMENTED_OUTPUT_LIMITS) {
		if (id.includes(entry.match)) {
			return Math.min(entry.maxOutputTokens, contextWindow);
		}
	}
	return Math.min(completionCeilingForModel(id), contextWindow);
}

/**
 * Family rate card for models missing from the priced catalog, checked
 * most-specific-first: the first entry whose `match` is a substring of the
 * model id applies. The final `""` entry is the catch-all fallback
 * (approximation at the flagship mistral-large-4 rates) so every id gets a
 * price; ids that hit it get fall-through pricing and are flagged approximate
 * (`fallThroughModelIds`). Units: USD per million
 * tokens (input/output/cacheRead/cacheWrite).
 *
 * `cacheWrite` is 0 everywhere: Mistral bills cache reads at 10% of the input
 * price and publishes no separate cache-write price
 * (https://docs.mistral.ai/studio/conversations/advanced/prompt-caching).
 *
 * Update process: verify each rate against the official family pricing
 * table at implementation time (https://docs.mistral.ai/inference/pricing)
 * and record the source URL and last-verified date as a comment on every
 * entry, so drift stays auditable.
 *
 * Last verified: 2026-10-31.
 *
 * ADR 0013 — Per-family rate card with sourced prices and visible fall-through
 */
export const DEFAULT_RATES: readonly RateCardEntry[] = [
	// mistral-large (mistral-large-4): 0.70/2.10/0.07. Source:
	// https://docs.mistral.ai/models/mistral-large-4-0 and
	// https://docs.mistral.ai/inference/pricing, verified 2026-10-31.
	{ match: "mistral-large", rates: { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 } },
	// mistral-medium (mistral-medium-3-5): 1.50/7.50/0.15. Source:
	// https://docs.mistral.ai/models/mistral-medium-3-5-26-04 (deprecated,
	// retires 2027-04-30), verified 2026-10-31. cacheRead is not published;
	// derived from the 10% cache-read rule
	// (https://docs.mistral.ai/studio/conversations/advanced/prompt-caching).
	{ match: "mistral-medium", rates: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 } },
	// mistral-small (mistral-small-4): 0.15/0.60/0.015. Source:
	// https://docs.mistral.ai/inference/pricing and
	// https://docs.mistral.ai/models/mistral-small-4-0-26-03, verified 2026-10-31.
	{ match: "mistral-small", rates: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 } },
	// magistral (magistral-medium-1.2): 2.00/5.00/0.20. Source:
	// https://docs.mistral.ai/models/magistral-medium-1-2-25-09 (deprecated
	// 2026-05-22), verified 2026-10-31.
	{ match: "magistral", rates: { input: 2, output: 5, cacheRead: 0.2, cacheWrite: 0 } },
	// codestral (codestral-25-08): 0.30/0.90/0.03. Source:
	// https://docs.mistral.ai/inference/pricing and
	// https://docs.mistral.ai/models/codestral-25-08, verified 2026-10-31.
	{ match: "codestral", rates: { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0 } },
	// ministral (ministral-3-8b 0.15/0.15/0.015; 14b 0.20/0.20/0.02 — one
	// family entry at the 8b rates). Source:
	// https://docs.mistral.ai/inference/pricing, verified 2026-10-31.
	{ match: "ministral", rates: { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 } },
	// pixtral-large (pixtral-large-24-11): 2.00/6.00/0.20, most-specific-first
	// so it shadows the pixtral entry below. Source:
	// https://docs.mistral.ai/models/pixtral-large-24-11 (deprecated
	// 2026-02-27), verified 2026-10-31. Deprecated/retired — the card serves
	// ids that may still appear on gateways.
	{ match: "pixtral-large", rates: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 } },
	// pixtral (pixtral-12b-24-09): 0.15/0.15/0.015. Source:
	// https://docs.mistral.ai/models/pixtral-12b-24-09 (deprecated
	// 2026-02-27), verified 2026-10-31.
	{ match: "pixtral", rates: { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 } },
	// devstral (devstral-2): 0.40/2.00/0.04. Source:
	// https://docs.mistral.ai/models/devstral-2-25-12 (deprecated
	// 2026-05-22), verified 2026-10-31.
	{ match: "devstral", rates: { input: 0.4, output: 2, cacheRead: 0.04, cacheWrite: 0 } },
	// open-mistral (open-mistral-nemo): 0.15/0.15/0.015. Source:
	// https://docs.mistral.ai/models/mistral-nemo-12b-24-07 (deprecated
	// 2026-05-22), verified 2026-10-31.
	{ match: "open-mistral", rates: { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 } },
	// Catch-all ("" matches every id): mirrors the flagship rates as a
	// fall-through approximation.
	// Source: https://docs.mistral.ai/models/mistral-large-4-0 and
	// https://docs.mistral.ai/inference/pricing, verified 2026-10-31.
	{ match: "", rates: { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 } },
];

/**
 * Minimal wire format of one `GET /v1/models` entry
 * (vendor/mistral-openapi.yaml: BaseModelCard | FTModelCard).
 */
export interface MistralModelCard {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
	capabilities?: {
		completion_chat?: boolean;
		completion_fim?: boolean;
		function_calling?: boolean;
		fine_tuning?: boolean;
		vision?: boolean;
		reasoning?: boolean;
		classification?: boolean;
		moderation?: boolean;
		ocr?: boolean;
		audio?: boolean;
	};
	name?: string | null;
	description?: string | null;
	max_context_length?: number;
	aliases?: string[];
	deprecation?: string | null;
	deprecation_replacement_model?: string | null;
	default_model_temperature?: number | null;
	internal?: boolean;
	billing_model_name?: string | null;
	type?: "base" | "fine-tuned";
	/** Fine-tuned model cards only. */
	archived?: boolean;
}

/**
 * Static model catalog: the offline fallback while no persisted snapshot
 * exists. Facts mirror the official model card (mistral-large-4): 1M-token
 * context, $0.70/$2.10/$0.07 per million tokens
 * (https://docs.mistral.ai/models/mistral-large-4-0, verified 2026-11-02).
 * `maxTokens` follows the same mapping as the live catalog — the
 * wire-enforced completion ceiling, since the API rejects max_tokens
 * above 262144 with 400 code 3058 (wire-verified 2026-11-03, see
 * `API_ENFORCED_COMPLETION_CEILINGS`), capped at the context window.
 * `thinkingLevelMap` and `compat` flags mirror the verified wire behavior.
 *
 * ADR 0017 — Documented max-output mapping over fixed clamp
 */
export const MODELS: MistralModelConfig[] = [
	{
		id: "mistral-large-4",
		name: "Mistral Large 4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 262144,
		api: MISTRAL_API,
		thinkingLevelMap: {
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		},
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsMidConvoSystemMessages: false,
		},
	},
];

/**
 * API-key resolution order for the provider.
 *
 * 1. `auth-json` — a stored `mistral-native` API-key credential in
 *    `~/.pi/agent/auth.json` (pi's `/login` persists the credential our
 *    native ApiKeyAuth.login returns; a `!command` entry is resolved by pi
 *    itself, e.g. from a secret manager).
 * 2. `env` — the `MISTRAL_API_KEY` environment variable, resolved by our
 *    native `ApiKeyAuth.resolve` (extensions/mistral/auth.ts).
 *
 * The native ApiKeyAuth implements this chain in its `resolve()`, so this
 * constant exists for tests, documentation and verification, not to drive
 * resolution.
 *
 * ADR 0004 — API-key credential chain without Mistral OAuth
 */
export const AUTH_FALLBACK_CHAIN = ["auth-json", "env"] as const;

export const MISTRAL_API_KEY_ENV_VAR = "MISTRAL_API_KEY";
type FetchImpl = typeof fetch;

// =============================================================================
// Wire types (vendor/mistral-openapi.yaml: ChatCompletionRequest,
// CompletionChunk, DeltaMessage, ContentChunk, ThinkChunk, ToolCall)
// =============================================================================

/** ThinkChunk nested part: TextChunk | ReferenceChunk | ToolReferenceChunk (spec). */
interface MistralThinkPart {
	type?: string;
	text?: string;
	reference_ids?: (number | string)[];
}

/** ThinkChunk: reasoning content streamed as an array of nested chunks. */
interface MistralThinkChunk {
	type?: string;
	thinking?: MistralThinkPart[];
	signature?: string | null;
	closed?: boolean;
}

/**
 * ContentChunk union (vendor/mistral-openapi.yaml): the full nine-type
 * discriminator union (`text`, `image_url`, `document_url`, `reference`,
 * `file`, `thinking`, `input_audio`, `resource`, `resource_link`), extended
 * with every delta-side chunk shape. pi can only express `text` and
 * `thinking` chunks; `reference` maps to a citation marker, every other
 * type is rejected loudly — no silent content loss.
 *
 * ADR 0014 — Content chunk coverage: map or reject, never drop
 */
interface MistralContentChunk {
	type?: string;
	text?: string;
	thinking?: MistralThinkPart[];
	signature?: string | null;
	closed?: boolean;
	/** ReferenceChunk: citation indices into the references mapping. */
	reference_ids?: (number | string)[];
	/** ImageURLChunk. */
	image_url?: { url: string; detail?: string | null } | string;
	/** DocumentURLChunk. */
	document_url?: string;
	document_name?: string | null;
	/** FileChunk. */
	file_id?: string;
	/** AudioChunk: bare base64 string (not an OpenAI-style object). */
	input_audio?: string;
	/** ResourceChunk: uri plus embedded TextChunk/ImageURLChunk content. */
	uri?: string;
	content?: { type?: string; text?: string; image_url?: { url: string } | string };
	/** ResourceLinkChunk. */
	metadata?: Record<string, string | number | boolean> | null;
}

interface MistralToolCallDelta {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
	metadata?: { tool_type?: string; integration_id?: string; locale?: unknown } | undefined;
}

interface MistralUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
	/** Field names seen on Mistral-compatible gateways; parsed defensively. */
	num_cached_tokens?: number;
	cached_tokens?: number;
	cache_write_tokens?: number;
}

interface MistralChatChunk {
	id?: string;
	model?: string;
	usage?: MistralUsage;
	choices?: {
		index?: number;
		delta?: {
			role?: string;
			content?: string | MistralContentChunk[] | null;
			tool_calls?: MistralToolCallDelta[];
			/** Server-executed tool result (delta.role === "tool"). */
			tool_call_id?: string;
			metadata?: { tool_call_result?: { type?: string; errors?: unknown } | undefined } | undefined;
		};
		finish_reason?: string | null;
		usage?: MistralUsage;
	}[];
}

interface MistralWireToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface MistralWireContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: { url: string };
}

interface MistralWireMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | MistralWireContentPart[] | null;
	tool_calls?: MistralWireToolCall[];
	tool_call_id?: string;
	name?: string;
}

// =============================================================================
// Local helpers (not exported from the pi-ai root entrypoint)
// =============================================================================

/** Mirror of pi-ai's token estimation constants (utils/estimate.ts). */
const CHARS_PER_TOKEN = 3.5;
const ESTIMATED_IMAGE_CHARS = 4800;
/** Mirror of pi-ai's context clamp safety margin (api/simple-options.ts). */
const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;
const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

/**
 * Remove unpaired Unicode surrogates, which break JSON serialization in many
 * API providers. Mirror of pi-ai's sanitizeSurrogates (utils/sanitize-unicode.ts).
 */
function sanitizeSurrogates(text: string): string {
	// eslint-disable-next-line no-control-regexp
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function safeJsonStringLength(value: unknown): number {
	try {
		return (JSON.stringify(value) ?? "").length;
	} catch {
		return 0;
	}
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateTextAndImageContentTokens(content: string | readonly (TextContent | ImageContent)[]): number {
	if (typeof content === "string") return estimateTextTokens(content);
	let chars = 0;
	for (const block of content) {
		chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function estimateToolsTokens(tools: readonly { name: string }[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(JSON.stringify(tools) ?? "");
}

/** Mirror of pi-ai's estimateMessageTokens, used only to clamp max_tokens. */
function estimateMessageTokens(message: Message): number {
	switch (message.role) {
		case "system": {
			let tokens = estimateTextTokens(getSystemMessageText(message));
			tokens += estimateToolsTokens(message.toolsAdded);
			tokens += estimateToolsTokens(message.toolsRemoved);
			return tokens;
		}
		case "user":
			return estimateTextAndImageContentTokens(message.content);
		case "toolResult":
			return estimateTextAndImageContentTokens(message.content);
		case "assistant": {
			let chars = 0;
			for (const block of message.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else chars += block.name.length + safeJsonStringLength(block.arguments);
			}
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
	}
}

function estimateContextTokens(messages: readonly Message[]): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return tokens;
}

/**
 * Clamp max_tokens for the request path (mirrors pi-ai's
 * clampMaxTokensToContext, api/simple-options.ts) extended with the
 * wire-enforced completion ceiling: Mistral rejects a larger max_tokens with
 * 400 code 3058 (invalid_request_max_tokens), so the ceiling also rescues
 * STALE persisted snapshots (v0.1.0-era `maxTokens: 1048576` values) until
 * the self-healing catalog refresh overwrites them.
 */
function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number {
	const ceiling = completionCeilingForModel(model.id);
	if (model.contextWindow <= 0) return Math.min(ceiling, Math.max(MIN_MAX_TOKENS, maxTokens));
	const available = model.contextWindow - estimateContextTokens(context.messages) - CONTEXT_SAFETY_TOKENS;
	return Math.min(ceiling, maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}… [truncated]` : text;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of headers.entries()) record[key] = value;
	return record;
}

/** Error thrown for non-2xx Mistral responses; carries the HTTP status. */
class MistralApiError extends Error {
	readonly status: number | undefined;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "MistralApiError";
		this.status = status;
	}
}

function formatError(error: unknown): string {
	if (error instanceof MistralApiError) return error.message;
	if (error instanceof Error) return error.message;
	return JSON.stringify(error) ?? String(error);
}

/**
 * Guarded overflow normalization (custom-provider.md, "Report failures and
 * usage"): Mistral's own overflow message usually matches pi's built-in
 * overflow patterns, but the wording varies by model and gateway. Append the
 * `context_length_exceeded` marker (recognized by pi's isContextOverflow) so
 * compaction triggers reliably. Rate limits and other transient failures must
 * not match these patterns.
 */
const MISTRAL_OVERFLOW_PATTERNS = [
	/too large for model/i,
	/maximum context length/i,
	/exceeds? (?:the )?context (?:window|length|size)/i,
];

function normalizeOverflowErrorMessage(output: AssistantMessage): void {
	if (output.stopReason !== "error") return;
	const message = output.errorMessage;
	if (!message) return;
	if (/context[_ ]length[_ ]exceeded/i.test(message)) return;
	if (MISTRAL_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) {
		output.errorMessage = `${message}\ncontext_length_exceeded`;
	}
}

// =============================================================================
// Request building
// =============================================================================

function toolDefinition(tool: Tool): { type: "function"; function: { name: string; description: string; parameters: unknown } } {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

/**
 * Provider request headers; a null value suppresses a default header with the
 * same name (pi's ProviderHeaders contract).
 */
type ProviderHeaders = Record<string, string | null>;

/** Whether an Authorization header is present in provider request headers. */
function hasAuthorizationHeader(headers: ProviderHeaders | undefined): boolean {
	if (!headers) return false;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === "authorization" && typeof value === "string" && value.length > 0) return true;
	}
	return false;
}

/**
 * Convert a normalized pi transcript to Mistral chat-completions messages.
 *
 * - System: the leading (replayed) system prompt as a plain string. Mistral
 *   rejects system messages mid-conversation, so the transcript is collapsed
 *   to a single leading system message before conversion.
 * - Assistant: text blocks joined to a plain string (block arrays make some
 *   models mirror the structure literally); thinking blocks are dropped —
 *   reasoning replay is not part of the chat-completions contract; tool calls
 *   replay as function calls. Empty assistant messages (e.g. aborted turns)
 *   are skipped.
 * - Tool results: role "tool" with text (or a placeholder when only images),
 *   with images from results appended as a following user message.
 * - Orphaned tool calls (no matching tool result, e.g. after an abort) get a
 *   synthetic empty tool result so the server accepts the replay.
 */
function convertMessages(model: Model<Api>, messages: readonly Message[]): MistralWireMessage[] {
	const supportsImages = model.input.includes("image");
	const wire: MistralWireMessage[] = [];
	// Images from the current run of tool results, sent as one following user
	// message (cleared after each run).
	const toolResultImages: MistralWireContentPart[] = [];

	for (const message of messages) {
		if (message.role === "system") {
			const text = sanitizeSurrogates(getSystemMessageText(message));
			if (text.length > 0) wire.push({ role: "system", content: text });
		} else if (message.role === "user") {
			if (typeof message.content === "string") {
				const text = sanitizeSurrogates(message.content);
				if (text.length > 0) wire.push({ role: "user", content: text });
			} else {
				const parts: MistralWireContentPart[] = [];
				for (const block of message.content) {
					if (block.type === "text") {
						if (block.text.length > 0) parts.push({ type: "text", text: sanitizeSurrogates(block.text) });
					} else if (block.type === "image") {
						if (supportsImages) {
							parts.push({
								type: "image_url",
								image_url: { url: `data:${block.mimeType};base64,${block.data}` },
							});
						}
					} else {
						/*
						 * pi 1.4.0's user input model is exactly TextContent |
						 * ImageContent, so this branch is defensive hardening for a
						 * future pi block type: a clear error beats a silent drop.
						 * The throw propagates through the stream body's catch →
						 * error event with stopReason "error".
						 *
						 * ADR 0014 — Content chunk coverage: map or reject, never drop
						 */
						const unsupported = block as unknown as { type?: string };
						throw new Error(
							`Unsupported pi content block type "${unsupported.type ?? "<missing type>"}" in user content: mistral-native cannot map it`,
						);
					}
				}
				if (parts.length > 0) wire.push({ role: "user", content: parts });
			}
		} else if (message.role === "assistant") {
			/*
			 * Defensive hardening: pi 1.4.0 assistant content is text |
			 * thinking | toolCall; thinking is a documented skip (not replayed
			 * to the wire, see convertMessages's doc comment), anything other
			 * than text/toolCall/thinking would be a future pi block type and
			 * must fail loudly, not drop silently.
			 *
			 * ADR 0014 — Content chunk coverage: map or reject, never drop
			 */
			for (const block of message.content) {
				if (block.type !== "text" && block.type !== "toolCall" && block.type !== "thinking") {
					const unsupported = block as unknown as { type?: string };
					throw new Error(
						`Unsupported pi content block type "${unsupported.type ?? "<missing type>"}" in assistant content: mistral-native cannot map it`,
					);
				}
			}
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("");
			const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			const sanitized = sanitizeSurrogates(text);
			const assistantMessage: MistralWireMessage = {
				role: "assistant",
				content: sanitized.length > 0 ? sanitized : null,
			};
			if (toolCalls.length > 0) {
				assistantMessage.tool_calls = toolCalls.map((toolCall) => ({
					id: toolCall.id,
					type: "function" as const,
					function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) ?? "{}" },
				}));
			}
			if ((typeof assistantMessage.content === "string" && assistantMessage.content.length > 0) || assistantMessage.tool_calls) {
				wire.push(assistantMessage);
			}
		} else {
			// toolResult: text (or placeholder) plus images, which Mistral only
			// accepts inside user messages, so they go to a following user turn.
			/*
			 * Defensive hardening: pi 1.4.0 tool results carry only text/image
			 * blocks; any other block type fails loudly.
			 *
			 * ADR 0014 — Content chunk coverage: map or reject, never drop
			 */
			for (const block of message.content) {
				if (block.type !== "text" && block.type !== "image") {
					const unsupported = block as unknown as { type?: string };
					throw new Error(
						`Unsupported pi content block type "${unsupported.type ?? "<missing type>"}" in tool result content: mistral-native cannot map it`,
					);
				}
			}
			const textBlocks = message.content.filter((block): block is TextContent => block.type === "text");
			const imageBlocks = message.content.filter((block): block is ImageContent => block.type === "image");
			const text = sanitizeSurrogates(textBlocks.map((block) => block.text).join("\n"));
			const content = text.trim().length > 0 ? text : imageBlocks.length > 0 ? "(see attached image)" : "(no tool output)";
			wire.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				name: message.toolName,
				content,
			});
			if (imageBlocks.length > 0 && supportsImages) {
				toolResultImages.push(
					...imageBlocks.map((block) => ({
						type: "image_url" as const,
						image_url: { url: `data:${block.mimeType};base64,${block.data}` },
					})),
				);
			}
		}
	}

	// Second pass: synthetic tool results for orphaned tool calls (e.g. an
	// aborted turn between a tool call and its result), and the tool-result
	// images as one following user message (mirrors pi-ai's OpenAI-completions
	// message conversion).
	const result: MistralWireMessage[] = [];
	for (let i = 0; i < wire.length; i++) {
		const current = wire[i];
		if (!current) continue;
		result.push(current);

		if (current.role === "assistant" && current.tool_calls) {
			const answered = new Set<string>();
			let j = i + 1;
			while (j < wire.length && wire[j]?.role === "tool") {
				const toolMessage = wire[j];
				if (toolMessage?.tool_call_id) answered.add(toolMessage.tool_call_id);
				j++;
			}
			for (const toolCall of current.tool_calls) {
				if (!answered.has(toolCall.id)) {
					result.push({ role: "tool", tool_call_id: toolCall.id, content: "(no tool output)" });
				}
			}
		}

		const next = wire[i + 1];
		if (current.role === "tool" && next?.role !== "tool" && toolResultImages.length > 0) {
			result.push({
				role: "user",
				content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...toolResultImages],
			});
			toolResultImages.length = 0;
		}
	}
	return result;
}

/**
 * Map pi thinking levels to a Mistral `reasoning_effort` value. Unsupported
 * levels are clamped by pi-ai's clampThinkingLevel; `off` maps through
 * `thinkingLevelMap.off` ("none"). Returns undefined when the model has no
 * mapping and no effort was requested (server default).
 */
function resolveReasoningEffort(model: Model<Api>, requested: SimpleStreamOptions["reasoning"]): string | undefined {
	if (requested === undefined) return model.thinkingLevelMap?.off ?? undefined;
	const clamped = clampThinkingLevel(model, requested);
	if (clamped === "off") return model.thinkingLevelMap?.off ?? undefined;
	const mapped = model.thinkingLevelMap?.[clamped];
	if (mapped === null || mapped === undefined) return undefined;
	return mapped;
}

/**
 * Resolve the base URL a chat request posts to.
 * - No endpoint configuration (region "global", no explicit baseUrl): returns
 *   undefined so the model's registered baseUrl flows unchanged — pi's
 *   models.json model-level overrides keep working, byte-for-byte the
 *   no-endpoint-config behavior.
 * - An explicit `endpoint.baseUrl` (gateway escape hatch): applies to every
 *   chat mode — the user declared "my Mistral API lives there".
 * - A bare non-global region: plain chat routes regionally;
 *   server-execution surfaces (server tools, connectors, agent mode) post to
 *   the global endpoint — those services are not available regionally.
 *
 * ADR 0012 — Selectable region endpoint with per-family routing
 */
function resolveStreamBaseUrl(
	endpoint: { region: MistralRegion; baseUrl: string | undefined },
	serverExecutionPossible: boolean,
): string | undefined {
	if (endpoint.baseUrl !== undefined && endpoint.baseUrl.trim().length > 0) return endpoint.baseUrl;
	if (endpoint.region === "global") return undefined;
	return serverExecutionPossible ? MISTRAL_BASE_URL : MISTRAL_REGION_BASE_URLS[endpoint.region];
}

function buildRequestBody(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	reasoningEffort: string | undefined,
	serverTools: ServerToolsConfig,
): Record<string, unknown> {
	const messages = convertMessages(model, context.messages);
	const tools = getCurrentTools(context.messages);
	const params: Record<string, unknown> = {
		model: model.id,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
	};
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (tools.length > 0) {
		params.tools = tools.map(toolDefinition);
	}
	if (options?.toolChoice !== undefined) params.tool_choice = options.toolChoice;
	/*
	 * Server-side tools: append the entries the Chat Completions endpoint
	 * accepts (image_generation + connectors; web_search, web_search_premium
	 * and code_interpreter return 400 code 1800 there — wire-verified
	 * 2026-11-03 — and are dropped with a visible warning).
	 *
	 * ADR 0007 — Server-side tools as opaque content
	 */
	if (serverTools.serverExecutionPossible && serverTools.agentId === undefined) {
		recordDroppedServerToolsNotice(unsupportedChatCompletionsServerTools(serverTools));
		const serverEntries = chatCompletionsServerToolEntries(serverTools);
		if (serverEntries.length > 0) {
			params.tools = [...(tools.length > 0 ? tools.map(toolDefinition) : []), ...serverEntries];
		}
	}
	if (reasoningEffort !== undefined && model.reasoning) params.reasoning_effort = reasoningEffort;
	// Sampling parameters merged last so they override named request fields,
	// mirroring pi-ai's OpenAI-compatible adapters.
	const samplingParams = {
		...model.samplingParams,
		...(reasoningEffort !== undefined && model.reasoning
			? model.samplingParamsByThinkingLevel?.[clampThinkingLevel(model, options?.reasoning ?? "high")]
			: undefined),
		...options?.samplingParams,
	};
	let body = params;
	if (samplingParams && Object.keys(samplingParams).length > 0) body = { ...params, ...samplingParams };
	return body;
}

// =============================================================================
// Usage parsing
// =============================================================================

/**
 * Cost block shape including pi-ai 1.5's `totalFromProvider` flag. The
 * dev-locked pi-ai 1.4.0 types predate the field (the peer range is "*", and
 * the package is verified against both 1.4.x and 1.5.0 hosts), so the flag is
 * declared on this local type and assigned through it; pi-ai 1.5's `Usage`
 * accepts the same shape.
 */
type CostBlock = AssistantMessage["usage"]["cost"] & { totalFromProvider?: boolean };

/**
 * Every cost this extension emits is a local catalog estimate: Mistral's chat
 * wire format reports token counts only (billed totals live behind the
 * admin-only /v1/admin/usage endpoint, see ADR 0013), so `totalFromProvider`
 * is always false — set explicitly rather than relying on pi-ai 1.5's
 * calculateCost to set it, keeping 1.4.x hosts honest too.
 * ADR 0021 — Cost estimates marked as not provider-billed.
 */
function estimateCost(): CostBlock {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false };
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: estimateCost(),
	};
}

/**
 * Parse Mistral UsageInfo into pi's Usage and attach cost from the model's
 * rate card. `prompt_tokens` includes cached tokens; pi's `input` excludes
 * them (mirrors pi-ai's parseChunkUsage).
 */
function parseUsage(raw: MistralUsage | undefined, model: Model<Api>): AssistantMessage["usage"] {
	if (!raw) return zeroUsage();
	const promptTokens = raw.prompt_tokens || 0;
	const cacheRead =
		raw.prompt_tokens_details?.cached_tokens ?? raw.num_cached_tokens ?? raw.cached_tokens ?? 0;
	const cacheWrite =
		raw.prompt_tokens_details?.cache_write_tokens ?? raw.cache_write_tokens ?? 0;
	const outputTokens = raw.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input: Math.max(0, promptTokens - cacheRead - cacheWrite),
		output: outputTokens,
		cacheRead,
		cacheWrite,
		reasoning: raw.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: Math.max(0, promptTokens - cacheRead - cacheWrite) + outputTokens + cacheRead + cacheWrite,
		// Catalog estimate, never provider-billed (see estimateCost); set
		// before calculateCost so the flag survives even if a future pi-ai
		// stops setting it, and re-asserted after in case a host clears it.
		cost: estimateCost(),
	};
	calculateCost(model, usage);
	(usage.cost as CostBlock).totalFromProvider = false;
	return usage;
}

// =============================================================================
// SSE parsing
// =============================================================================

/**
 * Parse a `text/event-stream` response body into decoded JSON chunk values.
 * Terminates on the `data: [DONE]` sentinel. Malformed JSON fails the stream
 * (the custom-provider contract requires malformed streams to surface as
 * errors, not silent truncation).
 */
async function* sseData(response: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
	const body = response.body;
	if (!body) throw new Error("Mistral API returned no response body");
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	type BodyRead = Awaited<ReturnType<typeof reader.read>>;
	// Cancellation must not depend on the server closing the connection: race
	// every body read against the caller's abort signal and cancel the body
	// when it fires. The loop then ends deterministically and the stream
	// converts the aborted state into an aborted result (a stalled transport
	// can never hang the consumer until the server-side timeout).
	let onAbort: (() => void) | undefined;
	const aborted = signal
		? new Promise<"aborted">((resolve) => {
				if (signal.aborted) {
					resolve("aborted");
					return;
				}
				onAbort = () => resolve("aborted");
				signal.addEventListener("abort", onAbort, { once: true });
			})
		: undefined;
	try {
		for (;;) {
			if (signal?.aborted) return;
			const read: BodyRead | "aborted" = aborted
				? await Promise.race([reader.read(), aborted])
				: await reader.read();
			if (read === "aborted") {
				await reader.cancel().catch(() => undefined);
				return;
			}
			if (read.done) break;
			buffer += decoder.decode(read.value, { stream: true });
			for (;;) {
				const { event, rest } = extractEvent(buffer);
				if (!event) {
					buffer = rest;
					break;
				}
				buffer = rest;
				const result = parseSseEvent(event);
				if (result.done) return;
				if (result.data !== undefined) yield result.data;
			}
		}
		buffer += decoder.decode();
		if (buffer.trim().length > 0) {
			const result = parseSseEvent(buffer);
			if (result.done) return;
			if (result.data !== undefined) yield result.data;
		}
	} finally {
		if (onAbort && signal) signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

/** Split off the first complete SSE event (blank-line separated). */
function extractEvent(buffer: string): { event: string | null; rest: string } {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	let index = -1;
	let length = 0;
	if (lf !== -1 && (crlf === -1 || lf <= crlf)) {
		index = lf;
		length = 2;
	} else if (crlf !== -1) {
		index = crlf;
		length = 4;
	}
	if (index === -1) return { event: null, rest: buffer };
	return { event: buffer.slice(0, index), rest: buffer.slice(index + length) };
}

function parseSseEvent(raw: string): { done?: boolean; data?: unknown } {
	const dataLines: string[] = [];
	for (const line of raw.split(/\r\n|\n|\r/)) {
		if (line.startsWith(":")) continue;
		if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	}
	if (dataLines.length === 0) return {};
	const data = dataLines.join("\n");
	if (data.trim() === "[DONE]") return { done: true };
	try {
		return { data: JSON.parse(data) as unknown };
	} catch {
		throw new MistralApiError(`Malformed SSE data from Mistral API: ${truncateText(data, 200)}`);
	}
}

// =============================================================================
// HTTP request with retry (mirrors pi-ai's retryProviderRequest policy)
// =============================================================================

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

function sleepInterruptible(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortError());
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response | undefined, attempt: number, maxRetryDelayMs: number): number {
	const max = maxRetryDelayMs > 0 ? maxRetryDelayMs : Number.POSITIVE_INFINITY;
	const retryAfterMs = response?.headers.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerDelay(value, max);
	}
	const retryAfter = response?.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerDelay(delayMs, max);
	}
	const exponential = Math.min(0.5 * 2 ** attempt, 8) * 1000;
	return exponential * (1 - Math.random() * 0.25);
}

function validateServerDelay(delayMs: number, maxDelayMs: number): number {
	if (delayMs > maxDelayMs) {
		throw new MistralApiError(
			`Mistral API requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s)`,
		);
	}
	return delayMs;
}

/**
 * POST the chat-completions request and return the successful Response with
 * an unconsumed body. Retries transient failures (408/409/429/5xx and network
 * errors) with interruptible backoff, mirroring the OpenAI/Anthropic SDK
 * policy pi-ai reproduces. The per-attempt timeout is enforced by aborting
 * the attempt's signal, not the caller's. `baseUrlOverride` replaces the
 * model's registered `baseUrl` when the effective config routes chat
 * completions to a regional endpoint.
 *
 * ADR 0012 — Selectable region endpoint with per-family routing
 */
async function fetchChatCompletion(
	model: Model<Api>,
	params: Record<string, unknown>,
	apiKey: string,
	options: SimpleStreamOptions | undefined,
	path = "chat/completions",
	baseUrlOverride?: string,
): Promise<Response> {
	const url = `${(baseUrlOverride ?? model.baseUrl).replace(/\/+$/, "")}/${path}`;
	const headers: Record<string, string> = {
		...getIdentityHeaders(model, options?.identity),
		...model.headers,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
	};
	if (apiKey !== "unused") headers.Authorization = `Bearer ${apiKey}`;
	// Caller headers win; a null value suppresses a default header.
	const optionHeaders = (options?.headers ?? {}) as ProviderHeaders;
	for (const [key, value] of Object.entries(optionHeaders)) {
		if (value === null) delete headers[key];
		else headers[key] = value;
	}

	const fetchImpl = options?.fetch ?? globalThis.fetch;
	const maxRetries = options?.maxRetries ?? 0;
	const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	let attempt = 0;
	for (;;) {
		const controller = new AbortController();
		let timedOut = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => controller.abort();
		const signal = options?.signal;
		if (signal?.aborted) controller.abort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, options.timeoutMs);
		}
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(params),
				signal: controller.signal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			if (timedOut) throw new MistralApiError(`Mistral API request timed out after ${options?.timeoutMs}ms`);
			if (attempt < maxRetries) {
				await sleepInterruptible(retryDelayMs(undefined, attempt, maxRetryDelayMs), signal);
				attempt++;
				continue;
			}
			throw error;
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}

		if (response.ok) return response;
		if (isRetryableStatus(response.status) && attempt < maxRetries && !signal?.aborted) {
			const retryResponse = response;
			await retryResponse.text().catch(() => undefined);
			await sleepInterruptible(retryDelayMs(response, attempt, maxRetryDelayMs), signal);
			attempt++;
			continue;
		}
		const body = await response.text().catch(() => "");
		throw new MistralApiError(
			`Mistral API error (${response.status}): ${truncateText(body.trim(), MAX_PROVIDER_ERROR_BODY_CHARS)}`,
			response.status,
		);
	}
}

// =============================================================================
// Stream implementation
// =============================================================================

function mapFinishReason(reason: string): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
		case "model_length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
	}
}

/** ToolCall with streaming scratch state, stripped before the block is finalized. */
interface MutableToolCall extends ToolCall {
	partialArgs?: string | undefined;
	streamIndex?: number | undefined;
}

/**
 * A server-executed tool-call candidate awaiting its result.
 *
 * ADR 0007 — Server-side tools as opaque content
 */
interface PendingServerToolCall {
	id: string;
	name: string;
	index: number | undefined;
	partialArgs: string;
	arguments: Record<string, unknown>;
	metadata: { tool_type?: string; integration_id?: string } | undefined;
	folded: boolean;
}

/**
 * Native `mistral-chat` streamSimple implementation. Follows pi's
 * custom-streaming contract: one `start` event, balanced block events with
 * blocks updated before emission, exactly one terminal `done`/`error`,
 * abort converted to an aborted result, and the onPayload/onResponse/
 * onProviderStreamEvent instrumentation hooks.
 */
export function mistralStreamSimple(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	// supportsMidConvoSystemMessages is declared on the model compat; the union from
	// Model<Api> is wider, so read it through a narrow local type.
	const compat = model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined;
	const normalizedContext = resolveTranscript(context, compat?.supportsMidConvoSystemMessages === true);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const stripScratch = () => {
			for (const block of output.content) {
				if (block.type === "toolCall") {
					delete (block as MutableToolCall).partialArgs;
					delete (block as MutableToolCall).streamIndex;
				}
			}
		};
		try {
			// Request setup. Missing authentication fails the stream with an
			// error event before `start`, like pi's built-in providers.
			const apiKey = options?.apiKey ?? (hasAuthorizationHeader(options?.headers) ? "unused" : undefined);
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

			/*
			 * Server-side tools / connectors / agent mode: pi's ProviderEnv
			 * (options.env) takes precedence over process.env; the effective
			 * mistral-native.json file config takes precedence over both for the
			 * keys it sets.
			 *
			 * Decisions: ADR 0007 — Server-side tools as opaque content;
			 * ADR 0010 — Configuration via mistral-native.json aligned to the pi
			 * ecosystem convention
			 */
			const serverTools = parseServerToolsConfig(
				options?.env as Record<string, string | undefined> | undefined,
				getEffectiveMistralConfig(),
			);

			const reasoningEffort = resolveReasoningEffort(model, options?.reasoning);
			if (options?.reasoning !== undefined && reasoningEffort !== undefined) {
				output.providerThinkingLevel = reasoningEffort;
			}

			let params: Record<string, unknown>;
			let requestPath = "chat/completions";
			if (serverTools.agentId !== undefined) {
				// Agent mode: minimal AgentsCompletionRequest body, no model,
				// temperature, stream_options, sampling params or tools — the
				// schema is additionalProperties:false without model/temperature/
				// stream_options.
				params = buildAgentsRequestBody(
					convertMessages(model, normalizedContext.messages),
					serverTools.agentId,
					clampMaxTokensToContext(model, normalizedContext, options?.maxTokens ?? model.maxTokens),
				);
				requestPath = "agents/completions";
			} else {
				params = buildRequestBody(model, normalizedContext, options, reasoningEffort, serverTools);
			}
			/*
			 * Region routing: chat completions follow the effective config's
			 * regional base URL, honoring pi's provider-scoped env (same
			 * precedence as parseServerToolsConfig); server-execution surfaces
			 * (server tools, connectors, agent mode) post to the global endpoint.
			 * Undefined keeps the model's registered baseUrl (pi's models.json
			 * model-level overrides) — the no-region behavior.
			 *
			 * ADR 0012 — Selectable region endpoint with per-family routing
			 */
			const effectiveBaseUrl = resolveStreamBaseUrl(
				getEffectiveEndpoint(options?.env as Record<string, string | undefined> | undefined),
				serverTools.serverExecutionPossible,
			);
			const replacement = await options?.onPayload?.(params, model);
			if (replacement !== undefined) params = replacement as Record<string, unknown>;

			const response = await fetchChatCompletion(model, params, apiKey, options, requestPath, effectiveBaseUrl);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			stream.push({ type: "start", partial: output });

			// ---- Block assembly state ----
			const blocks = output.content;
			const getContentIndex = (block: (typeof blocks)[number]) => blocks.indexOf(block);
			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			let providerThinkingSignature: string | undefined;
			const toolCallBlocksByIndex = new Map<number, MutableToolCall>();
			const toolCallBlocksById = new Map<string, MutableToolCall>();
			/*
			 * Server-execution folding state: only used when server-side tools
			 * are enabled; with no server tools the maps stay empty and the loop
			 * behaves as a plain chat stream.
			 *
			 * ADR 0007 — Server-side tools as opaque content
			 */
			const pendingServerCalls: PendingServerToolCall[] = [];
			const pendingServerCallsById = new Map<string, PendingServerToolCall>();
			const pendingServerCallsByIndex = new Map<number, PendingServerToolCall>();
			// Blocks that already emitted their closing event (folded server
			// reports); the finalization pass must not close them twice.
			const closedBlocks = new Set<unknown>();
			const serverToolResults = new Map<string, { text: string; failed: boolean }>();
			const ensureServerCallCandidate = (toolCall: MistralToolCallDelta): PendingServerToolCall | undefined => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				const name = toolCall.function?.name ?? "";
				let existing = streamIndex !== undefined ? pendingServerCallsByIndex.get(streamIndex) : undefined;
				if (!existing && toolCall.id) existing = pendingServerCallsById.get(toolCall.id);
				/*
				 * Continuation-chunk fallback: an args-only delta (no function.name
				 * AND no id) continues the most recently opened, not yet folded
				 * candidate; with no open candidate there is nothing valid to
				 * append to, so the chunk is dropped. A nameless delta WITH an id
				 * is a legitimate call header whose name is backfilled by a later
				 * delta — never a continuation.
				 *
				 * ADR 0019 — Tool-call continuation chunks append to the open call
				 */
				if (!existing && !name && !toolCall.id) {
					const open = pendingServerCalls.findLast((call) => !call.folded);
					if (!open) return undefined;
					existing = open;
				}
				if (existing) {
					if (existing.index === undefined && streamIndex !== undefined) existing.index = streamIndex;
					if (streamIndex !== undefined) pendingServerCallsByIndex.set(streamIndex, existing);
					if (toolCall.id && !existing.id) existing.id = toolCall.id;
					if (toolCall.id) pendingServerCallsById.set(toolCall.id, existing);
					if (!existing.name && name) existing.name = name;
					if (toolCall.metadata) {
						existing.metadata = {
							...(existing.metadata ?? {}),
							...(toolCall.metadata.tool_type !== undefined ? { tool_type: toolCall.metadata.tool_type } : {}),
							...(toolCall.metadata.integration_id !== undefined
								? { integration_id: toolCall.metadata.integration_id }
								: {}),
						};
					}
					return existing;
				}
				const candidate: PendingServerToolCall = {
					id: toolCall.id ?? "",
					name,
					index: streamIndex,
					partialArgs: "",
					arguments: {},
					metadata:
						toolCall.metadata?.tool_type !== undefined || toolCall.metadata?.integration_id !== undefined
							? {
									...(toolCall.metadata.tool_type !== undefined ? { tool_type: toolCall.metadata.tool_type } : {}),
									...(toolCall.metadata.integration_id !== undefined
										? { integration_id: toolCall.metadata.integration_id }
										: {}),
								}
						: undefined,
					folded: false,
				};
				pendingServerCalls.push(candidate);
				if (candidate.id) pendingServerCallsById.set(candidate.id, candidate);
				if (candidate.index !== undefined) pendingServerCallsByIndex.set(candidate.index, candidate);
				// Result-before-call wire ordering: a buffered result folds the
				// fresh candidate immediately so no executed result is ever dropped.
				const buffered = candidate.id ? serverToolResults.get(candidate.id) : undefined;
				if (buffered) {
					foldServerCall(candidate, buffered.text, buffered.failed);
				}
				return candidate;
			};
			const foldServerCall = (candidate: PendingServerToolCall, resultText: string | undefined, failed: boolean) => {
				if (candidate.folded) return;
				candidate.folded = true;
				const report = formatServerToolReport(candidate.name, candidate.partialArgs, resultText, failed);
				const fresh: TextContent = { type: "text", text: report };
				blocks.push(fresh);
				closedBlocks.add(fresh);
				const contentIndex = getContentIndex(fresh);
				stream.push({ type: "text_start", contentIndex, partial: output });
				stream.push({ type: "text_delta", contentIndex, delta: report, partial: output });
				stream.push({ type: "text_end", contentIndex, content: report, partial: output });
			};
			let hasFinishReason = false;

			const ensureTextBlock = (): TextContent => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			const ensureThinkingBlock = (): ThinkingContent => {
				if (thinkingBlock === null) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature: providerThinkingSignature ?? "mistral-blocks",
					};
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				if (providerThinkingSignature !== undefined && !thinkingBlock.thinkingSignature) {
					thinkingBlock.thinkingSignature = providerThinkingSignature;
				}
				return thinkingBlock;
			};
			// Appends to the current text block and emits the delta — shared by the
			// text-chunk path and the reference-chunk citation marker.
			const appendText = (text: string) => {
				if (text.length === 0) return;
				const block = ensureTextBlock();
				block.text += text;
				stream.push({ type: "text_delta", contentIndex: getContentIndex(block), delta: text, partial: output });
			};
			/*
			 * Citation marker for a ReferenceChunk (docs.mistral.ai citations
			 * flow): `reference_ids` index the tool-result references mapping, and
			 * text is pi's only assistant expression surface, so the marker
			 * preserves the citation information losslessly. An empty array is a
			 * legitimate empty carrier (no-op marker); a present-but-non-array
			 * `reference_ids` is a malformed wire shape and rejects loudly.
			 *
			 * ADR 0014 — Content chunk coverage: map or reject, never drop
			 */
			const referenceMarker = (part: { reference_ids?: (number | string)[] }): string => {
				if (part.reference_ids !== undefined && !Array.isArray(part.reference_ids)) {
					rejectChunk("reference", "in assistant content", ` (reference_ids must be an array, got ${typeof part.reference_ids})`);
				}
				const ids = Array.isArray(part.reference_ids)
					? part.reference_ids.filter((id) => id !== null && id !== undefined)
					: [];
				// An empty array is a legitimate empty carrier: no marker.
				return ids.length > 0 ? `[${ids.join(", ")}]` : "";
			};
			/*
			 * Loud rejection for a delta-side chunk type pi cannot represent:
			 * named type, never the payload — data URLs and base64 bodies must
			 * not leak into error text. The throw is caught by the stream body's
			 * catch → error event with stopReason "error".
			 *
			 * ADR 0014 — Content chunk coverage: map or reject, never drop
			 */
			const rejectChunk = (type: string, context = "in assistant content", detail = "") => {
				const blockedOnPi =
					type === "input_audio"
						? " (audio input is blocked on pi: pi 1.4.0 has no audio content surface)"
						: "";
				throw new Error(
					`Unsupported Mistral content chunk type "${type}" ${context}: pi cannot represent it${detail}${blockedOnPi}`,
				);
			};
			const ensureToolCallBlock = (toolCall: MistralToolCallDelta): MutableToolCall | undefined => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				const name = toolCall.function?.name ?? "";
				let existing = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!existing && toolCall.id) existing = toolCallBlocksById.get(toolCall.id);
				/*
				 * Continuation-chunk fallback: an args-only delta (no function.name
				 * AND no id) continues the most recently opened tool-call block;
				 * with no open block there is nothing valid to append to, so the
				 * chunk is dropped. A nameless delta WITH an id is a legitimate
				 * call header whose name is backfilled by a later delta — never
				 * a continuation.
				 *
				 * ADR 0019 — Tool-call continuation chunks append to the open call
				 */
				if (!existing && !name && !toolCall.id) {
					const open = blocks.findLast((block) => block.type === "toolCall");
					if (!open) return undefined;
					existing = open as MutableToolCall;
				}
				if (existing) {
					if (streamIndex !== undefined && existing.streamIndex === undefined) {
						existing.streamIndex = streamIndex;
						toolCallBlocksByIndex.set(streamIndex, existing);
					}
					if (toolCall.id) toolCallBlocksById.set(toolCall.id, existing);
					if (!existing.name && name) existing.name = name;
					return existing;
				}
				const block: MutableToolCall = {
					type: "toolCall",
					id: toolCall.id ?? "",
					name,
					arguments: {},
					partialArgs: "",
					streamIndex,
				};
				if (streamIndex !== undefined) toolCallBlocksByIndex.set(streamIndex, block);
				if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
				blocks.push(block);
				stream.push({ type: "toolcall_start", contentIndex: getContentIndex(block), partial: output });
				return block;
			};
			const finishBlock = (block: (typeof blocks)[number]) => {
				if (closedBlocks.has(block)) return;
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) return;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else {
					const mutable = block as MutableToolCall;
					Object.assign(mutable, parseToolCallArguments(mutable.partialArgs));
					delete mutable.partialArgs;
					delete mutable.streamIndex;
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
				}
			};
			const materializeClientCall = (candidate: PendingServerToolCall) => {
				const block: MutableToolCall = {
					type: "toolCall",
					id: candidate.id,
					name: candidate.name,
					arguments: candidate.arguments as ToolCall["arguments"],
					partialArgs: candidate.partialArgs,
					streamIndex: candidate.index,
				};
				if (candidate.index !== undefined) toolCallBlocksByIndex.set(candidate.index, block);
				if (candidate.id) toolCallBlocksById.set(candidate.id, block);
				blocks.push(block);
				const contentIndex = getContentIndex(block);
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex, delta: candidate.partialArgs, partial: output });
				finishBlock(block);
				// finishBlock emitted this block's toolcall_end; the general
				// finalization pass must not close it again.
				closedBlocks.add(block);
			};

			for await (const parsed of sseData(response, options?.signal)) {
				await options?.onProviderStreamEvent?.(parsed, model);
				if (!parsed || typeof parsed !== "object") continue;
				const chunk = parsed as MistralChatChunk;
				if (output.responseId === undefined && typeof chunk.id === "string" && chunk.id.length > 0) {
					output.responseId = chunk.id;
				}
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) output.usage = parseUsage(chunk.usage, model);
				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;
				// Some gateways report usage on the choice instead of the chunk.
				if (!chunk.usage && choice.usage) output.usage = parseUsage(choice.usage, model);

				if (choice.finish_reason) {
					hasFinishReason = true;
					output.rawStopReason = choice.finish_reason as string;
					const mapped = mapFinishReason(choice.finish_reason);
					output.stopReason = mapped.stopReason;
					if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
				}

				const delta = choice.delta;
				if (!delta) continue;

				// Content: plain string, or Mistral's block array
				// ([{type:"thinking",...},{type:"text",...}]). Server-executed
				// tool results (delta.role === "tool", handled below) are excluded.
				const isServerToolResult =
					serverTools.serverExecutionPossible && delta.role === "tool" && typeof delta.tool_call_id === "string";
				const content = isServerToolResult ? null : delta.content;
				if (typeof content === "string") {
					if (content.length > 0) {
						const block = ensureTextBlock();
						block.text += content;
						stream.push({ type: "text_delta", contentIndex: getContentIndex(block), delta: content, partial: output });
					}
				} else if (Array.isArray(content)) {
					for (const part of content) {
						// Deliberate skip: a null/non-object entry is a malformed array
						// member, not a wire type — nothing to name in an error.
						if (!part || typeof part !== "object") continue;
						const chunkPart = part as MistralContentChunk;
						if (chunkPart.type === "thinking") {
							const think = part as MistralThinkChunk;
							if (typeof think.signature === "string" && think.signature.length > 0) {
								// A later thinking chunk's signature also applies to the
								// already-created block (ensureThinkingBlock backfills it).
								providerThinkingSignature = think.signature;
							}
							// Nested parts inside a ThinkChunk (spec: TextChunk |
							// ReferenceChunk | ToolReferenceChunk): text joins the
							// thinking text, references become citation markers inside
							// the thinking text, anything else is rejected loudly.
							let thinkingText = "";
							if (Array.isArray(think.thinking)) {
								for (const entry of think.thinking) {
									// Deliberate skip: a null/non-object entry is a malformed array
									// member, not a wire type — nothing to name in an error.
									if (!entry || typeof entry !== "object") continue;
									const nested = entry as MistralThinkPart;
									if (nested.type === "reference") {
										thinkingText += referenceMarker(nested);
									} else if (nested.type === "text" || nested.type === undefined) {
										thinkingText += typeof nested.text === "string" ? nested.text : "";
									} else {
										rejectChunk(nested.type, "in a thinking part");
									}
								}
							}
							if (thinkingText.length > 0) {
								const block = ensureThinkingBlock();
								block.thinking += thinkingText;
								stream.push({
									type: "thinking_delta",
									contentIndex: getContentIndex(block),
									delta: thinkingText,
									partial: output,
								});
							}
						} else if (chunkPart.type === "text") {
							// Empty text chunks carry no content — they are a no-op, not
							// silent loss.
							if (typeof chunkPart.text === "string" && chunkPart.text.length > 0) {
								const text = chunkPart.text;
								const block = ensureTextBlock();
								block.text += text;
								stream.push({ type: "text_delta", contentIndex: getContentIndex(block), delta: text, partial: output });
							}
						} else if (chunkPart.type === "reference") {
							// Output citation marker (docs.mistral.ai citations flow):
							// append the marker to the current text block, e.g.
							// reference_ids [0,1] → "[0, 1]".
							appendText(referenceMarker(chunkPart));
						} else {
							// `image_url`, `document_url`, `file`, `input_audio`, `resource`,
							// `resource_link` — plus any unknown or missing chunk type:
							// pi has no surface for them, so reject loudly instead of
							// dropping them silently.
							rejectChunk(String(chunkPart.type ?? "<missing type>"));
						}
					}
				}

				// Server-executed tool result: delta.role === "tool" with a
				// tool_call_id accumulates the executed result text; folding happens
				// immediately once the pending call is complete. The result's
				// delta.content is excluded from the assistant text path above.
				if (serverTools.serverExecutionPossible && delta.role === "tool" && typeof delta.tool_call_id === "string") {
					const id = delta.tool_call_id;
					const failed = delta.metadata?.tool_call_result?.type === "error";
					const piece = typeof delta.content === "string" ? delta.content : "";
					const existing = serverToolResults.get(id);
					serverToolResults.set(id, {
						text: (existing?.text ?? "") + piece,
						failed: (existing?.failed ?? false) || failed,
					});
					const candidate = pendingServerCallsById.get(id);
					if (candidate && !candidate.folded) {
						const result = serverToolResults.get(id)!;
						foldServerCall(candidate, result.text, result.failed);
					}
					continue;
				}

				if (Array.isArray(delta.tool_calls)) {
					for (const toolCall of delta.tool_calls) {
						if (!toolCall) continue;
						if (serverTools.serverExecutionPossible) {
							// Server-tools mode: do not create pi toolCall blocks yet — the
							// call may have been executed server-side; folding/deferral is
							// decided by the result stream and the finalization pass.
							const candidate = ensureServerCallCandidate(toolCall);
							// A continuation chunk with no open call is dropped (no phantom block).
							if (!candidate) continue;
							if (typeof toolCall.function?.arguments === "string") {
								candidate.partialArgs += toolCall.function.arguments;
								candidate.arguments = parseStreamingJson(candidate.partialArgs);
							}
							continue;
						}
						const block = ensureToolCallBlock(toolCall);
						// A continuation chunk with no open call is dropped (no phantom block).
						if (!block) continue;
						let deltaArgs = "";
						if (typeof toolCall.function?.arguments === "string") {
							deltaArgs = toolCall.function.arguments;
							block.partialArgs = (block.partialArgs ?? "") + deltaArgs;
							block.arguments = parseStreamingJson(block.partialArgs);
						}
						stream.push({ type: "toolcall_delta", contentIndex: getContentIndex(block), delta: deltaArgs, partial: output });
					}
				}
			}

			// Finalization pass (server-tools mode): fold server calls
			// that never received a result, materialize the rest as client function
			// calls, and remap a toolUse stopReason that produced no pi toolCall
			// blocks (a mid-stream finish_reason tool_calls may belong to a server
			// execution inside a single multi-message response). Skipped on abort:
			// pending candidates are not folded or materialized, so the aborted
			// output keeps only what was already emitted.
			if (serverTools.serverExecutionPossible && !options?.signal?.aborted) {
				for (const candidate of pendingServerCalls) {
					if (candidate.folded) continue;
					if (candidate.metadata?.tool_type !== undefined || candidate.metadata?.integration_id !== undefined) {
						// Server call with metadata but no result delta.
						foldServerCall(candidate, undefined, false);
						continue;
					}
					const result = candidate.id ? serverToolResults.get(candidate.id) : undefined;
					if (result) {
						foldServerCall(candidate, result.text, result.failed);
					} else {
						// Client function call: create the pi toolCall block now.
						materializeClientCall(candidate);
					}
				}
				// Orphaned results: a role:"tool" result whose
				// tool_call_id never matched a pending candidate still belongs to
				// the response; fold it as an anonymous report so no executed
				// result is ever dropped.
				for (const [orphanId, orphan] of serverToolResults) {
					if (pendingServerCalls.some((candidate) => candidate.id === orphanId && candidate.folded)) {
						continue;
					}
					if (pendingServerCalls.some((candidate) => candidate.id === orphanId)) {
						// Candidate exists but was never folded (e.g. a client call
						// that somehow received a result after materialization).
						continue;
					}
					foldServerCall(
						{
							id: orphanId,
							name: "(unknown)",
							index: undefined,
							partialArgs: "",
							arguments: {},
							metadata: undefined,
							folded: false,
						},
						orphan.text,
						orphan.failed,
					);
				}
				if (output.stopReason === "toolUse" && !blocks.some((block) => block.type === "toolCall")) {
					output.stopReason = "stop";
				}
			}

			for (const block of blocks) finishBlock(block);

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			if (!hasFinishReason || output.stopReason === "pending") {
				throw new Error("Mistral stream ended without finish_reason");
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			stripScratch();
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatError(error);
			normalizeOverflowErrorMessage(output);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/** Fetch implementation used by catalog refresh; injectable for tests. */
let mistralFetch: FetchImpl = globalThis.fetch;

/** Override the fetch implementation used for catalog refresh (tests); omit to reset to the global fetch. */
export function setMistralFetch(impl?: FetchImpl): void {
	mistralFetch = impl ?? globalThis.fetch;
}

/**
 * The +10% token-rate surcharge for regional endpoints: regional
 * processing carries a 10% price premium over the global rate card.
 *
 * ADR 0012 — Selectable region endpoint with per-family routing
 */
export const MISTRAL_REGION_SURCHARGE = 1.1;

/**
 * Multiply all four rate fields by `MISTRAL_REGION_SURCHARGE`, rounding to 4
 * decimal places to keep the persisted numbers clean (pure).
 */
export function applyRegionSurcharge(rates: ModelRates): ModelRates {
	return {
		input: Math.round(rates.input * MISTRAL_REGION_SURCHARGE * 10000) / 10000,
		output: Math.round(rates.output * MISTRAL_REGION_SURCHARGE * 10000) / 10000,
		cacheRead: Math.round(rates.cacheRead * MISTRAL_REGION_SURCHARGE * 10000) / 10000,
		cacheWrite: Math.round(rates.cacheWrite * MISTRAL_REGION_SURCHARGE * 10000) / 10000,
	};
}

function effectiveRegion(): MistralRegion {
	return getEffectiveEndpoint().region;
}

/**
 * The combined rate card: config `models.rateCard` entries are checked
 * FIRST — a config entry with the same `match` as a built-in shadows it,
 * and new match strings work — followed by the built-in `DEFAULT_RATES`
 * (whose `""` catch-all stays last). Precedence chain: project JSON >
 * user JSON > env > built-in defaults (there is no rateCard env var; file
 * config wins over built-ins).
 *
 * Decisions: ADR 0010 — Configuration via mistral-native.json aligned to
 * the pi ecosystem convention; ADR 0013 — Per-family rate card with sourced
 * prices and visible fall-through
 */
function combinedRateCard(configRateCard: readonly RateCardEntry[] | undefined): readonly RateCardEntry[] {
	if (configRateCard === undefined || configRateCard.length === 0) return DEFAULT_RATES;
	return [...configRateCard, ...DEFAULT_RATES];
}

/** Zero-cost placeholder for unpriced models when `models.fallThrough` is false. */
const ZERO_RATES: ModelRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Result of resolving one model id against a rate card. */
export interface RateResolution {
	rates: ModelRates;
	/** True when the id hit the catch-all (or matched nothing): approximate pricing. */
	fallThrough: boolean;
}

/**
 * Pure resolution of one model id against a rate card and fall-through
 * flag. The catch-all `""` entry — and any id that
 * matches nothing — is fall-through pricing: with `fallThrough` true (or
 * unset) the catch-all rates apply; with `fallThrough` false the model gets
 * a zero-cost placeholder instead. Either way the id is flagged
 * fall-through so cost display can mark it approximate.
 *
 * ADR 0013 — Per-family rate card with sourced prices and visible fall-through
 */
function resolveRates(id: string, card: readonly RateCardEntry[], fallThrough: boolean): RateResolution {
	/*
	 * Region surcharge: a non-global region multiplies the resolved rates
	 * by MISTRAL_REGION_SURCHARGE — one hook covering every dynamic-catalog
	 * cost (config rateCard entries, built-in family rates and the
	 * fall-through catch-all alike).
	 *
	 * ADR 0012 — Selectable region endpoint with per-family routing
	 */
	const region = effectiveRegion();
	const surcharge = region === "eu" || region === "us" ? applyRegionSurcharge : undefined;
	for (const entry of card) {
		if (entry.match !== "" && !id.includes(entry.match)) continue;
		if (entry.match === "") {
			const rates = fallThrough ? { ...entry.rates } : { ...ZERO_RATES };
			return { rates: surcharge ? surcharge(rates) : rates, fallThrough: true };
		}
		const rates = { ...entry.rates };
		return { rates: surcharge ? surcharge(rates) : rates, fallThrough: false };
	}
	// Unreachable for the combined card (DEFAULT_RATES ends with the ""
	// catch-all), but a degenerate card without one still resolves safely.
	return { rates: { ...ZERO_RATES }, fallThrough: true };
}

/**
 * Resolve one model id's rates and fall-through flag against the effective
 * config: the combined card (config `models.rateCard` entries first, then
 * `DEFAULT_RATES`) and the `models.fallThrough` flag. The single resolution
 * point for every dynamic-catalog cost.
 */
export function ratesAndFallThroughForModel(id: string): RateResolution {
	const models = getEffectiveMistralConfig()?.models;
	return resolveRates(id, combinedRateCard(models?.rateCard), models?.fallThrough !== false);
}

/** Recorded fall-through notice of the latest network catalog refresh. */
export interface FallThroughNotice {
	/** Model ids that got approximate fall-through pricing. */
	ids: readonly string[];
	/** When the recording refresh recorded them (epoch ms). */
	at: number;
}

/**
 * Fall-through notice of the latest network catalog refresh: the model ids
 * that hit the catch-all and therefore carry approximate pricing.
 * `refreshMistralModels` records it once per refresh cycle (not per model
 * call) and the extension surfaces it at most once per notice via
 * `ctx.ui.notify` on the next `session_start`. The extension itself
 * performs no logging, so this module-state channel is the warning
 * surface. The notice object is fresh per recording refresh, so object
 * identity is the surfaced-once dedup key (not the `at` timestamp, which
 * consecutive refreshes may share).
 *
 * Decisions: ADR 0004 — API-key credential chain without Mistral OAuth;
 * ADR 0013 — Per-family rate card with sourced prices and visible fall-through
 */
let fallThroughNotice: FallThroughNotice | undefined;

/** Read the fall-through notice recorded by the latest network refresh (undefined when the catalog was fully priced). */
export function lastFallThroughNotice(): FallThroughNotice | undefined {
	return fallThroughNotice;
}

/** The notice the session_start handler last surfaced (dedup guard by object identity). */
let surfacedFallThroughNotice: FallThroughNotice | undefined;

/**
 * Mark the current fall-through notice as surfaced and return its message;
 * undefined when there is no notice or it was already surfaced. Called by
 * the extension's `session_start` handler, which delivers the message via
 * `ctx.ui.notify(message, "warning")`.
 */
function takeFallThroughNoticeMessage(): string | undefined {
	if (fallThroughNotice === undefined || surfacedFallThroughNotice === fallThroughNotice) return undefined;
	surfacedFallThroughNotice = fallThroughNotice;
	return `mistral-native: approximate fall-through pricing for: ${fallThroughNotice.ids.join(", ")} (no rate-card match; costs are estimates)`;
}

/**
 * Test seam for `takeFallThroughNoticeMessage` (mirrors setMistralFetch /
 * setMistralConfigForTests): the session_start surfacing path itself is not
 * exported by pi, so tests exercise the same take-and-dedup logic through
 * this exported alias.
 */
export const takeFallThroughNoticeForTests = takeFallThroughNoticeMessage;

/**
 * Server tools configured but not accepted by the Chat Completions endpoint
 * (dropped from the request with a visible warning). Recorded once per chat
 * request that actually drops tools; object identity is the surfaced-once
 * dedup key, mirroring the fall-through notice.
 */
export interface DroppedServerToolsNotice {
	/** Dropped server tool types, config order. */
	tools: readonly MistralServerToolType[];
	/** When the recording request recorded them (epoch ms). */
	at: number;
}

/** Dropped-tools notice of the latest chat request that dropped server tools. */
let droppedServerToolsNotice: DroppedServerToolsNotice | undefined;

/** Read the dropped-tools notice recorded by the latest chat request (undefined when nothing was dropped). */
export function lastDroppedServerToolsNotice(): DroppedServerToolsNotice | undefined {
	return droppedServerToolsNotice;
}

/** The notice the session_start handler last surfaced (dedup guard by object identity). */
let surfacedDroppedServerToolsNotice: DroppedServerToolsNotice | undefined;

/**
 * Record a dropped-tools notice; a fresh notice object per recording, so
 * object identity (not the timestamp) is the surfaced-once dedup key. No-op
 * when no tools were dropped.
 */
function recordDroppedServerToolsNotice(tools: readonly MistralServerToolType[]): void {
	if (tools.length === 0) return;
	droppedServerToolsNotice = { tools: [...tools], at: Date.now() };
}

/**
 * Mark the current dropped-tools notice as surfaced and return its message;
 * undefined when there is no notice or it was already surfaced. Called by
 * the extension's `session_start` handler, which delivers the message via
 * `ctx.ui.notify(message, "warning")`.
 */
function takeDroppedServerToolsNoticeMessage(): string | undefined {
	if (droppedServerToolsNotice === undefined || surfacedDroppedServerToolsNotice === droppedServerToolsNotice) {
		return undefined;
	}
	surfacedDroppedServerToolsNotice = droppedServerToolsNotice;
	return (
		`mistral-native: server tools unavailable in chat completions: ${droppedServerToolsNotice.tools.join(", ")}` +
		" — web search is available as the web_search tool; code interpreter runs in hosted agent mode (see https://mawoh.github.io/pi-mistral-native/reference/tools/)"
	);
}

/** Test seam for `takeDroppedServerToolsNoticeMessage` (mirrors takeFallThroughNoticeForTests). */
export const takeDroppedServerToolsNoticeForTests = takeDroppedServerToolsNoticeMessage;

/**
 * Rates for one model id from the effective rate card.
 *
 * Region-surcharge hook: every dynamic-catalog cost flows through this
 * single point. The region-surcharge multiplier (x1.1 for the EU/US
 * regional endpoints) is applied inside `resolveRates`, so it covers
 * config rateCard entries and built-in family rates alike.
 *
 * ADR 0012 — Selectable region endpoint with per-family routing
 */
function effectiveRatesForModel(id: string): ModelRates {
	return ratesAndFallThroughForModel(id).rates;
}

/** Extract the model-card array from a ModelList body (or a bare card array). */
function modelListCards(data: unknown): MistralModelCard[] {
	if (Array.isArray(data)) {
		return data.filter(
			(card): card is MistralModelCard =>
				typeof card === "object" && card !== null && typeof (card as MistralModelCard).id === "string",
		);
	}
	if (typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)) {
		return modelListCards((data as { data: unknown[] }).data);
	}
	throw new Error("Mistral /models response is malformed: expected an object with a data array");
}

/**
 * Map one model card to the pi chat-model config form. `maxTokens` follows
 * the documented max-output mapping (`documentedMaxTokensForModel`): the
 * documented output limit when one exists, otherwise the wire-enforced
 * completion ceiling, capped at the context window.
 *
 * ADR 0017 — Documented max-output mapping over fixed clamp
 */
function toModelConfig(card: MistralModelCard): MistralModelConfig {
	const contextWindow = card.max_context_length ?? 32768;
	return {
		id: card.id,
		name: card.name ?? card.id,
		reasoning: card.capabilities?.reasoning === true,
		input: card.capabilities?.vision === true ? ["text", "image"] : ["text"],
		cost: effectiveRatesForModel(card.id),
		contextWindow,
		maxTokens: documentedMaxTokensForModel(card.id, contextWindow),
		api: "mistral-chat",
	};
}

/**
 * Keep the chat-capable, non-internal, non-archived cards; drop deprecated
 * ones unless that would drop every model (a deprecated-only catalog is
 * still better than none).
 */
function eligibleCards(cards: MistralModelCard[]): MistralModelCard[] {
	const eligible = cards.filter(
		(card) => card.capabilities?.completion_chat === true && card.internal !== true && card.archived !== true,
	);
	let kept = eligible.filter((card) => card.deprecation == null);
	if (kept.length === 0 && eligible.length > 0) {
		kept = eligible;
	}
	return kept;
}

/**
 * Pure mapping of a `GET /v1/models` ModelList body (or its `data` array) to
 * pi chat-model configs: keeps chat-capable models, drops internal, archived
 * and deprecated ones (unless that would drop every model), and sorts by id.
 * Costs come from the effective rate card (config `models.rateCard`
 * overrides checked first, then `DEFAULT_RATES`). Deterministic given the
 * effective config; no side effects — it performs no logging, and the
 * fall-through notice is refresh-level (`fallThroughModelIds` +
 * `refreshMistralModels` + `lastFallThroughNotice`). Throws a descriptive
 * Error on malformed input.
 *
 * ADR 0013 — Per-family rate card with sourced prices and visible fall-through
 */
export function mapModelList(data: unknown): MistralModelConfig[] {
	return eligibleCards(modelListCards(data))
		.map(toModelConfig)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Pure helper revealing which model ids in a `GET /v1/models` body (or its
 * `data` array) get approximate fall-through pricing: the id hit the
 * catch-all entry (or matched nothing) of the combined card — config
 * `models.rateCard` overrides first, then `DEFAULT_RATES`.
 * `refreshMistralModels` records the ids once per refresh cycle in
 * the module-state notice (`lastFallThroughNotice`), which the extension
 * surfaces at most once via `ctx.ui.notify` so cost display can be flagged
 * approximate; `mapModelList` itself stays silent. Same eligibility
 * filtering as `mapModelList`.
 *
 * ADR 0013 — Per-family rate card with sourced prices and visible fall-through
 */
export function fallThroughModelIds(data: unknown): string[] {
	return eligibleCards(modelListCards(data))
		.filter((card) => ratesAndFallThroughForModel(card.id).fallThrough)
		.map((card) => card.id);
}

/**
 * Fetch the model catalog from `GET {baseUrl}/models` with the resolved API
 * key. Throws a descriptive Error on non-200 responses (with `status` set)
 * or a malformed body; network rejections propagate as-is.
 */
export async function fetchMistralModels(
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = mistralFetch,
): Promise<MistralModelCard[]> {
	const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		...(signal ? { signal } : {}),
	});
	if (!response.ok) {
		const error = new Error(`Mistral /models request failed: HTTP ${response.status}`) as Error & {
			status?: number;
		};
		error.status = response.status;
		throw error;
	}
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
		throw new Error("Mistral /models response is malformed: expected an object with a data array");
	}
	return (body as { data: MistralModelCard[] }).data;
}

/** Resolve the bearer token from the effective credential (api key, or OAuth access token). */
function resolveApiKey(credential: Credential | undefined): string | undefined {
	if (!credential) {
		return undefined;
	}
	if (credential.type === "api_key") {
		return credential.key;
	}
	// OAuth credentials: unreachable today — the provider registers no
	// `oauth` block (Mistral offers no OAuth for API access); pi only
	// yields an OAuth credential once it does.
	return credential.type === "oauth" ? credential.access : undefined;
}

/** Map a persisted snapshot's full chat models back to the config form, preserving optional fields. */
function restoreStoredModels(stored: Readonly<ModelsStoreEntry> | undefined): MistralModelConfig[] {
	if (!stored) {
		return [];
	}
	const configs: MistralModelConfig[] = [];
	for (const model of stored.models) {
		if (model.type !== undefined && model.type !== "chat") {
			continue;
		}
		const chat = model as Model<Api>;
		configs.push({
			id: chat.id,
			name: chat.name,
			reasoning: chat.reasoning,
			input: [...chat.input],
			cost: {
				input: chat.cost.input,
				output: chat.cost.output,
				cacheRead: chat.cost.cacheRead,
				cacheWrite: chat.cost.cacheWrite,
				...(chat.cost.tiers ? { tiers: chat.cost.tiers } : {}),
			},
			contextWindow: chat.contextWindow,
			maxTokens: chat.maxTokens,
			api: chat.api,
			...(chat.thinkingLevelMap ? { thinkingLevelMap: chat.thinkingLevelMap } : {}),
			...(chat.promptCache ? { promptCache: chat.promptCache } : {}),
			...(chat.inputLimits ? { inputLimits: chat.inputLimits } : {}),
			...(chat.headers ? { headers: chat.headers as Record<string, string> } : {}),
			...(chat.samplingParams ? { samplingParams: chat.samplingParams } : {}),
			...(chat.compat ? { compat: chat.compat } : {}),
		});
	}
	return configs;
}

/**
 * pi `refreshModels` handler for the `mistral-native` provider.
 *
 * Offline phase (`allowNetwork: false`): restore the persisted snapshot (or
 * fall back to the static `MODELS` catalog) without network access. Network
 * phase: fetch `GET /v1/models` with the resolved credential. Auth failures
 * (HTTP 401/403) throw a clean Error so pi surfaces them in the UI; network
 * unavailability keeps the last-known list so offline startup works.
 */
export async function refreshMistralModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	const restored = restoreStoredModels(context.stored);
	const lastKnown = (): MistralModelConfig[] =>
		restored.length > 0 ? restored : MODELS.map((model) => ({ ...model, cost: { ...model.cost } }));

	// Offline phase: restore the persisted snapshot or the static fallback;
	// no network access, no publish (the composer publishes the returned list).
	if (!context.allowNetwork) {
		return restored.length > 0 ? restored : lastKnown();
	}

	// Honor the shared abort signal before any network access.
	if (context.signal.aborted) {
		return lastKnown();
	}

	const apiKey = resolveApiKey(context.credential);
	if (!apiKey) {
		// Unconfigured provider: no fetch, no crash.
		return [];
	}

	/*
	 * Region-aware base URL: pi's own models.json override (context.baseUrl)
	 * still wins; otherwise the regional base URL applies and the persisted
	 * models carry it.
	 *
	 * ADR 0012 — Selectable region endpoint with per-family routing
	 */
	const baseUrl = context.baseUrl ?? resolveMistralRegionBaseUrl(getEffectiveEndpoint());
	try {
		const cards = await fetchMistralModels(baseUrl, apiKey, context.signal);
		if (context.signal.aborted) {
			return lastKnown();
		}
		const models = mapModelList(cards);
		if (models.length === 0) {
			// A successful fetch that maps to an empty catalog (every card filtered
			// out) must not wipe the last-known list; the composer publishes the
			// returned list either way, so return it without persisting.
			return lastKnown();
		}
		/*
		 * Fall-through visibility: compute once per refresh cycle — not per
		 * model call — and record the ids that got approximate pricing; the
		 * extension surfaces the notice at most once per notice via
		 * `ctx.ui.notify` on the next `session_start` (the extension performs
		 * no logging).
		 *
		 * Decisions: ADR 0004 — API-key credential chain without Mistral OAuth;
		 * ADR 0013 — Per-family rate card with sourced prices and visible
		 * fall-through
		 */
		const fallThrough = fallThroughModelIds(cards);
		fallThroughNotice = fallThrough.length > 0 ? { ids: fallThrough, at: Date.now() } : undefined;
		// Persistence is the handler's job (the composer's refresh path
		// publishes only `{ update }`): store full chat Model objects, not bare
		// configs, so the offline phase can restore them next session. Fetched
		// cards never map a `compat` override, so the cast to AnyModel is exact.
		const full = models.map((model) => ({
			...model,
			type: "chat" as const,
			provider: "mistral-native" as ProviderId,
			baseUrl,
		})) as AnyModel[];
		const published = await context.publish({ persist: { models: full, checkedAt: Date.now() } });
		return published ? models : [];
	} catch (error) {
		if (context.signal.aborted) {
			return lastKnown();
		}
		const status = (error as { status?: number }).status;
		if (status === 401 || status === 403) {
			// Surface auth failures in the UI (pi records thrown refresh errors).
			throw new Error(`Mistral model catalog refresh failed: unauthorized (HTTP ${status})`);
		}
		// Network unavailability, server errors, malformed bodies: keep the last-known catalog.
		return lastKnown();
	}
}
/**
 * The full native pi-ai `Provider` registered with pi: built via
 * `createProvider` so pi's runtime uses it as the compose base untouched —
 * `Models.login` runs our native ApiKeyAuth.login (the guided flow with the
 * region picker, extensions/mistral/auth.ts) and persists the credential
 * itself; models.json/config overlays still apply around it in pi's
 * composer. `api: { stream, streamSimple }` dispatch both to the same
 * `mistralStreamSimple` implementation: pi's `Provider.stream` contract
 * takes `StreamOptions` while `streamSimple` takes `SimpleStreamOptions`,
 * but our implementation reads only the `SimpleStreamOptions` subset — the
 * options pi passes arrive from its own request paths either way.
 * `fetchModels` reuses `refreshMistralModels`: it receives the
 * same `RefreshModelsContext`.
 *
 * Model entries get `provider`/`baseUrl` filled HERE: with the native
 * object registration and no models.json overlay, pi uses the base
 * provider untouched, so the models must be complete — an undefined
 * `model.provider` would break request routing (`prepareRequest` looks up
 * `getProvider(model.provider)`) and `streamSimple` posts to
 * `model.baseUrl`.
 */
export function buildMistralNativeProvider(): Provider {
	const mistralStreams = {
		stream: mistralStreamSimple,
		streamSimple: mistralStreamSimple,
	} as ProviderStreams;
	return createProvider({
		id: "mistral-native",
		name: "Mistral native",
		baseUrl: MISTRAL_BASE_URL,
		/*
		 * No public Mistral OAuth endpoints exist, so the auth surface is
		 * API-key only (native: login with the region picker, chain resolve,
		 * availability check). No `oauth` registration: Mistral offers no
		 * OAuth/device-code/refresh flow for the API. If that changes, register
		 * the pi oauth object here and supersede this decision.
		 *
		 * ADR 0004 — API-key credential chain without Mistral OAuth
		 */
		auth: { apiKey: createMistralApiKeyAuth() },
		models: MODELS.map((model) => ({
			...model,
			type: "chat" as const,
			provider: "mistral-native" as ProviderId,
			baseUrl: MISTRAL_BASE_URL,
		})) as AnyModel[],
		/*
		 * createProvider persists the RETURNED list itself — a second persist
		 * after refreshMistralModels's own, same store, so it must have the
		 * same shape: the entries must be complete chat models (provider/type/
		 * baseUrl) or the offline restore's provider filter drops them next
		 * session. `MistralModelConfig` carries no baseUrl, so the resolution
		 * mirrors refreshMistralModels's own persist: pi's models.json override
		 * (context.baseUrl) wins, else the regional resolution.
		 *
		 * ADR 0012 — Selectable region endpoint with per-family routing
		 */
		fetchModels: async (context) => {
			const configs = await refreshMistralModels(context);
			return configs.map((model) => ({
				...model,
				type: "chat" as const,
				provider: "mistral-native" as ProviderId,
				baseUrl: context.baseUrl ?? resolveMistralRegionBaseUrl(getEffectiveEndpoint()),
			})) as AnyModel[];
		},
		api: mistralStreams,
	});
}

export default function (pi: ExtensionAPI) {
	// Native provider registration: the object form — pi's runtime
	// stores it as the compose base untouched, so /login runs our native
	// ApiKeyAuth and /logout deletes the stored credential.
	pi.registerProvider(buildMistralNativeProvider());

	/*
	 * File-based configuration: refresh the project scope when a session
	 * starts (the user scope is loaded at module import), and surface any
	 * config warning via ctx.ui.notify — the provider keeps working in
	 * env-only degraded mode either way. The fall-through notice of the
	 * latest catalog refresh rides the same channel, surfaced at most once
	 * per notice; the same applies to the dropped-server-tools notice of the
	 * latest chat request that dropped unsupported tools; the region notice is
	 * recomputed here after the refresh, so project-scoped regions warn from
	 * the session that activates them.
	 *
	 * Decisions: ADR 0010 — Configuration via mistral-native.json aligned to
	 * the pi ecosystem convention; ADR 0012 — Selectable region endpoint with
	 * per-family routing; ADR 0013 — Per-family rate card with sourced prices
	 * and visible fall-through
	 */
	pi.on("session_start", (_event, ctx) => {
		refreshMistralConfig(ctx.cwd, ctx.isProjectTrusted(), (message, type) => ctx.ui.notify(message, type));
		const fallThroughMessage = takeFallThroughNoticeMessage();
		if (fallThroughMessage !== undefined) ctx.ui.notify(fallThroughMessage, "warning");
		const droppedServerToolsMessage = takeDroppedServerToolsNoticeMessage();
		if (droppedServerToolsMessage !== undefined) ctx.ui.notify(droppedServerToolsMessage, "warning");
		const endpoint = getEffectiveEndpoint();
		if (endpoint.region !== "global") {
			const regionBase = resolveMistralRegionBaseUrl(endpoint);
			ctx.ui.notify(
				`Mistral region "${endpoint.region}" is active: chat completions and the model catalog use ${regionBase}. Knowledge APIs, server-side tools, agent mode and connectors stay on the global endpoint (${MISTRAL_BASE_URL}) — those services are not available regionally. Regional token rates carry a +10% surcharge. Control-plane data (account, billing, analytics) may still be handled outside the region.`,
				"warning",
			);
		}
	});

	registerOcrKnowledgeTools(pi);

	// Library/RAG knowledge tools: files, libraries, documents and RAG queries.
	registerKnowledgeTools(pi);

	// Web-search tool over stateless one-shot Conversations calls.
	registerWebSearchTools(pi);

	// Code-interpreter tool over a stateless one-shot Conversations call.
	registerCodeInterpreterTool(pi);

	registerConnectorTools(pi);

	// Client-side connector tools: loader pattern — authenticated connector
	// tools become client-side callable pi tools, registered passively
	// (deferred) and activated on demand.
	registerConnectorLoaderTools(pi);

	// The /mistral command family: status card with per-value provenance,
	// user-default/project-opt-in set, live connectivity test.
	registerMistralCommands(pi);
}
