/**
 * The `/mistral` command family: show, set, test.
 *
 * - Bare `/mistral`: status card with every behavioral key's effective value
 *   and its provenance (project file / user file / env / default / unset).
 * - `/mistral set <key> <value>`: user-scope-only atomic write-then-verify.
 * - `/mistral test`: live GET /v1/models with a named failing step and fix.
 *
 * Invariants: fresh reads via the pure loaders at invocation time
 * (never the session_start snapshot or the test override); the project scope
 * is read-only for commands; no speculative file creation; secrets are
 * never rendered (auth shows the source label only); output rides
 * ctx.ui.notify — TUI and RPC render it, print/json modes are silent by
 * pi's own contract (no ui context bound there).
 *
 * ADR 0016 — /mistral command family: show, set, test
 */

import {
	loadProjectMistralConfig,
	loadUserMistralConfig,
	mergeMistralFileConfigs,
	resolveProtocolFields,
	refreshMistralConfig,
	userConfigPaths,
	validateMistralFileConfig,
	getEffectiveEndpoint,
	getEffectiveRagStreaming,
	resolveMistralRegionBaseUrl,
} from "./config.js";
import { parseServerToolsConfig, unsupportedChatCompletionsServerTools } from "./server-tools.js";
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { MistralFileConfig, MistralRegion } from "./config.js";
import { DEFAULT_SEARCH_MODEL } from "./config.js";
import { connectorToolsEnabled } from "../tools/loader.js";


/** pi's AutocompleteItem shape (structural; no pi-tui import). */
interface AutocompleteItemLike {
	value: string;
	label: string;
	description?: string;
}

/** Structural type over pi's ExtensionAPI surface the registration uses. */
interface CommandAPI {
	registerCommand(name: string, options: {
		description?: string;
		getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItemLike[] | null | Promise<AutocompleteItemLike[] | null>;
		handler: (args: string, ctx: CommandContext) => Promise<void>;
	}): void;
}

/** Structural type over pi's ExtensionCommandContext (the parts we use). */
export interface CommandContext {
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	hasUI: boolean;
	mode: string;
	cwd: string;
	isProjectTrusted(): boolean;
	modelRegistry: {
		getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
	};
}

/**
 * The keys `/mistral set` accepts: every documented single-string
 * key. `models.rateCard` (nested object array) is deliberately absent — its
 * Usage error points at the file for hand-editing. Unknown keys produce the
 * same Usage error, so users discover the full documented surface.
 *
 * ADR 0016 — /mistral command family: show, set, test
 */
const SET_KEY_KINDS = ["boolean", "string", "list", "region"] as const;
type SetKeyKind = (typeof SET_KEY_KINDS)[number];

interface SetKeySpec {
	kind: SetKeyKind;
	description: string;
}

const SET_KEYS: Record<string, SetKeySpec> = {
	"serverTools": { kind: "list", description: "Enabled server-side tools (comma-separated; empty clears)" },
	"connectors": { kind: "list", description: "Enabled connector ids/names (comma-separated; empty clears)" },
	"agentId": { kind: "string", description: "Agent id (config-value protocol allowed)" },
	"endpoint.region": { kind: "region", description: "API region: global | eu | us" },
	"endpoint.baseUrl": { kind: "string", description: "Explicit chat/catalog base URL (config-value protocol allowed)" },
	"connectorTools.enabled": { kind: "boolean", description: "Client-side connector tools loader on/off" },
	"connectorTools.autoLoad": { kind: "list", description: "Connectors auto-loaded at session start (comma-separated)" },
	"models.fallThrough": { kind: "boolean", description: "Unpriced models fall through to catch-all rates" },
	"knowledge.streaming": { kind: "boolean", description: "Knowledge tool streaming" },
	"knowledge.searchModel": { kind: "string", description: "Web search model for the mistral_web_search tools" },
	"rag.streaming": { kind: "boolean", description: "RAG query streaming" },
	"rag.defaultLibraryId": { kind: "string", description: "Default library for RAG queries" },
	"ocr.defaultModel": { kind: "string", description: "Default OCR model" },
};

/** Split a comma-separated (optionally space-separated) list value. */
function splitListValue(value: string): string[] {
	const byComma = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
	if (byComma.length > 0) return byComma;
	return value.split(/\s+/).map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Parse a boolean set-value; undefined when not recognizable. */
function parseBooleanValue(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "on", "yes"].includes(normalized)) return true;
	if (["false", "0", "off", "no"].includes(normalized)) return false;
	return undefined;
}

/** Parse a region set-value; undefined when not one of global|eu|us. */
function parseRegionValue(value: string): MistralRegion | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "global" || normalized === "eu" || normalized === "us") return normalized;
	return undefined;
}

/** Where a provenance check found a value. */
type SourceLabel =
	| { source: "project file"; path: string }
	| { source: "user file"; path: string }
	| { source: "env"; variable: string }
	| { source: "default" }
	| { source: "unset" };

/** Render a config value for display: arrays as comma lists, others as-is. */
function describeValue(value: unknown): string {
	if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "(empty list)";
	return String(value);
}

/**
 * The display text when NO layer sets a key: effective defaults for the
 * keys that have one (connectorTools.enabled true, rag.streaming true,
 * region global via the endpoint mapping), otherwise `unset`.
 */
function defaultDisplayFor(key: string, merged: MistralFileConfig | undefined, env: Record<string, string | undefined>): string {
	if (key === "endpoint.region") return getEffectiveEndpoint(env, merged).region;
	if (key === "connectorTools.enabled") return String(connectorToolsEnabled(env, merged));
	if (key === "rag.streaming" || key === "knowledge.streaming") return String(getEffectiveRagStreaming(env, merged));
	if (key === "knowledge.searchModel") return merged?.knowledge?.searchModel ?? DEFAULT_SEARCH_MODEL;
	return "unset";
}

/** Render a SourceLabel as a human string for the status card. */
function describeSource(label: SourceLabel): string {
	switch (label.source) {
		case "project file": return `project file ${label.path}`;
		case "user file": return `user file ${label.path}`;
		case "env": return `env ${label.variable}`;
		case "default": return "default";
		case "unset": return "unset";
	}
}

/** A value with its provenance. */
interface SourcedValue {
	value: string;
	label: SourceLabel;
}

/** Look up a dotted key in a MistralFileConfig (undefined when absent). */
function fileValue(config: MistralFileConfig | undefined, key: string): unknown {
	if (config === undefined) return undefined;
	if (key.includes(".")) {
		const [section = "", field = ""] = key.split(".");
		const sectionValue = (config as Record<string, unknown>)[section];
		if (typeof sectionValue !== "object" || sectionValue === null) return undefined;
		return (sectionValue as Record<string, unknown>)[field];
	}
	return (config as Record<string, unknown>)[key];
}

/**
 * The scopes freshly read at invocation time (file-as-truth: never the
 * session_start snapshot, never the test override).
 *
 * ADR 0016 — /mistral command family: show, set, test
 */
export interface MistralScopes {
	user: { value: MistralFileConfig | undefined; path: string | undefined; warning: string | undefined };
	project: { value: MistralFileConfig | undefined; path: string | undefined; warning: string | undefined };
}

/**
 * Fresh scope load (never the session_start snapshot, never the test
 * override): user scope always; project scope only when trusted. Pure
 * loaders, side-effect-free per call.
 */
export function loadMistralScopes(
	cwd: string,
	projectTrusted: boolean,
	env: Record<string, string | undefined> = process.env,
): MistralScopes {
	const user = loadUserMistralConfig(env);
	const project = projectTrusted ? loadProjectMistralConfig(cwd) : { value: undefined, path: undefined, warning: undefined };
	return { user, project };
}

/**
 * Provenance for one dotted config key, precedence project file > user file >
 * env. `envVariable` undefined means the key has no env layer (label `unset`
 * when no file sets it). Env values are read from the given env bag and
 * count ONLY when the effective layer's resolver would honor them (e.g.
 * MISTRAL_REGION=EU is ignored by getEffectiveEndpoint, so it must not be
 * displayed as the effective region) — `envHonored` is that per-key check
 * (undefined = every non-empty value is honored).
 */
function resolveProvenance(
	scopes: MistralScopes,
	key: string,
	envVariable: string | undefined,
	env: Record<string, string | undefined>,
	envHonored: ((value: string) => boolean) | undefined,
): SourcedValue | undefined {
	const projectValue = fileValue(scopes.project.value, key);
	if (projectValue !== undefined) {
		return { value: projectValue as string, label: { source: "project file", path: scopes.project.path ?? "<project>" } };
	}
	const userValue = fileValue(scopes.user.value, key);
	if (userValue !== undefined) {
		return { value: userValue as string, label: { source: "user file", path: scopes.user.path ?? "<user>" } };
	}
	if (envVariable !== undefined) {
		const envValue = env[envVariable];
		if (envValue !== undefined && envValue.trim().length > 0 && (envHonored === undefined || envHonored(envValue))) {
			return { value: envValue, label: { source: "env", variable: envVariable } };
		}
	}
	return undefined;
}

/** Whether getEffectiveEndpoint honors a MISTRAL_REGION value — exact,
 * case-sensitive match (getEffectiveEndpoint compares `===` with the literal
 * region ids, no trimming or case folding). */
function regionEnvHonored(value: string): boolean {
	return ["eu", "us", "global"].includes(value.trim());
}

/** Whether getEffectiveRagStreaming honors a MISTRAL_RAG_STREAMING value. */
function ragStreamingEnvHonored(value: string): boolean {
	return ["false", "0", "off", "no", "true", "1", "on", "yes"].includes(value.trim().toLowerCase());
}

/**
 * The status card (bare `/mistral`): one line per behavioral key with its
 * effective value and provenance, plus the auth source label (never the
 * key), the effective endpoint, the config chain, and any scope warning.
 * Env = process env (a documented limitation: provider-scoped env is
 * invisible here, same caveat as the region notice).
 *
 * ADR 0016 — /mistral command family: show, set, test
 */
export function buildStatusCard(
	scopes: MistralScopes,
	authStatus: { configured: boolean; source?: string; label?: string } | undefined,
	projectTrusted: boolean,
	env: Record<string, string | undefined> = process.env,
): string {
	const lines: string[] = [];
	lines.push("Mistral configuration (mistral-native.json)");
	lines.push("");

	const merged = mergeMistralFileConfigs(scopes.user.value, scopes.project.value);
	// [key, display, env variable, env-honored check] — the check is set
	// only where the effective layer's resolver is stricter than "any
	// non-empty value" (region set, rag boolean words).
	const keyRows: Array<[string, string, string | undefined, ((value: string) => boolean) | undefined]> = [
		["serverTools", "Server-side tools", "MISTRAL_SERVER_TOOLS", undefined],
		["connectors", "Connectors", "MISTRAL_CONNECTORS", undefined],
		["agentId", "Agent id", "MISTRAL_AGENT_ID", undefined],
		["endpoint.region", "Region", "MISTRAL_REGION", regionEnvHonored],
		["endpoint.baseUrl", "Base URL", undefined, undefined],
		["connectorTools.enabled", "Connector tools", "MISTRAL_CONNECTOR_TOOLS", undefined],
		["connectorTools.autoLoad", "Connector auto-load", undefined, undefined],
		["models.fallThrough", "Rate-card fall-through", undefined, undefined],
		["knowledge.streaming", "Knowledge streaming", undefined, undefined],
		["knowledge.searchModel", "Web search model", undefined, undefined],
		["rag.streaming", "RAG streaming", "MISTRAL_RAG_STREAMING", ragStreamingEnvHonored],
		["rag.defaultLibraryId", "RAG default library", undefined, undefined],
		["ocr.defaultModel", "OCR model", undefined, undefined],
	];
	for (const [key, display, envVariable, envHonored] of keyRows) {
		const sourced = resolveProvenance(scopes, key, envVariable, env, envHonored);
		let valueText: string;
		let sourceText: string;
		if (sourced !== undefined) {
			valueText = describeValue(sourced.value);
			sourceText = describeSource(sourced.label);
		} else {
			valueText = defaultDisplayFor(key, merged, env);
			sourceText = sourced === undefined && valueText === "unset" ? "unset" : "default";
		}
		lines.push(`  ${display}: ${valueText}  [${sourceText}]`);
	}

	// Server tools the Chat Completions endpoint rejects are dropped from
	// requests with a warning; the card names them so the silent drop is
	// explainable from the status alone.
	const unsupportedServerTools = unsupportedChatCompletionsServerTools(parseServerToolsConfig(env, merged));
	if (unsupportedServerTools.length > 0) {
		lines.push(
			`  (${unsupportedServerTools.join(" and ")} do not run in chat completions — use the mistral_web_search tool for web search; see docs/server-tools.md)`,
		);
	}

	// Auth: source label only — the key value is never rendered.
	if (authStatus === undefined) {
		lines.push("  Auth: unknown");
	} else if (authStatus.configured) {
		lines.push(`  Auth: configured (${authStatus.label ?? authStatus.source ?? "unknown source"})`);
	} else {
		lines.push("  Auth: not configured — run /login mistral-native or set MISTRAL_API_KEY");
	}

	// Effective endpoint (region routing).
	const endpoint = getEffectiveEndpoint(env, merged);
	const endpointBase = endpoint.baseUrl ?? resolveMistralRegionBaseUrl(endpoint);
	lines.push(`  Effective chat endpoint: ${endpointBase}`);

	// The user-scope chain, marking the loaded file.
	lines.push("");
	const chain = userConfigPaths(env);
	if (chain.length > 0) {
		lines.push("Config chain (user scope, first existing wins):");
		for (const path of chain) {
			const marker = path === scopes.user.path ? " (loaded)" : "";
			lines.push(`  ${path}${marker}`);
		}
	}
	if (scopes.project.path !== undefined) {
		lines.push(`Project scope: ${scopes.project.path} (read-only for /mistral set)`);
	} else if (scopes.project.value === undefined) {
		lines.push(
			projectTrusted
				? "Project scope: none"
				: "Project scope: not loaded (project not trusted)",
		);
	}

	// Degraded-mode warnings from the loaders.
	for (const scope of [scopes.user, scopes.project]) {
		if (scope.warning !== undefined) lines.push(`Warning: ${scope.warning}`);
	}
	return lines.join("\n");
}

// =============================================================================
// /mistral set — user-scope-only atomic write-then-verify
// =============================================================================

/** Injectable fs seams for tests (defaults: real fs). */
export interface SetDeps {
	readFile?: (path: string) => string;
	writeFile?: (path: string, text: string) => void;
	fileExists?: (path: string) => boolean;
}

/**
 * The write target: the first existing file in the user chain,
 * else the chain head (`userConfigPaths` pushes the PI agent dir only when
 * `PI_CODING_AGENT_DIR` is set, so the head is the highest-precedence
 * candidate in both env combinations — pinned by tests).
 *
 * ADR 0016 — /mistral command family: show, set, test
 */
export function setUserConfigTargetPath(
	env: Record<string, string | undefined>,
	fileExists: (path: string) => boolean = realFileExists,
): string {
	const paths = userConfigPaths(env);
	for (const path of paths) {
		if (fileExists(path)) return path;
	}
	return paths[0]!;
}

/** Real fs existence probe. */
function realFileExists(path: string): boolean {
	try {
		readFileSync(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Apply one dotted key to a plain-object config root (section-aware merge). */
function applyKeyToRoot(root: Record<string, unknown>, key: string, value: unknown): void {
	if (key.includes(".")) {
		const [section = "", field = ""] = key.split(".");
		const existing = typeof root[section] === "object" && root[section] !== null && !Array.isArray(root[section])
			? (root[section] as Record<string, unknown>)
			: {};
		root[section] = { ...existing, [field]: value };
	} else {
		root[key] = value;
	}
}

/**
 * Perform the user-scope write for one key. Steps:
 * 1. Resolve the target (first existing file, else chain head).
 * 2. Parse any existing content; refuse on invalid JSON or a non-object root
 *    (never merge into a broken file — the error says to hand-edit it).
 * 3. Validate the EXISTING file first via validateMistralFileConfig; refuse
 *    when it does not validate (same hand-edit message).
 * 4. Merge the key in, validate the merged whole, then atomically write
 *    (temp sibling + rename over the target — same directory, so the same
 *    filesystem; never truncates the target first).
 * Returns the written target path. Throws Error with a descriptive message
 * on any refusal — the caller renders it; nothing is written on refusal.
 *
 * ADR 0016 — /mistral command family: show, set, test
 */
export function setUserConfigKey(
	key: string,
	value: string,
	env: Record<string, string | undefined> = process.env,
	deps: SetDeps = {},
): string {
	const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const writeFile = deps.writeFile;
	const fileExists = deps.fileExists ?? realFileExists;
	const target = setUserConfigTargetPath(env, fileExists);
	let root: Record<string, unknown> = {};
	if (fileExists(target)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFile(target)) as unknown;
		} catch (error) {
			throw new Error(
				`refusing to set "${key}": ${target} is not valid JSON (${(error as Error).message}); fix the file by hand`,
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`refusing to set "${key}": ${target} must contain a JSON object; fix the file by hand`);
		}
		const existing = validateMistralFileConfig(parsed, target);
		if (existing.error !== undefined || existing.config === undefined) {
			throw new Error(`refusing to set "${key}": ${existing.error ?? `${target} did not validate`}; fix the file by hand`);
		}
		root = parsed as Record<string, unknown>;
	}
	const spec = SET_KEYS[key];
	if (spec === undefined) {
		throw new Error(usageMessage(key));
	}
	let typedValue: unknown;
	if (spec.kind === "boolean") {
		const parsed = parseBooleanValue(value);
		if (parsed === undefined) {
			throw new Error(`invalid boolean for "${key}": ${JSON.stringify(value)}; use true or false`);
		}
		typedValue = parsed;
	} else if (spec.kind === "region") {
		const parsed = parseRegionValue(value);
		if (parsed === undefined) {
			throw new Error(`invalid region for "endpoint.region": ${JSON.stringify(value)}; must be global, eu or us`);
		}
		typedValue = parsed;
	} else if (spec.kind === "list") {
		typedValue = splitListValue(value);
	} else {
		if (value.trim().length === 0) {
			throw new Error(`invalid value for "${key}": empty; unset it by editing the file`);
		}
		typedValue = value;
	}
	applyKeyToRoot(root, key, typedValue);
	const mergedValidation = validateMistralFileConfig(root, target);
	if (mergedValidation.error !== undefined || mergedValidation.config === undefined) {
		throw new Error(`refusing to write: ${mergedValidation.error ?? `${target} did not validate`}`);
	}
	const text = `${JSON.stringify(root, null, "\t")}\n`;
	if (writeFile !== undefined) {
		// Injected writer (tests): write through the mock — the atomic
		// temp/rename dance is a real-fs concern, not contract.
		writeFile(target, text);
	} else {
		// Real write, atomic: parent dirs, temp sibling in the SAME directory
		// (same filesystem), then rename over the target — rename never
		// truncates the target first, so a failed write leaves the existing
		// file intact. Durability: closeSync flushes the data to the OS; a
		// crash after rename may still lose the write (no fsync — same
		// accepted trade-off as the login region write, config.ts). A failed
		// rename removes the temp sibling rather than leaking it.
		mkdirSync(dirname(target), { recursive: true });
		const temp = `${target}.tmp-${process.pid}`;
		writeFileSync(temp, text);
		try {
			renameSync(temp, target);
		} catch (error) {
			try {
				unlinkSync(temp);
			} catch {
				// best effort cleanup; the original error matters more
			}
			throw error;
		}
	}
	return target;
}

/** The Usage error listing all settable keys (and the hand-edit pointer). */
function usageMessage(offender?: string): string {
	const keys = Object.keys(SET_KEYS).sort();
	const lines = [
		offender !== undefined ? `unknown or unsupported key: ${JSON.stringify(offender)}` : "missing key",
		"Usage: /mistral set <key> <value>",
		`Settable keys: ${keys.join(", ")}`,
		"models.rateCard is not settable here (nested object) — hand-edit mistral-native.json.",
	];
	return lines.join("\n");
}

/**
 * Write-then-verify: after a successful write, re-read the chain
 * fresh and confirm the key took; report shadowing when a PROJECT value
 * outranks what was just written (env never outranks JSON). Pure
 * given the scopes; compares raw stored strings like-for-like (the resolved
 * protocol value is never compared or displayed).
 *
 * ADR 0010 — Configuration via mistral-native.json
 * ADR 0016 — /mistral command family: show, set, test
 */
export function verifySetResult(
	scopes: MistralScopes,
	key: string,
): { ok: true; message: string } | { ok: false; message: string } {
	const merged = mergeMistralFileConfigs(scopes.user.value, scopes.project.value);
	const writtenValue = fileValue(scopes.user.value, key);
	const effectiveValue = fileValue(merged, key);
	if (writtenValue === undefined) {
		return { ok: false, message: `the written key "${key}" did not take — re-read shows it unset; check the config chain` };
	}
	const effectiveText = describeValue(effectiveValue ?? writtenValue);
	let message = `Saved: ${key} = ${describeValue(writtenValue)} (user scope)`;
	if (effectiveValue !== writtenValue) {
		message += `\nNote: a project-scope value shadows it in this project; effective here: ${effectiveText}`;
	}
	return { ok: true, message };
}

// =============================================================================
// /mistral test — live GET /v1/models with a named failing step
// =============================================================================

/** Injectable fetch seam for tests. */
export type TestFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** The outcome of /mistral test; `step` names the failing layer. */
export type MistralTestResult =
	| { ok: true; message: string }
	| { ok: false; step: "auth" | "network" | "http"; message: string; fix: string };

/**
 * Live connectivity check: GET <chat endpoint>/models with the
 * session-resolved API key. Failures name their step and carry a fix hint;
 * the key value itself never appears in any message.
 *
 * ADR 0016 — /mistral command family: show, set, test
 */
export async function runMistralTest(
	baseUrl: string,
	apiKey: string | undefined,
	fetchImpl: TestFetchFn,
): Promise<MistralTestResult> {
	if (apiKey === undefined || apiKey.length === 0) {
		return {
			ok: false,
			step: "auth",
			message: "no API key available",
			fix: "run /login mistral-native (or set MISTRAL_API_KEY), then retry",
		};
	}
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}/models`, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		});
	} catch (error) {
		return {
			ok: false,
			step: "network",
			message: `could not reach ${baseUrl}/models: ${(error as Error).message}`,
			fix: "check network/proxy, and endpoint.baseUrl or endpoint.region if set",
		};
	}
	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			step: "auth",
			message: `HTTP ${response.status} from ${baseUrl}/models: the API key was rejected`,
			fix: "the key is invalid or revoked — run /login mistral-native with a fresh key (create one at https://console.mistral.ai/api-keys)",
		};
	}
	if (!response.ok) {
		return {
			ok: false,
			step: "http",
			message: `HTTP ${response.status} from ${baseUrl}/models`,
			fix: "the endpoint answered but not with a model list; check endpoint.baseUrl/region and Mistral's status page",
		};
	}
	try {
		const body = (await response.json()) as { data?: unknown[] };
		const count = Array.isArray(body.data) ? body.data.length : 0;
		return { ok: true, message: `reachable: ${baseUrl}/models returned ${count} model${count === 1 ? "" : "s"}` };
	} catch (error) {
		return {
			ok: false,
			step: "http",
			message: `${baseUrl}/models answered but the body was not JSON (${(error as Error).message})`,
			fix: "check endpoint.baseUrl — a gateway may be answering instead of the Mistral API",
		};
	}
}

// =============================================================================
// Registration (one hook from extensions/mistral.ts)
// =============================================================================

/**
 * Register the `/mistral` command family. Structural pi types on purpose:
 * the extension entry imports this without a type cycle.
 */
export function registerMistralCommands(pi: CommandAPI): void {
	pi.registerCommand("mistral", {
		description: "Show Mistral config status, set a key (user scope), or test connectivity",
		getArgumentCompletions: (prefix: string) => mistralArgumentCompletions(prefix),
		handler: async (args: string, ctx: CommandContext) => handleMistralCommand(args, ctx),
	});
}

/** Tab completion: subcommand first, then set keys, then value hints. */
export function mistralArgumentCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> {
	const subcommands = [
		{ value: "set", label: "set", description: "Write one config key to the user-scope file" },
		{ value: "test", label: "test", description: "Live GET /v1/models connectivity check" },
	];
	// Split the RAW prefix without filtering empties: "set " splits to
	// ["set", ""], which opens key completion; the empty trailing part of
	// "set endpoint.region " splits to three parts (value position, no offers).
	const parts = prefix.split(/\s+/);
	if (parts.length <= 1) {
		const typed = parts[0] ?? "";
		return subcommands.filter((item) => item.value.startsWith(typed));
	}
	// "set <partial-key>": offer the settable keys (the key descriptions
	// double as value hints; free-text values get no completion).
	if (parts[0] === "set" && parts.length === 2) {
		const typedKey = parts[1] ?? "";
		return Object.keys(SET_KEYS)
			.filter((key) => key.startsWith(typedKey))
			.sort()
			.map((key) => ({ value: key, label: key, description: SET_KEYS[key]!.description }));
	}
	return [];
}

/**
 * Injectable seams so tests run the real handler against a controlled env
 * and fs without touching the user's live config (defaults: process env).
 */
export interface HandlerDeps {
	env?: Record<string, string | undefined>;
}

/** Dispatch: bare → status card, set → write-then-verify, test → live check. */
export async function handleMistralCommand(args: string, ctx: CommandContext, deps: HandlerDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const trimmed = args.trim();
	if (trimmed.length === 0 || trimmed === "show" || trimmed === "status") {
		const scopes = loadMistralScopes(ctx.cwd, ctx.isProjectTrusted(), env);
		const authStatus = safeAuthStatus(ctx);
		const card = buildStatusCard(scopes, authStatus, ctx.isProjectTrusted(), env);
		ctx.ui.notify(card, "info");
		return;
	}
	const [sub, ...rest] = trimmed.split(/\s+/);
	if (sub === "set") {
		await handleSet(rest.join(" "), ctx, env);
		return;
	}
	if (sub === "test") {
		await handleTest(ctx, env);
		return;
	}
	ctx.ui.notify(
		`unknown subcommand: ${JSON.stringify(sub)}\nUsage: /mistral [set <key> <value> | test]`,
		"error",
	);
}

/** getProviderAuthStatus wrapped so a registry hiccup degrades, not throws. */
function safeAuthStatus(ctx: CommandContext): { configured: boolean; source?: string; label?: string } | undefined {
	try {
		return ctx.modelRegistry.getProviderAuthStatus("mistral-native");
	} catch {
		return undefined;
	}
}

/** `/mistral set <key> <value>`: user-scope atomic write-then-verify. */
async function handleSet(rest: string, ctx: CommandContext, env: Record<string, string | undefined>): Promise<void> {
	const parts = rest.split(/\s+/).filter((part) => part.length > 0);
	if (parts.length === 0 || parts[0] === undefined) {
		ctx.ui.notify(usageMessage(), "error");
		return;
	}
	const [key, ...valueParts] = parts;
	// A list key with NO value means "clear the list" (the key description
	// says so) — only list keys accept the empty form; every other key
	// needs a value (its empty form is a usage error).
	let value: string;
	if (valueParts.length === 0) {
		if (parts[0] !== undefined && SET_KEYS[parts[0]]?.kind !== "list") {
			ctx.ui.notify(`missing value for "${parts[0]}"; Usage: /mistral set <key> <value>`, "error");
			return;
		}
		value = "";
	} else {
		value = valueParts.join(" ");
	}
	let target: string;
	try {
		target = setUserConfigKey(key!, value, env);
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
		return;
	}
	// Sync the live session's cached config (the sanctioned cached-path
	// touch; only a successful set refreshes).
	refreshMistralConfig(ctx.cwd, ctx.isProjectTrusted());
	const scopes = loadMistralScopes(ctx.cwd, ctx.isProjectTrusted(), env);
	const verify = verifySetResult(scopes, key!);
	ctx.ui.notify(verify.message + `\nwritten to: ${target}`, verify.ok ? "info" : "error");
}

/** `/mistral test`: resolve the session auth + endpoint fresh, then probe. */
async function handleTest(ctx: CommandContext, env: Record<string, string | undefined>): Promise<void> {
	const scopes = loadMistralScopes(ctx.cwd, ctx.isProjectTrusted(), env);
	// Protocol-resolved merge — the probe must hit the SAME endpoint the
	// chat stream posts to (raw `$VAR`/`!cmd` strings are not URLs).
	const merged = resolveProtocolFields(
		mergeMistralFileConfigs(scopes.user.value, scopes.project.value),
		env,
	);
	const endpoint = getEffectiveEndpoint(env, merged);
	const baseUrl = endpoint.baseUrl ?? resolveMistralRegionBaseUrl(endpoint);
	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKeyForProvider("mistral-native");
	} catch {
		apiKey = undefined;
	}
	const result = await runMistralTest(baseUrl, apiKey, (url, init) => fetch(url, init));
	if (result.ok) {
		ctx.ui.notify(`Mistral test: ${result.message}`, "info");
	} else {
		ctx.ui.notify(`Mistral test failed at step "${result.step}": ${result.message}\nFix: ${result.fix}`, "error");
	}
}
