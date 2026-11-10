/**
 * File-based configuration via `mistral-native.json`.
 *
 * A JSON configuration layer with user and project scope, layered BELOW the
 * environment overrides: precedence (highest wins) is project JSON > user
 * JSON > environment variables > defaults. The API key itself is NOT a
 * config-file field — it stays in pi's auth chain (`~/.pi/agent/auth.json`
 * credential via `/login mistral-native`, or the `MISTRAL_API_KEY`
 * environment variable).
 *
 * Validation is strict and pure: unknown fields and invalid values produce
 * errors naming the exact file path, the key's section-qualified name and
 * the valid options. Loaders never throw — a missing file yields defaults,
 * a malformed or invalid file is ignored (env-only degraded mode) and the
 * error is surfaced as a warning the extension reports through
 * `ctx.ui.notify`.
 *
 * Some sections are "reserved-and-parsed": strictly validated and exposed
 * on the resolved config, but no behavior derives from them yet — they
 * exist so the schema is complete in one pass and files written before a
 * section becomes behavioral keep validating. The `models` section is
 * behavioral: it drives the rate-card overrides and the fall-through flag
 * of the dynamic catalog. The `endpoint` section is behavioral (selectable
 * region): chat completions and the model catalog route to the regional
 * base URL, everything else stays on the global endpoint. The `retry`
 * section is behavioral (shared retry policy): it drives the retry
 * budget and backoff of the chat stream and the tool fetch paths.
 *
 * Decisions: ADR 0010 — Configuration via mistral-native.json aligned to
 * the pi ecosystem convention; ADR 0004 — API-key credential chain without
 * Mistral OAuth; ADR 0013 — Per-family rate card with sourced prices and
 * visible fall-through; ADR 0012 — Selectable region endpoint with
 * per-family routing.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";


/** Default model for the web-search and code-interpreter tools' Conversations calls (wire-verified 2026-11-03: mistral-large-4 refuses builtin connectors on /v1/conversations, error 3004; mistral-small-latest runs the search tool). */
export const DEFAULT_SEARCH_MODEL = "mistral-small-latest";

/** Name of the config file in every scope (user and project). */
export const CONFIG_FILE_NAME = "mistral-native.json";

/** Server-side tool names accepted in `serverTools` (extensions/mistral/server-tools.ts). */
export const KNOWN_CONFIG_SERVER_TOOLS: readonly string[] = [
	"web_search",
	"web_search_premium",
	"image_generation",
	"code_interpreter",
];

/** Valid values for `endpoint.region`. */
export type MistralRegion = "global" | "eu" | "us";

/**
 * `endpoint` section (behavioral — region routing).
 *
 * Decisions: ADR 0012 — Selectable region endpoint with per-family routing.
 */
export interface EndpointConfig {
	/** `"global"` | `"eu"` | `"us"`; undefined when the file leaves it unset (effective default: `"global"`). */
	region: MistralRegion | undefined;
	baseUrl: string | undefined;
}

/**
 * `connectorTools` section: client-side connector tools loader.
 *
 * Decisions: ADR 0011 — Client-side connector tools via the loader pattern.
 */
export interface ConnectorToolsConfig {
	enabled: boolean | undefined;
	autoLoad: string[] | undefined;
}

/** One `models.rateCard` entry; shape aligned with RateCardEntry in extensions/mistral.ts. Entries are checked BEFORE the built-in rate card (same-`match` entries shadow built-ins). */
export interface RateCardOverride {
	match: string;
	rates: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * `models` section (behavioral): `rateCard` overrides the built-in family
 * rate card of the dynamic catalog (config entries checked first,
 * shadowing same-`match` built-ins); `fallThrough` switches unpriced models
 * from catch-all rates to a zero-cost placeholder (still flagged
 * approximate).
 *
 * Decisions: ADR 0013 — Per-family rate card with sourced prices and
 * visible fall-through.
 */
export interface ModelsRateCardConfig {
	rateCard: RateCardOverride[] | undefined;
	fallThrough: boolean | undefined;
}

/** `knowledge` section (RESERVED — `searchModel` is behavioral for the web-search and code-interpreter tools). */
export interface KnowledgeConfig {
	streaming: boolean | undefined;
	/** Model used by the web-search and code-interpreter tools' Conversations calls; undefined → the DEFAULT_SEARCH_MODEL. */
	searchModel: string | undefined;
}

/** `rag` section (RESERVED). */
export interface RagConfig {
	streaming: boolean | undefined;
	defaultLibraryId: string | undefined;
}

/** `ocr` section (RESERVED). */
export interface OcrConfig {
	defaultModel: string | undefined;
}

/**
 * `retry` section (behavioral): the shared retry policy of the chat
 * stream and the tool fetch paths. All three keys are positive integers;
 * `maxAttempts` counts RETRIES after the initial request, and
 * `maxDelayMs` must be >= `baseDelayMs` (default 1000).
 *
 * ADR 0025 — Staggered retry with configurable backoff
 */
export interface RetryConfig {
	/** Retries after the initial request (default 3 — up to 4 requests in total). */
	maxAttempts: number | undefined;
	/** Backoff base in ms; the delay ladder is baseDelayMs · 2^attempt (default 1000). */
	baseDelayMs: number | undefined;
	/** Ceiling for every wait incl. server-requested delays (default 30000). */
	maxDelayMs: number | undefined;
}

/**
 * Validated shape of `mistral-native.json` (every section optional; an absent
 * key means "unset" and falls through to lower precedence layers). Fields are
 * optional-with-undefined so both absent keys and explicitly-undefined
 * assignments are valid under exactOptionalPropertyTypes.
 */
export interface MistralFileConfig {
	serverTools?: string[] | undefined;
	connectors?: string[] | undefined;
	agentId?: string | undefined;
	endpoint?: EndpointConfig | undefined;
	connectorTools?: ConnectorToolsConfig | undefined;
	models?: ModelsRateCardConfig | undefined;
	knowledge?: KnowledgeConfig | undefined;
	rag?: RagConfig | undefined;
	ocr?: OcrConfig | undefined;
	retry?: RetryConfig | undefined;
}

/** Known top-level fields, alphabetical, for unknown-field error messages. */
const KNOWN_TOP_LEVEL_FIELDS = [
	"agentId",
	"connectorTools",
	"connectors",
	"endpoint",
	"knowledge",
	"models",
	"ocr",
	"rag",
	"retry",
	"serverTools",
];

/** Result of loading one scope's config file; never throws. */
export interface MistralConfigLoadResult {
	/** Validated config; undefined when no valid file was found. */
	value: MistralFileConfig | undefined;
	/** Path of the file this value came from (undefined when none was loaded). */
	path: string | undefined;
	/**
	 * Warning message for a file that existed but could not be used (read
	 * error, malformed JSON, validation failure). The file is ignored;
	 * behavior degrades to the lower-precedence layers.
	 */
	warning: string | undefined;
}

// =============================================================================
// Config-value protocol (pi's resolveConfigValue semantics, implemented
// locally: pi does not export resolveConfigValue through its package root)
// =============================================================================

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const CONFIG_VALUE_COMMAND_TIMEOUT_MS = 10_000;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

/** Whether an env value counts as set (mirrors pi: empty string = unset). */
function readEnv(env: Record<string, string | undefined> | undefined, name: string): string | undefined {
	return env?.[name] ?? process.env[name] ?? undefined;
}

/** Parse a non-command value into literal and `$VAR`/`${VAR}` template parts (with `$$`/`$!` escapes). */
function parseTemplate(value: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	const pushLiteral = (text: string) => {
		if (text.length === 0) return;
		const last = parts[parts.length - 1];
		if (last !== undefined && last.type === "literal") last.value += text;
		else parts.push({ type: "literal", value: text });
	};
	let index = 0;
	while (index < value.length) {
		const dollarIndex = value.indexOf("$", index);
		if (dollarIndex < 0) {
			pushLiteral(value.slice(index));
			break;
		}
		pushLiteral(value.slice(index, dollarIndex));
		const nextChar = value[dollarIndex + 1];
		if (nextChar === "$" || nextChar === "!") {
			pushLiteral(nextChar);
			index = dollarIndex + 2;
			continue;
		}
		if (nextChar === "{") {
			const endIndex = value.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				pushLiteral("$");
				index = dollarIndex + 1;
				continue;
			}
			const name = value.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: "env", name });
			else pushLiteral(value.slice(dollarIndex, endIndex + 1));
			index = endIndex + 1;
			continue;
		}
		const match = ENV_VAR_NAME_PREFIX_RE.exec(value.slice(dollarIndex + 1));
		if (match !== null) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}
		pushLiteral("$");
		index = dollarIndex + 1;
	}
	return parts;
}

/** Resolve template parts against env; a referenced-but-unset var yields undefined. */
function resolveTemplate(parts: TemplatePart[], env: Record<string, string | undefined> | undefined): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = readEnv(env, part.name);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

/**
 * Resolve a config value using pi's config-value protocol (mirrors the
 * documented semantics of pi-coding-agent's `resolveConfigValue`):
 * - a leading `!` executes the rest as a shell command (timeout 10s); the
 *   trimmed stdout is the value, failures resolve to undefined; command
 *   results are cached for the process lifetime (mirroring pi's
 *   `resolveConfigValue` `commandResultCache`), so a `!cmd` value runs at
 *   most once per process, per command string — failures are cached too;
 *   `clearMistralConfigValueCache` clears the cache (for tests);
 * - otherwise `$NAME` / `${NAME}` interpolate environment variables, with
 *   `$$` → `$` and `$!` → `!` escapes; a referenced-but-unset env var makes
 *   the whole value resolve to undefined;
 * - otherwise the value is a literal.
 *
 * Pure and synchronous; never logs resolved values.
 */
const commandResultCache = new Map<string, string | undefined>();

/** Clear the process-lifetime `!cmd` result cache (mirror of pi's `clearConfigValueCache`; for tests). */
export function clearMistralConfigValueCache(): void {
	commandResultCache.clear();
}

export function resolveConfigValueProtocol(
	value: string,
	env: Record<string, string | undefined> | undefined = undefined,
): string | undefined {
	if (value.startsWith("!")) {
		const command = value.slice(1);
		if (commandResultCache.has(command)) return commandResultCache.get(command);
		let resolved: string | undefined;
		try {
			const output = execSync(command, {
				encoding: "utf-8",
				timeout: CONFIG_VALUE_COMMAND_TIMEOUT_MS,
				stdio: ["ignore", "pipe", "ignore"],
			});
			resolved = output.trim().length > 0 ? output.trim() : undefined;
		} catch {
			resolved = undefined;
		}
		commandResultCache.set(command, resolved);
		return resolved;
	}
	return resolveTemplate(parseTemplate(value), env);
}

// =============================================================================
// Strict validation (pure, synchronous)
// =============================================================================

/** Read the config file's own keys (a JSON object; never an array). */
function ownKeys(value: Record<string, unknown>): string[] {
	return Object.keys(value);
}

/** Quote a list for "known fields:" / "must be one of:" error messages. */
function quoteList(values: readonly string[]): string {
	return values.map((value) => `"${value}"`).join(", ");
}

/** Whether a value is a non-null object (JSON objects only; arrays rejected by callers where relevant). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a section object: must be a JSON object, not an array, not null (JSON null is a validation error). */
function sectionObject(value: unknown, field: string, path: string): { error: string } | { object: Record<string, unknown> } {
	if (!isPlainObject(value)) {
		return { error: `field "${field}" in ${path} must be a JSON object` };
	}
	return { object: value };
}

/** Validate an optional boolean section key; undefined when absent. */
function optionalBoolean(
	object: Record<string, unknown>,
	key: string,
	section: string,
	path: string,
): { error?: undefined; value?: boolean } | { error: string; value?: undefined } {
	const raw = object[key];
	if (raw === undefined) return {};
	if (typeof raw !== "boolean") {
		return { error: `field "${section}.${key}" in ${path} must be a boolean; got ${JSON.stringify(raw) ?? String(raw)}` };
	}
	return { value: raw };
}

/** Validate an optional string section key. */
function optionalString(
	object: Record<string, unknown>,
	key: string,
	section: string,
	path: string,
): { error?: undefined; value?: string } | { error: string; value?: undefined } {
	const raw = object[key];
	if (raw === undefined) return {};
	if (typeof raw !== "string") {
		return { error: `field "${section}.${key}" in ${path} must be a string; got ${JSON.stringify(raw) ?? String(raw)}` };
	}
	return { value: raw };
}

/** Reject unknown keys inside a section object (known fields listed alphabetically). */
function rejectUnknownSectionKeys(
	object: Record<string, unknown>,
	known: readonly string[],
	section: string,
	path: string,
): string | undefined {
	const sorted = [...known].sort();
	for (const key of ownKeys(object)) {
		if (!known.includes(key)) {
			return `unknown field "${section}.${key}" in ${path}; known fields: ${sorted.join(", ")}`;
		}
	}
	return undefined;
}

/** Validate the top-level `serverTools` / `connectors` string arrays. */
function optionalKnownStringArray(
	raw: unknown,
	field: string,
	path: string,
	allowed: readonly string[] | undefined,
): { error?: undefined; value?: string[] } | { error: string; value?: undefined } {
	if (raw === undefined) return {};
	if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
		const options = allowed !== undefined ? `; known tools: ${allowed.join(", ")}` : "";
		return {
			error:
				field === "serverTools"
					? `field "${field}" in ${path} must be an array of strings${options}`
					: `field "${field}" in ${path} must be an array of strings`,
		};
	}
	const values = raw as string[];
	if (allowed !== undefined) {
		const unknown = values.find((entry) => !allowed.includes(entry));
		if (unknown !== undefined) {
			return {
				error: `field "${field}" in ${path} must be one of: ${quoteList(allowed)} (per entry); got "${unknown}"`,
			};
		}
	}
	return { value: values };
}

/**
 * Validate a parsed JSON value against the mistral-native.json schema.
 * Pure and synchronous; returns the validated config or a precise error
 * message naming the file path and the key (never throws).
 */
export function validateMistralFileConfig(
	parsed: unknown,
	path: string,
): { config?: MistralFileConfig; error?: string } {
	if (!isPlainObject(parsed)) {
		return { error: `failed to parse ${path}: the file must contain a JSON object` };
	}
	const root = parsed;

	// Reserved-and-parsed sections: strictly validated and exposed, no
	// behavior derives from them yet.
	for (const key of ownKeys(root)) {
		if (!KNOWN_TOP_LEVEL_FIELDS.includes(key)) {
			return { error: `unknown field "${key}" in ${path}; known fields: ${KNOWN_TOP_LEVEL_FIELDS.join(", ")}` };
		}
	}

	if (Object.hasOwn(root, "serverTools") && root.serverTools === null) {
		return { error: `field "serverTools" in ${path} must not be null; omit the key to leave it unset` };
	}
	const serverTools = optionalKnownStringArray(root.serverTools, "serverTools", path, KNOWN_CONFIG_SERVER_TOOLS);
	if (serverTools.error !== undefined) return { error: serverTools.error };

	if (Object.hasOwn(root, "connectors") && root.connectors === null) {
		return { error: `field "connectors" in ${path} must not be null; omit the key to leave it unset` };
	}
	const connectors = optionalKnownStringArray(root.connectors, "connectors", path, undefined);
	if (connectors.error !== undefined) return { error: connectors.error };

	let agentId: string | undefined;
	if (root.agentId !== undefined) {
		if (typeof root.agentId !== "string") {
			return { error: `field "agentId" in ${path} must be a string; got ${JSON.stringify(root.agentId) ?? String(root.agentId)}` };
		}
		// Trimmed; empty-after-trim = unset.
		agentId = root.agentId.trim().length > 0 ? root.agentId.trim() : undefined;
	}

	// Reserved-and-parsed sections: strictly validated and exposed, no
	// behavior derives from them yet.

	let endpoint: EndpointConfig | undefined;
	if (root.endpoint !== undefined) {
		const section = sectionObject(root.endpoint, "endpoint", path);
		if ("error" in section) return { error: section.error };
		const unknown = rejectUnknownSectionKeys(section.object, ["region", "baseUrl"], "endpoint", path);
		if (unknown !== undefined) return { error: unknown };
		let region: MistralRegion | undefined;
		if (section.object.region !== undefined) {
			if (section.object.region !== "global" && section.object.region !== "eu" && section.object.region !== "us") {
				return {
					error: `field "endpoint.region" in ${path} must be one of: ${quoteList(["global", "eu", "us"])}; got ${JSON.stringify(section.object.region) ?? String(section.object.region)}`,
				};
			}
			region = section.object.region;
		}
		const baseUrl = optionalString(section.object, "baseUrl", "endpoint", path);
		if (baseUrl.error !== undefined) return { error: baseUrl.error };
		endpoint = { region, baseUrl: baseUrl.value };
	}

	let connectorTools: ConnectorToolsConfig | undefined;
	if (root.connectorTools !== undefined) {
		const section = sectionObject(root.connectorTools, "connectorTools", path);
		if ("error" in section) return { error: section.error };
		const unknown = rejectUnknownSectionKeys(section.object, ["enabled", "autoLoad"], "connectorTools", path);
		if (unknown !== undefined) return { error: unknown };
		const enabled = optionalBoolean(section.object, "enabled", "connectorTools", path);
		if (enabled.error !== undefined) return { error: enabled.error };
		let autoLoad: string[] | undefined;
		if (section.object.autoLoad !== undefined) {
			const array = optionalKnownStringArray(section.object.autoLoad, "connectorTools.autoLoad", path, undefined);
			if (array.error !== undefined) return { error: array.error };
			autoLoad = array.value;
		}
		connectorTools = { enabled: enabled.value, autoLoad };
	}

	let models: ModelsRateCardConfig | undefined;
	if (root.models !== undefined) {
		const section = sectionObject(root.models, "models", path);
		if ("error" in section) return { error: section.error };
		const unknown = rejectUnknownSectionKeys(section.object, ["rateCard", "fallThrough"], "models", path);
		if (unknown !== undefined) return { error: unknown };
		const fallThrough = optionalBoolean(section.object, "fallThrough", "models", path);
		if (fallThrough.error !== undefined) return { error: fallThrough.error };
		let rateCard: RateCardOverride[] | undefined;
		if (section.object.rateCard !== undefined) {
			if (!Array.isArray(section.object.rateCard)) {
				return { error: `field "models.rateCard" in ${path} must be an array` };
			}
			const entries: RateCardOverride[] = [];
			for (let i = 0; i < section.object.rateCard.length; i++) {
				const entry = section.object.rateCard[i];
				if (!isPlainObject(entry)) {
					return { error: `field "models.rateCard[${i}]" in ${path} must be a JSON object` };
				}
				const entryUnknown = rejectUnknownSectionKeys(entry, ["match", "rates"], `models.rateCard[${i}]`, path);
				if (entryUnknown !== undefined) return { error: entryUnknown };
				if (typeof entry.match !== "string") {
					return { error: `field "models.rateCard[${i}].match" in ${path} must be a string` };
				}
				const ratesRaw = entry.rates;
				if (!isPlainObject(ratesRaw)) {
					return { error: `field "models.rateCard[${i}].rates" in ${path} must be a JSON object` };
				}
				const ratesUnknown = rejectUnknownSectionKeys(ratesRaw, ["input", "output", "cacheRead", "cacheWrite"], `models.rateCard[${i}].rates`, path);
				if (ratesUnknown !== undefined) return { error: ratesUnknown };
				const rates: { input: number; output: number; cacheRead: number; cacheWrite: number } = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				};
				for (const rateKey of ["input", "output", "cacheRead", "cacheWrite"] as const) {
					const rateValue = ratesRaw[rateKey];
					if (typeof rateValue !== "number" || !Number.isFinite(rateValue) || rateValue < 0) {
						return {
							error: `field "models.rateCard[${i}].rates.${rateKey}" in ${path} must be a non-negative number`,
						};
					}
					rates[rateKey] = rateValue;
				}
				entries.push({ match: entry.match, rates });
			}
			rateCard = entries;
		}
		models = { rateCard, fallThrough: fallThrough.value };
	}

	let knowledge: KnowledgeConfig | undefined;
	if (root.knowledge !== undefined) {
		const section = sectionObject(root.knowledge, "knowledge", path);
		if ("error" in section) return { error: section.error };
		const unknown = rejectUnknownSectionKeys(section.object, ["streaming", "searchModel"], "knowledge", path);
		if (unknown !== undefined) return { error: unknown };
		const streaming = optionalBoolean(section.object, "streaming", "knowledge", path);
		if (streaming.error !== undefined) return { error: streaming.error };
		// searchModel: a non-empty string after trim (model ids are NOT
		// validated here — an unknown id surfaces at use time as the tool's
		// 3004-friendly error, not a config validation failure).
		let searchModel: string | undefined;
		if (section.object.searchModel !== undefined) {
			if (typeof section.object.searchModel !== "string") {
				return { error: `field "knowledge.searchModel" in ${path} must be a string; got ${JSON.stringify(section.object.searchModel) ?? String(section.object.searchModel)}` };
			}
			const trimmed = section.object.searchModel.trim();
			if (trimmed.length === 0) {
				return { error: `field "knowledge.searchModel" in ${path} must not be empty; omit the key to leave it unset` };
			}
			searchModel = trimmed;
		}
		knowledge = { streaming: streaming.value, searchModel };
	}

	let rag: RagConfig | undefined;
	if (root.rag !== undefined) {
		const section = sectionObject(root.rag, "rag", path);
		if ("error" in section) return { error: section.error };
		const unknown = rejectUnknownSectionKeys(section.object, ["streaming", "defaultLibraryId"], "rag", path);
		if (unknown !== undefined) return { error: unknown };
		const streaming = optionalBoolean(section.object, "streaming", "rag", path);
		if (streaming.error !== undefined) return { error: streaming.error };
		const defaultLibraryId = optionalString(section.object, "defaultLibraryId", "rag", path);
		if (defaultLibraryId.error !== undefined) return { error: defaultLibraryId.error };
		rag = { streaming: streaming.value, defaultLibraryId: defaultLibraryId.value };
	}

	let ocr: OcrConfig | undefined;
	if (root.ocr !== undefined) {
		const section = sectionObject(root.ocr, "ocr", path);
		if ("error" in section) return { error: section.error };
		const unknown = rejectUnknownSectionKeys(section.object, ["defaultModel"], "ocr", path);
		if (unknown !== undefined) return { error: unknown };
		const defaultModel = optionalString(section.object, "defaultModel", "ocr", path);
		if (defaultModel.error !== undefined) return { error: defaultModel.error };
		ocr = { defaultModel: defaultModel.value };
	}

	/*
	 * Retry section: all three keys are positive integers (0 is invalid —
	 * retries cannot be disabled via config), and maxDelayMs must be >=
	 * baseDelayMs, where baseDelayMs is this section's value when present,
	 * else the built-in default. Cross-scope merges can still produce a
	 * degenerate max < base pair (user file sets base 5000, project file
	 * sets max 3000); the delay computation's min() simply caps every
	 * delay at maxDelayMs — benign.
	 *
	 * ADR 0025 — Staggered retry with configurable backoff
	 */
	let retry: RetryConfig | undefined;
	if (root.retry !== undefined) {
		const section = sectionObject(root.retry, "retry", path);
		if ("error" in section) return { error: section.error };
		const unknown = rejectUnknownSectionKeys(section.object, ["maxAttempts", "baseDelayMs", "maxDelayMs"], "retry", path);
		if (unknown !== undefined) return { error: unknown };
		const positiveInteger = (key: string): { error?: undefined; value?: number } | { error: string; value?: undefined } => {
			const raw = section.object[key];
			if (raw === undefined) return {};
			if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
				return {
					error: `field "retry.${key}" in ${path} must be a positive integer; got ${JSON.stringify(raw) ?? String(raw)}`,
				};
			}
			return { value: raw };
		};
		const maxAttempts = positiveInteger("maxAttempts");
		if (maxAttempts.error !== undefined) return { error: maxAttempts.error };
		const baseDelayMs = positiveInteger("baseDelayMs");
		if (baseDelayMs.error !== undefined) return { error: baseDelayMs.error };
		const maxDelayMs = positiveInteger("maxDelayMs");
		if (maxDelayMs.error !== undefined) return { error: maxDelayMs.error };
		if (maxDelayMs.value !== undefined && maxDelayMs.value < (baseDelayMs.value ?? DEFAULT_RETRY_BASE_DELAY_MS)) {
			return {
				error: `field "retry.maxDelayMs" in ${path} must be greater than or equal to retry.baseDelayMs (${DEFAULT_RETRY_BASE_DELAY_MS} by default)`,
			};
		}
		retry = { maxAttempts: maxAttempts.value, baseDelayMs: baseDelayMs.value, maxDelayMs: maxDelayMs.value };
	}

	return {
		config: {
			serverTools: serverTools.value,
			connectors: connectors.value,
			agentId,
			endpoint,
			connectorTools,
			models,
			knowledge,
			rag,
			ocr,
			retry,
		},
	};
}

// =============================================================================
// Resolution chain and loading
// =============================================================================

/** The user's home directory: `HOME` from the given env when set, else the OS home. */
function homeDir(env: Record<string, string | undefined> | undefined): string {
	const fromEnv = env?.HOME ?? process.env.HOME;
	return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : homedir();
}

/** The default pi agent directory: `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`. */
export function defaultAgentDir(env: Record<string, string | undefined> | undefined = process.env): string {
	const explicit = env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	return explicit !== undefined && explicit.length > 0 ? explicit : join(homeDir(env), ".pi", "agent");
}

/**
 * Ordered user-scope resolution chain for `mistral-native.json` (modeled on
 * pi-web-access); the first existing file wins:
 * 1. `$PI_CODING_AGENT_DIR/mistral-native.json`
 * 2. `$XDG_CONFIG_HOME/pi/mistral-native.json` (default
 *    `~/.config/pi/mistral-native.json` when `XDG_CONFIG_HOME` is unset)
 * 3. `<agent-dir>/mistral-native.json` (agent-dir = `PI_CODING_AGENT_DIR`
 *    if set, else `~/.pi/agent`)
 * 4. `~/.pi/mistral-native.json` (lowest-precedence legacy hop)
 *
 * Steps 1 and 3 collapse when `PI_CODING_AGENT_DIR` is set — that is fine;
 * the chain is kept as ordered. Pure.
 */
export function userConfigPaths(env: Record<string, string | undefined> | undefined = process.env): string[] {
	const read = (name: string): string | undefined => env?.[name] ?? process.env[name] ?? undefined;
	const paths: string[] = [];
	const piDir = read("PI_CODING_AGENT_DIR");
	if (piDir !== undefined && piDir.length > 0) paths.push(join(piDir, CONFIG_FILE_NAME));
	const xdg = read("XDG_CONFIG_HOME");
	const xdgBase = xdg !== undefined && xdg.length > 0 ? xdg : join(homeDir(env), ".config");
	paths.push(join(xdgBase, "pi", CONFIG_FILE_NAME));
	paths.push(join(defaultAgentDir(env), CONFIG_FILE_NAME));
	paths.push(join(homeDir(env), ".pi", CONFIG_FILE_NAME));
	return paths;
}

/** Project-scope config path: `<cwd>/.pi/mistral-native.json` (loads only when project trust is active). */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILE_NAME);
}

/** Injectable file reader for tests; the default is a real synchronous fs read. */
export type ConfigReadFileFn = (path: string) => string;

/** The default file reader: synchronous fs read. */
const defaultReadFile: ConfigReadFileFn = (path) => readFileSync(path, "utf-8");

/**
 * Load one scope's config file at `path` (never throws):
 * - read error with `ENOENT` → not found (empty result);
 * - other read errors → warning;
 * - malformed JSON → `failed to parse <path>: <parse error>` warning;
 * - validation error → the validation message as warning.
 * A file that produced a warning is ignored (lower layers apply).
 */
function loadConfigFile(path: string, readFile: ConfigReadFileFn): MistralConfigLoadResult {
	let text: string;
	try {
		text = readFile(path);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return { value: undefined, path: undefined, warning: undefined };
		return { value: undefined, path, warning: `failed to read ${path}: ${(error as Error).message}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return { value: undefined, path, warning: `failed to parse ${path}: ${(error as Error).message}` };
	}
	const { config, error } = validateMistralFileConfig(parsed, path);
	if (error !== undefined || config === undefined) {
		return { value: undefined, path, warning: error ?? `invalid config in ${path}` };
	}
	return { value: config, path, warning: undefined };
}

/**
 * Load the user-scope config: the first existing file in the resolution
 * chain (`userConfigPaths`), validated. Never throws.
 */
export function loadUserMistralConfig(
	env: Record<string, string | undefined> | undefined = process.env,
	readFile: ConfigReadFileFn = defaultReadFile,
): MistralConfigLoadResult {
	for (const path of userConfigPaths(env)) {
		const result = loadConfigFile(path, readFile);
		if (result.value === undefined && result.warning === undefined) continue; // ENOENT: try the next hop
		return result;
	}
	return { value: undefined, path: undefined, warning: undefined };
}

/**
 * Load the project-scope config: `<cwd>/.pi/mistral-native.json`, validated.
 * Never throws.
 */
export function loadProjectMistralConfig(
	cwd: string,
	readFile: ConfigReadFileFn = defaultReadFile,
): MistralConfigLoadResult {
	return loadConfigFile(projectConfigPath(cwd), readFile);
}

// =============================================================================
// Merging (project wins; per-key deep merge inside section objects)
// =============================================================================

function mergeSection<T>(user: T | undefined, project: T | undefined): T | undefined {
	if (project === undefined) return user;
	if (user === undefined) return project;
	const merged: Record<string, unknown> = { ...(user as Record<string, unknown>) };
	for (const [key, value] of Object.entries(project as Record<string, unknown>)) {
		merged[key] = value;
	}
	return merged as T;
}

/**
 * Merge user and project file configs: project wins per key; nested section
 * objects merge key-by-key (project key wins, user keys survive otherwise).
 * Pure.
 */
export function mergeMistralFileConfigs(
	user: MistralFileConfig | undefined,
	project: MistralFileConfig | undefined,
): MistralFileConfig | undefined {
	if (user === undefined) return project;
	if (project === undefined) return user;
	return {
		serverTools: project.serverTools ?? user.serverTools,
		connectors: project.connectors ?? user.connectors,
		agentId: project.agentId ?? user.agentId,
		endpoint: mergeSection(user.endpoint, project.endpoint),
		connectorTools: mergeSection(user.connectorTools, project.connectorTools),
		models: mergeSection(user.models, project.models),
		knowledge: mergeSection(user.knowledge, project.knowledge),
		rag: mergeSection(user.rag, project.rag),
		ocr: mergeSection(user.ocr, project.ocr),
		retry: mergeSection(user.retry, project.retry),
	};
}

// =============================================================================
// User-scope region write (the guided login's region picker)
// =============================================================================

/** Injectable file-existence probe for tests; the default is a real fs check. */
export type ConfigFileExistsFn = (path: string) => boolean;

/** The default file-existence probe: synchronous real fs check. */
const defaultFileExists: ConfigFileExistsFn = (path) => {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
};

/** Injectable file writer for tests; the default is a real synchronous fs write. */
export type ConfigWriteFileFn = (path: string, text: string) => void;

/** The default file writer: synchronous fs write. */
const defaultWriteFile: ConfigWriteFileFn = (path, text) => writeFileSync(path, text);

/** The write target: the first existing path in the chain, else the chain head. */
function regionWriteTargetPath(
	env: Record<string, string | undefined> | undefined,
	fileExists: ConfigFileExistsFn,
): string {
	const paths = userConfigPaths(env);
	for (const path of paths) {
		if (fileExists(path)) return path;
	}
	return paths[0]!;
}

/**
 * Write `endpoint.region` into the user-scope `mistral-native.json` (the
 * guided login's region picker; the region key the stream routes by).
 * Atomic and surgical:
 *
 * - Target: the FIRST path of the user-scope chain whose file exists, else
 *   the chain head (`userConfigPaths`) — the config loader reads the first
 *   EXISTING file, so the write must land where the loader will read.
 * - Any existing file content is preserved: it is parsed and only
 *   `endpoint.region` is merged in (`endpoint` keys stay ⊂ {region, baseUrl};
 *   region ∈ {global, eu, us}, mirroring `validateMistralFileConfig`). An
 *   existing file that fails to parse throws a descriptive Error rather
 *   than clobbering it; an existing non-object root (e.g. an array) too.
 * - Atomic: write to `<path>.tmp-<pid>`, then `renameSync` over the target
 *   (parent dirs created first). Never writes anything except the existing
 *   content plus `endpoint.region` — never credentials.
 *
 * Injectable (`env`, `readFile`, `writeFile`, `fileExists`) so tests can mock
 * the file chain. Does NOT touch the cached `effectiveConfig` module state:
 * the next `session_start` refresh reads the file.
 *
 * Decisions: ADR 0012 — Selectable region endpoint with per-family routing.
 */
export function writeUserMistralRegion(
	region: MistralRegion,
	env: Record<string, string | undefined> | undefined = process.env,
	readFile: ConfigReadFileFn = defaultReadFile,
	writeFile: ConfigWriteFileFn = defaultWriteFile,
	fileExists: ConfigFileExistsFn = defaultFileExists,
): string {
	const target = regionWriteTargetPath(env, fileExists);
	let root: Record<string, unknown> = {};
	if (fileExists(target)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFile(target)) as unknown;
		} catch (error) {
			throw new Error(
				`cannot merge endpoint.region into ${target}: the existing file is not valid JSON (${(error as Error).message}); leaving it untouched`,
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(
				`cannot merge endpoint.region into ${target}: the existing file must contain a JSON object; leaving it untouched`,
			);
		}
		root = parsed as Record<string, unknown>;
	}
	const existingEndpoint =
		typeof root.endpoint === "object" && root.endpoint !== null && !Array.isArray(root.endpoint)
			? (root.endpoint as Record<string, unknown>)
			: {};
	// Mirror the loader's validation: endpoint keys ⊂ {region, baseUrl}.
	for (const key of Object.keys(existingEndpoint)) {
		if (key !== "region" && key !== "baseUrl") {
			throw new Error(
				`cannot merge endpoint.region into ${target}: unknown existing field "endpoint.${key}" (known fields: baseUrl, region); leaving the file untouched`,
			);
		}
	}
	if (existingEndpoint.baseUrl !== undefined && typeof existingEndpoint.baseUrl !== "string") {
		throw new Error(
				`cannot merge endpoint.region into ${target}: field "endpoint.baseUrl" must be a string; leaving the file untouched`,
		);
	}
	root.endpoint = { ...existingEndpoint, region };
	const text = `${JSON.stringify(root, null, "\t")}\n`;
	if (writeFile === defaultWriteFile) {
		// Real write, atomic: create parent dirs, write to a temp sibling,
		// then rename over the target (never truncates the target first, so a
		// failed write leaves the existing file intact). Known trade-offs:
		// rename-over-existing resets the target's file permissions to the
		// process default (no mode preservation), and on Windows the rename
		// can fail while the target is held open — both acceptable for a
		// user-scope config file written once per login.
		mkdirSync(dirname(target), { recursive: true });
		const temp = `${target}.tmp-${process.pid}`;
		writeFileSync(temp, text);
		renameSync(temp, target);
	} else {
		// Injected writer (tests): write through the mock directly — the
		// temp/rename dance is a real-fs atomicity concern, not contract.
		writeFile(target, text);
	}
	return target;
}

/** User-scope config, loaded once at module import. */
const userScope: MistralConfigLoadResult = loadUserMistralConfig();

/** Resolved (merged) effective config; rebuilt from the scopes on refresh. */
let effectiveConfig: MistralFileConfig | undefined = mergeMistralFileConfigs(userScope.value, undefined);

/** Test override for the effective config (mirrors setMistralTestFetch in extensions/mistral/api.ts). */
let testConfig: MistralFileConfig | undefined | null = undefined;

/**
 * The effective merged file config (user + project; project wins), with the
 * config-value protocol resolved over the credential-adjacent fields
 * (`agentId`, `endpoint.baseUrl`) against `process.env`. When a test override
 * is set via `setMistralConfigForTests`, that value is used instead.
 */
export function getEffectiveMistralConfig(): MistralFileConfig | undefined {
	if (testConfig === undefined) return resolveProtocolFields(effectiveConfig, process.env);
	if (testConfig === null) return undefined;
	return resolveProtocolFields(testConfig, process.env);
}

/**
 * Refresh the effective config: reload the user scope (surfacing its warning
 * via the provided `notify` when set) and add/refresh the project scope for
 * `cwd` (only when `projectTrusted`); the config-value protocol is applied
 * over the credential-adjacent fields when the effective config is built
 * (`getEffectiveMistralConfig`). `env` carries the user-scope chain
 * (default: process env). Returns the warning, if any.
 */
export function refreshMistralConfig(cwd: string, projectTrusted: boolean, notify?: (message: string, type?: "info" | "warning" | "error") => void, env: Record<string, string | undefined> = process.env): string | undefined {
	const user = loadUserMistralConfig(env);
	if (user.warning !== undefined) notify?.(user.warning, "warning");
	const project = projectTrusted ? loadProjectMistralConfig(cwd) : { value: undefined, path: undefined, warning: undefined };
	if (project.warning !== undefined) notify?.(project.warning, "warning");
	effectiveConfig = mergeMistralFileConfigs(user.value, project.value);
	return user.warning ?? project.warning;
}

/**
 * Override the effective config for tests: `undefined` restores the merged
 * scopes (user + project as loaded); `null` forces "no file present" —
 * environment variables only; a config object is used as the effective file
 * config. Mirrors the setMistralTestFetch pattern in extensions/mistral/api.ts.
 */
export function setMistralConfigForTests(config: MistralFileConfig | null | undefined): void {
	testConfig = config;
}

// =============================================================================
// Resolved endpoint values (behavioral)
// =============================================================================

/**
 * The effective endpoint settings. `MISTRAL_REGION` applies only when no JSON
 * file sets `region`; region defaults to `"global"`, `baseUrl` to undefined.
 * Pure over the given inputs.
 */
export function getEffectiveEndpoint(
	env: Record<string, string | undefined> | undefined = process.env,
	fileConfig: MistralFileConfig | undefined = getEffectiveMistralConfig(),
): { region: MistralRegion; baseUrl: string | undefined } {
	const jsonRegion = fileConfig?.endpoint?.region;
	if (jsonRegion !== undefined) {
		return { region: jsonRegion, baseUrl: fileConfig?.endpoint?.baseUrl };
	}
	const envRegion = env?.MISTRAL_REGION ?? process.env.MISTRAL_REGION;
	if (envRegion === "eu" || envRegion === "us" || envRegion === "global") {
		return { region: envRegion, baseUrl: fileConfig?.endpoint?.baseUrl };
	}
	return { region: "global", baseUrl: fileConfig?.endpoint?.baseUrl };
}

/**
 * Regional chat-completions base URLs; each already includes the `/v1`
 * suffix, so the fallback needs no path joining.
 *
 * Decisions: ADR 0012 — Selectable region endpoint with per-family routing.
 */
export const MISTRAL_REGION_BASE_URLS: Record<MistralRegion, string> = {
	global: "https://api.mistral.ai/v1",
	eu: "https://api.eu.mistral.ai/v1",
	us: "https://api.us.mistral.ai/v1",
};

/**
 * Resolve the base URL a regional request should use:
 * `baseUrlOverride` wins when set (non-empty), then the endpoint section's
 * explicit `baseUrl` (non-empty after trim), then the region's mapped URL.
 * Pure; prefer computing from `getEffectiveEndpoint()`'s shape so call sites
 * read `resolveMistralRegionBaseUrl(getEffectiveEndpoint())`. When the
 * endpoint defaults (region `"global"`, no `baseUrl`), this returns the
 * global URL.
 *
 * Decisions: ADR 0012 — Selectable region endpoint with per-family routing.
 */
export function resolveMistralRegionBaseUrl(
	endpoint: { region: MistralRegion; baseUrl: string | undefined },
	baseUrlOverride?: string | undefined,
): string {
	if (baseUrlOverride !== undefined && baseUrlOverride.trim().length > 0) return baseUrlOverride;
	if (endpoint.baseUrl !== undefined && endpoint.baseUrl.trim().length > 0) return endpoint.baseUrl;
	return MISTRAL_REGION_BASE_URLS[endpoint.region];
}

/** Whether a string value uses the config-value protocol (leading `!`, `$`, `${`). */
function usesProtocol(value: string): boolean {
	return value.startsWith("!") || value.includes("$");
}

/**
 * Apply the config-value protocol to the credential-adjacent fields
 * (`agentId`, `endpoint.baseUrl`) against process.env. Resolution failures
 * (unset referenced env var, failed command) leave the field unset, never
 * throw, and are never logged.
 */
function applyProtocol(config: MistralFileConfig, env: Record<string, string | undefined> | undefined): MistralFileConfig {
	const resolved: MistralFileConfig = { ...config };
	if (resolved.agentId !== undefined && usesProtocol(resolved.agentId)) {
		resolved.agentId = resolveConfigValueProtocol(resolved.agentId, env) ?? undefined;
	}
	if (resolved.endpoint?.baseUrl !== undefined && usesProtocol(resolved.endpoint.baseUrl)) {
		resolved.endpoint = {
			...resolved.endpoint,
			baseUrl: resolveConfigValueProtocol(resolved.endpoint.baseUrl, env) ?? undefined,
		};
	}
	return resolved;
}

/**
 * Resolve the config-value protocol over the given file config's
 * credential-adjacent fields (`agentId`, `endpoint.baseUrl`) against the
 * given env. Pure; never logs resolved values.
 */
export function resolveProtocolFields(
	config: MistralFileConfig | undefined,
	env: Record<string, string | undefined> | undefined = process.env,
): MistralFileConfig | undefined {
	if (config === undefined) return undefined;
	return applyProtocol(config, env);
}

// =============================================================================
// Resolved rag.streaming (behavioral)
// =============================================================================

/**
 * The effective RAG-query streaming toggle: whether
 * `mistral_document_query` runs over the native streaming chat-completions
 * path (default) or the legacy one-shot request. Precedence, highest wins:
 * `rag.streaming` (project > user via the merged file config) >
 * `knowledge.streaming` (project > user) > `MISTRAL_RAG_STREAMING` env var >
 * default `true`. The `rag` section wins over the broader `knowledge`
 * section so a knowledge-wide setting can be overridden per RAG; the env
 * var applies only when neither JSON key is set.
 * Pure over the given inputs; never logs.
 *
 * Decisions: ADR 0015 — Streaming RAG document query; ADR 0010 —
 * Configuration via mistral-native.json aligned to the pi ecosystem
 * convention.
 */
export function getEffectiveRagStreaming(
	env: Record<string, string | undefined> | undefined = process.env,
	fileConfig: MistralFileConfig | undefined = getEffectiveMistralConfig(),
): boolean {
	const ragStreaming = fileConfig?.rag?.streaming;
	if (ragStreaming !== undefined) return ragStreaming;
	const knowledgeStreaming = fileConfig?.knowledge?.streaming;
	if (knowledgeStreaming !== undefined) return knowledgeStreaming;
	const envValue = env?.MISTRAL_RAG_STREAMING ?? process.env.MISTRAL_RAG_STREAMING;
	if (envValue === "false" || envValue === "0" || envValue === "off" || envValue === "no") {
		return false;
	}
	if (envValue === "true" || envValue === "1" || envValue === "on" || envValue === "yes") {
		return true;
	}
	return true;
}

// =============================================================================
// Resolved knowledge.searchModel (behavioral)
// =============================================================================

/**
 * The effective search model for the web-search and code-interpreter tools' Conversations
 * calls: `knowledge.searchModel` from the merged file config (project >
 * user via getEffectiveMistralConfig), else DEFAULT_SEARCH_MODEL
 * ("mistral-small-latest"). Config-file only in this wave — there is no
 * env var; warn-on-unknown model ids happens at use time (the tool's
 * 3004-friendly error), not here. Pure over the given inputs; never logs.
 *
 * ADR 0018 — Web search as a Conversations-backed tool.
 */
export function getEffectiveSearchModel(
	fileConfig: MistralFileConfig | undefined = getEffectiveMistralConfig(),
): string {
	return fileConfig?.knowledge?.searchModel ?? DEFAULT_SEARCH_MODEL;
}

// =============================================================================
// Resolved retry policy (behavioral)
// =============================================================================

/** Built-in retry defaults, mirrored from extensions/mistral/retry.ts (no cycle: config is below retry's call sites). */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

/**
 * The effective retry policy of the chat stream and the tool fetch paths:
 * per-key fallback from the merged file config's `retry` section (project
 * > user via getEffectiveMistralConfig) to the built-in defaults — 3
 * retries, a 1000ms base, a 30000ms ceiling. Config-file only: there is no
 * env-var layer for these keys. Pure over the given inputs; never logs.
 *
 * ADR 0025 — Staggered retry with configurable backoff
 */
export function getEffectiveRetryPolicy(
	fileConfig: MistralFileConfig | undefined = getEffectiveMistralConfig(),
): { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } {
	return {
		maxAttempts: fileConfig?.retry?.maxAttempts ?? 3,
		baseDelayMs: fileConfig?.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
		maxDelayMs: fileConfig?.retry?.maxDelayMs ?? 30000,
	};
}
