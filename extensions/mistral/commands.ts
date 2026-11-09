/**
 * The `/mistral` command family: show, set, test.
 *
 * - Bare `/mistral`: status card with every behavioral key's effective value
 *   and its provenance (project file / user file / env / default / unset).
 * - `/mistral set [--project] <key> <value>`: atomic write-then-verify into
 *   the user scope (default) or the project scope (explicit `--project`,
 *   trusted projects only). List-kind keys accept `+entry` / `-entry`
 *   mutation; a bare list key clears; a plain comma list replaces.
 * - `/mistral test`: live GET /v1/models with a named failing step and fix.
 *
 * Invariants: fresh reads via the pure loaders at invocation time
 * (never the session_start snapshot or the test override); no speculative
 * file creation (the user file is created by the first set, the project
 * file by an explicit `set --project` in a trusted project); secrets are
 * never rendered (auth shows the source label only); output rides
 * ctx.ui.notify — TUI and RPC render it, print/json modes are silent by
 * pi's own contract (no ui context bound there).
 *
 * Completion: pi applies a selected item by replacing the ENTIRE raw
 * argument string after the command name with `item.value`, so items carry
 * the full completed argument text (`set serverTools`), never the bare
 * last token. Explicit Tab on a slash line containing a space issues a
 * forced request that skips `registerCommand`'s argument completions
 * (pi-tui answers forced requests from path completion only), so the
 * autocomplete-provider wrapper registered once per ui context on
 * session_start serves `/mistral` argument lines for forced requests too
 * and delegates everything else to the wrapped provider; a fresh ui
 * context (pi clears its wrapper list on session replacement) must
 * register again.
 *
 * ADR 0016 — /mistral command family: show, set, test
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */

import {
	loadProjectMistralConfig,
	loadUserMistralConfig,
	mergeMistralFileConfigs,
	resolveProtocolFields,
	refreshMistralConfig,
	userConfigPaths,
	projectConfigPath,
	validateMistralFileConfig,
	getEffectiveEndpoint,
	getEffectiveRagStreaming,
	resolveMistralRegionBaseUrl,
	KNOWN_CONFIG_SERVER_TOOLS,
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

/**
 * Structural type over pi's AutocompleteProvider surface (pi-tui's
 * `AutocompleteProvider`, the parts the wrapper forwards or overrides).
 * The extension must not import pi-tui — it is not a declared peer
 * dependency — so the wrapper is duck-typed; test/commands.test.ts drives
 * the REAL CombinedAutocompleteProvider against it to pin the contract.
 */
export interface AutocompleteProviderLike {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<{ items: AutocompleteItemLike[]; prefix: string } | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItemLike,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/** The session facts the completion and wrapper paths need, read FRESH at use. */
export interface CompletionSessionState {
	cwd: string;
	projectTrusted: boolean;
}

/** Structural type over pi's ExtensionContext (the parts the registration uses). */
interface SessionStartContext {
	cwd: string;
	isProjectTrusted(): boolean;
	ui: { addAutocompleteProvider(factory: (current: AutocompleteProviderLike) => AutocompleteProviderLike): void };
}

/** Structural type over pi's ExtensionAPI surface the registration uses. */
interface CommandAPI {
	registerCommand(name: string, options: {
		description?: string;
		getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItemLike[] | null | Promise<AutocompleteItemLike[] | null>;
		handler: (args: string, ctx: CommandContext) => Promise<void>;
	}): void;
	on(event: "session_start", handler: (event: unknown, ctx: SessionStartContext) => void): void;
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
	"serverTools": { kind: "list", description: "Enabled server-side tools (comma-separated; empty clears; +entry appends, -entry removes)" },
	"connectors": { kind: "list", description: "Enabled connector ids/names (comma-separated; empty clears; +entry appends, -entry removes)" },
	"agentId": { kind: "string", description: "Agent id (config-value protocol allowed)" },
	"endpoint.region": { kind: "region", description: "API region: global | eu | us" },
	"endpoint.baseUrl": { kind: "string", description: "Explicit chat/catalog base URL (config-value protocol allowed)" },
	"connectorTools.enabled": { kind: "boolean", description: "Client-side connector tools loader on/off" },
	"connectorTools.autoLoad": { kind: "list", description: "Connectors auto-loaded at session start (comma-separated; empty clears; +entry appends, -entry removes)" },
	"models.fallThrough": { kind: "boolean", description: "Unpriced models fall through to catch-all rates" },
	"knowledge.streaming": { kind: "boolean", description: "Knowledge tool streaming" },
	"knowledge.searchModel": { kind: "string", description: "Web search model for the web_search tool" },
	"rag.streaming": { kind: "boolean", description: "RAG query streaming" },
	"rag.defaultLibraryId": { kind: "string", description: "Default library for RAG queries" },
	"ocr.defaultModel": { kind: "string", description: "Default OCR model" },
};

/**
 * Split a comma-separated list value: parts are trimmed, empties dropped;
 * spaces are significant within an entry; a comma-only or whitespace-only
 * value yields the empty list.
 */
function splitListValue(value: string): string[] {
	return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
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
			`  (${unsupportedServerTools.join(" and ")} do not run in chat completions — use the web_search tool for web search; see https://mawoh.github.io/pi-mistral-native/reference/tools/)`,
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
		lines.push(`Project scope: ${scopes.project.path} (writable via /mistral set --project)`);
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
// /mistral set — scope-parameterized atomic write-then-verify
// =============================================================================

/** Injectable fs seams for tests (defaults: real fs). */
export interface SetDeps {
	readFile?: (path: string) => string;
	writeFile?: (path: string, text: string) => void;
	fileExists?: (path: string) => boolean;
}

/** The outcome of one set operation: what was written (or why it was not). */
export interface SetKeyOutcome {
	/** The file the write targeted (or would have targeted on a no-op). */
	target: string;
	/** Whether a file was written; false = no-op with a note. */
	wrote: boolean;
	/** Human note for no-ops and mixed mutations; undefined on a plain write. */
	note: string | undefined;
}

/** The write target: the first existing file in the user chain, else the chain head. */
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
 * The list entries currently stored in the target scope's own parsed root
 * (undefined when the key is unset or holds a non-array). The target file's
 * parsed root is the mutation base — the OTHER scope's list never mixes in.
 */
function currentListEntries(root: Record<string, unknown>, key: string): string[] | undefined {
	const value = rootKey(root, key);
	if (!Array.isArray(value)) return undefined;
	return value as string[];
}

/** Look up a dotted key in a raw JSON root (undefined when absent or non-scalar). */
function rootKey(root: Record<string, unknown>, key: string): unknown {
	if (key.includes(".")) {
		const [section = "", field = ""] = key.split(".");
		const sectionValue = root[section];
		if (typeof sectionValue !== "object" || sectionValue === null || Array.isArray(sectionValue)) return undefined;
		return (sectionValue as Record<string, unknown>)[field];
	}
	return root[key];
}

/**
 * Compute the +/- mutation of a list-kind key over the target's current
 * entries. Returns the outcome WITHOUT writing: a no-op (wrote false with a
 * note) when nothing changes, the new list and an optional skipped-entries
 * note when it does. `+` appends (dedup, order preserved, at the end); `-`
 * removes (removing from an unset list is a no-op: unset falls through to
 * env, `[]` suppresses it — never turn one into the other).
 */
function listMutationOutcome(
	key: string,
	value: string,
	current: string[] | undefined,
): { wrote: false; note: string } | { wrote: true; newList: string[]; note: string | undefined } {
	const sign = value.startsWith("-") ? "-" : "+";
	// The sign prefixes the whole value: "+a,+b" adds a and b. Entries split
	// after the sign is stripped — but a leading sign on a LATER entry (e.g.
	// "+a,+b") is a mistake, not a nested mutation: it is stripped too, so the
	// note never leaks a stray "+" into a stored entry.
	const entries = splitListValue(value.slice(1)).map((entry) => entry.replace(/^[+-]/, ""));
	if (entries.length === 0) {
		throw new Error(`invalid value for "${key}": "${sign}" needs at least one entry (e.g. ${sign}web_search)`);
	}
	if (sign === "+") {
		if (current === undefined) return { wrote: true, newList: entries, note: undefined };
		const appended: string[] = [];
		const skipped: string[] = [];
		for (const entry of entries) {
			if (current.includes(entry) || appended.includes(entry)) skipped.push(entry);
			else appended.push(entry);
		}
		if (appended.length === 0) {
			return { wrote: false, note: `nothing added: ${skipped.join(", ")} already in the list (${key} unchanged)` };
		}
		return {
			wrote: true,
			newList: [...current, ...appended],
			note: skipped.length > 0 ? `added ${appended.join(", ")}; skipped ${skipped.join(", ")} (already in the list)` : undefined,
		};
	}
	if (current === undefined) {
		return { wrote: false, note: `nothing removed: the list is unset (${key} unchanged)` };
	}
	const removed = current.filter((entry) => !entries.includes(entry));
	const removedCount = current.length - removed.length;
	if (removedCount === 0) {
		return { wrote: false, note: `nothing removed: ${entries.join(", ")} not in the list (${key} unchanged)` };
	}
	const skipped = entries.filter((entry) => !current.includes(entry));
	return {
		wrote: true,
		newList: removed,
		note: skipped.length > 0 ? `removed ${entries.filter((entry) => current.includes(entry)).join(", ")}; skipped ${skipped.join(", ")} (not in the list)` : undefined,
	};
}

/**
 * The shared write core for both scopes: parse the target file if present
 * (refuse invalid JSON / non-object root / a file that fails
 * validateMistralFileConfig — the error says to hand-edit it), compute the
 * typed value (list keys parse `+`/`-` mutation against the target's own
 * current list; +/- apply ONLY to list-kind keys), merge the key in,
 * validate the merged whole, then atomically write (temp sibling + rename
 * over the target — same directory, same filesystem; never truncates the
 * target first). A no-op mutation returns without writing. Throws Error
 * with a descriptive message on any refusal — the caller renders it;
 * nothing is written on refusal.
 *
 * ADR 0016 — /mistral command family: show, set, test
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */
function setConfigKeyAtTarget(
	target: string,
	key: string,
	value: string,
	deps: SetDeps,
): SetKeyOutcome {
	const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const writeFile = deps.writeFile;
	const fileExists = deps.fileExists ?? realFileExists;
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
	let note: string | undefined;
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
		if (value.startsWith("+") || value.startsWith("-")) {
			const mutation = listMutationOutcome(key, value, currentListEntries(root, key));
			if (!mutation.wrote) return { target, wrote: false, note: mutation.note };
			typedValue = mutation.newList;
			note = mutation.note;
		} else {
			typedValue = splitListValue(value);
		}
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
	return { target, wrote: true, note };
}

/**
 * Perform the user-scope write for one key. Target: the first existing
 * file in the user chain, else the chain head (`userConfigPaths` pushes the
 * PI agent dir only when `PI_CODING_AGENT_DIR` is set, so the head is the
 * highest-precedence candidate in both env combinations — pinned by tests).
 * Returns the outcome (target, wrote, note) — a no-op mutation wrote
 * nothing and carries a human note.
 *
 * ADR 0016 — /mistral command family: show, set, test
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */
export function setUserConfigKey(
	key: string,
	value: string,
	env: Record<string, string | undefined> = process.env,
	deps: SetDeps = {},
): SetKeyOutcome {
	const target = setUserConfigTargetPath(env, deps.fileExists ?? realFileExists);
	return setConfigKeyAtTarget(target, key, value, deps);
}

/**
 * Perform the project-scope write for one key: `<cwd>/.pi/mistral-native.json`
 * (`projectConfigPath`), same validate-then-atomic-write core as the user
 * scope. The caller is responsible for the trust gate (pi loads the project
 * scope only for trusted projects; the handler refuses before calling).
 *
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */
export function setProjectConfigKey(cwd: string, key: string, value: string, deps: SetDeps = {}): SetKeyOutcome {
	return setConfigKeyAtTarget(projectConfigPath(cwd), key, value, deps);
}

/** The Usage error listing all settable keys (and the hand-edit pointer). */
function usageMessage(offender?: string): string {
	const keys = Object.keys(SET_KEYS).sort();
	const lines = [
		offender !== undefined ? `unknown or unsupported key: ${JSON.stringify(offender)}` : "missing key",
		"Usage: /mistral set [--project] <key> <value>",
		`Settable keys: ${keys.join(", ")}`,
		"models.rateCard is not settable here (nested object) — hand-edit mistral-native.json.",
	];
	return lines.join("\n");
}

/**
 * Write-then-verify: after a successful write, re-read the chain fresh and
 * confirm the key took in the WRITTEN scope; report shadowing when the
 * OTHER scope outranks what was just written (env never outranks JSON).
 * Pure given the scopes; values compare by rendered text (describeValue),
 * so content-equal lists do not report as shadow/override (the resolved
 * protocol value is never compared or displayed).
 *
 * ADR 0010 — Configuration via mistral-native.json
 * ADR 0016 — /mistral command family: show, set, test
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */
export function verifySetResult(
	scopes: MistralScopes,
	key: string,
	writtenScope: "user" | "project" = "user",
): { ok: true; message: string } | { ok: false; message: string } {
	const merged = mergeMistralFileConfigs(scopes.user.value, scopes.project.value);
	const writtenScopeValue = writtenScope === "project" ? scopes.project.value : scopes.user.value;
	const writtenValue = fileValue(writtenScopeValue, key);
	const effectiveValue = fileValue(merged, key);
	if (writtenValue === undefined) {
		return { ok: false, message: `the written key "${key}" did not take — re-read shows it unset; check the config chain` };
	}
	const effectiveText = describeValue(effectiveValue ?? writtenValue);
	let message = `Saved: ${key} = ${describeValue(writtenValue)} (${writtenScope} scope)`;
	if (writtenScope === "user") {
		// A project value outranks the user file per key — report the shadow.
		// Rendered text, not reference: content-equal lists are not a shadow.
		if (describeValue(effectiveValue) !== describeValue(writtenValue)) {
			message += `\nNote: a project-scope value shadows it in this project; effective here: ${effectiveText}`;
		}
	} else {
		// Files beat env and the project file wins per key — nothing shadows a
		// project value; a differing user-scope value is inert in this project.
		// Rendered text, not reference: content-equal lists are not an override.
		const userValue = fileValue(scopes.user.value, key);
		if (userValue !== undefined && describeValue(userValue) !== describeValue(writtenValue)) {
			message += `\nNote: it overrides the user-scope value ${describeValue(userValue)} in this project`;
		}
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
// Tab completion
// =============================================================================

/**
 * Injectable seams for the completion's dynamic reads (the currently-set
 * list entries of the line's target scope). Without deps the completion is
 * fully static: no dynamic `-` hints, no dynamic `+` hints for
 * connectors/autoLoad, no project-scope reads at all — the registerCommand
 * fallback path stays hermetic. `cwd`/`projectTrusted` enable project-scope
 * reads (a project file is NEVER read without trust).
 */
export interface CompletionDeps {
	env?: Record<string, string | undefined>;
	cwd?: string;
	projectTrusted?: boolean;
	readFile?: (path: string) => string;
}

/** The argument prefix for a scope: "set --project " -> "set --project". */
function argumentBase(project: boolean): string {
	return project ? "set --project" : "set";
}

/**
 * The list entries currently set in the line's target scope, read FRESH via
 * the pure loaders (never the session snapshot). An untrusted project is
 * never read; a deps-less call reads nothing.
 */
function currentEntriesForScope(
	key: string,
	project: boolean,
	deps: CompletionDeps | undefined,
): string[] {
	if (deps === undefined) return [];
	if (project) {
		if (deps.cwd === undefined || deps.projectTrusted !== true) return [];
		return listEntriesFrom(loadProjectMistralConfig(deps.cwd, deps.readFile), key);
	}
	return listEntriesFrom(loadUserMistralConfig(deps.env, deps.readFile), key);
}

/** Extract a list key's entries from a load result (undefined when unset). */
function listEntriesFrom(result: { value: MistralFileConfig | undefined }, key: string): string[] {
	const value = fileValue(result.value, key);
	return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * Tab completion for the `/mistral` command family. EVERY item's `value` is
 * the COMPLETE new argument text after the command name (pi applies an item
 * by replacing the entire stored argument prefix with `value`); `label`
 * carries the completing token, `description` the hint text. Positions:
 * subcommand, `--project` flag, key, then value hints per key kind —
 * booleans offer true/false, the region key offers global/eu/us, list keys
 * offer `+<entry>` (known server tools ∪ current entries for serverTools,
 * current entries only for connectors/autoLoad) and `-<entry>` (current
 * entries only). Without deps the completion is static (no dynamic reads).
 *
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */
export function mistralArgumentCompletions(
	prefix: string,
	deps?: CompletionDeps,
): Array<{ value: string; label: string; description?: string }> {
	const subcommands = [
		{ value: "set", label: "set", description: "Write one config key (user scope; --project writes the project scope)" },
		{ value: "test", label: "test", description: "Live GET /v1/models connectivity check" },
	];
	const tokens = prefix.trimStart().split(/\s+/).filter((token) => token.length > 0);
	const trailingSpace = /\s$/.test(prefix);
	if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
		const typed = tokens[0] ?? "";
		return subcommands.filter((item) => item.value.startsWith(typed));
	}
	if (tokens[0] !== "set") return [];
	const project = tokens[1] === "--project";
	const keyIdx = project ? 2 : 1;
	// Key position: the flag is offerable only while it is not yet consumed.
	if (tokens.length === keyIdx && trailingSpace) {
		return keyPositionItems(keyIdx, "", project, deps);
	}
	if (tokens.length === keyIdx + 1 && !trailingSpace) {
		return keyPositionItems(keyIdx, tokens[keyIdx] ?? "", project, deps);
	}
	// Value position (and nothing beyond it): the key token is the last
	// token before the value in both value-position shapes.
	if (tokens.length === keyIdx + 1 && trailingSpace) {
		return valuePositionItems(tokens[keyIdx] ?? "", "", project, deps);
	}
	if (tokens.length === keyIdx + 2 && !trailingSpace) {
		return valuePositionItems(tokens[keyIdx] ?? "", tokens[keyIdx + 1] ?? "", project, deps);
	}
	return [];
}

/** Key-position items: settable keys (and `--project` while unconsumed). */
function keyPositionItems(
	keyIdx: number,
	typedKey: string,
	project: boolean,
	deps: CompletionDeps | undefined,
): Array<{ value: string; label: string; description?: string }> {
	const items: Array<{ value: string; label: string; description?: string }> = [];
	const base = argumentBase(project);
	for (const key of Object.keys(SET_KEYS).sort()) {
		if (key.startsWith(typedKey)) {
			items.push({ value: `${base} ${key}`, label: key, description: SET_KEYS[key]!.description });
		}
	}
	if (keyIdx === 1 && !project && "--project".startsWith(typedKey)) {
		items.push({ value: "set --project", label: "--project", description: "Write to the project scope file (requires project trust)" });
	}
	return items;
}

/** Value-position items per key kind; empty for unknown keys and strings. */
function valuePositionItems(
	key: string,
	typedValue: string,
	project: boolean,
	deps: CompletionDeps | undefined,
): Array<{ value: string; label: string; description?: string }> {
	const spec = SET_KEYS[key];
	if (spec === undefined) return [];
	const base = `${argumentBase(project)} ${key}`;
	const item = (token: string): { value: string; label: string; description?: string } => ({
		value: `${base} ${token}`,
		label: token,
	});
	if (spec.kind === "boolean") {
		return ["true", "false"].filter((token) => token.startsWith(typedValue)).map(item);
	}
	if (spec.kind === "region") {
		const regions: MistralRegion[] = ["global", "eu", "us"];
		return regions.filter((token) => token.startsWith(typedValue)).map(item);
	}
	if (spec.kind === "list") {
		const current = currentEntriesForScope(key, project, deps);
		const plusCandidates = key === "serverTools" ? [...new Set([...KNOWN_CONFIG_SERVER_TOOLS, ...current])] : current;
		const plus = plusCandidates
			.filter((entry) => `+${entry}`.startsWith(typedValue))
			.map((entry) => item(`+${entry}`));
		const minus = current
			.filter((entry) => `-${entry}`.startsWith(typedValue))
			.map((entry) => item(`-${entry}`));
		return [...plus, ...minus];
	}
	return [];
}

// =============================================================================
// Registration (one hook from extensions/mistral.ts)
// =============================================================================

/** The most recent session_start context (cwd and trust are read FRESH). */
let latestSessionCtx: SessionStartContext | undefined;
/**
 * The ui context the autocomplete wrapper was last registered with. pi's
 * interactive mode clears its wrapper list on session replacement
 * (`resetExtensionUI` via `beforeSessionInvalidate`) and re-fires
 * `session_start` with a FRESH ui context, so the guard is per-context
 * identity, not a plain boolean: re-registering into the same context would
 * stack duplicates, but a new context MUST register again or Tab completion
 * silently dies after /new, /resume or /fork.
 */
let autocompleteWrapperCtx: SessionStartContext | undefined;

/**
 * Register the `/mistral` command family. Structural pi types on purpose:
 * the extension entry imports this without a type cycle.
 *
 * ADR 0016 — /mistral command family: show, set, test
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */
export function registerMistralCommands(pi: CommandAPI): void {
	pi.registerCommand("mistral", {
		description: "Show Mistral config status, set a key (user scope, or --project), or test connectivity",
		getArgumentCompletions: (prefix: string) => mistralArgumentCompletions(prefix),
		handler: async (args: string, ctx: CommandContext) => handleMistralCommand(args, ctx),
	});
	pi.on("session_start", (_event, ctx) => {
		// Refreshed on every session_start: sessions can switch, and the
		// completion must never answer from a stale cwd/trust state.
		latestSessionCtx = ctx;
		if (autocompleteWrapperCtx === ctx) return;
		autocompleteWrapperCtx = ctx;
		// addAutocompleteProvider is a no-op outside the TUI (RPC and the
		// runner's no-op ui context), so those modes stay inert either way.
		if (typeof ctx.ui.addAutocompleteProvider !== "function") return;
		ctx.ui.addAutocompleteProvider((current) =>
			mistralAutocompleteProviderWrapper(current, () => {
				const live = latestSessionCtx;
				// Trust is read FRESH at completion time (a project can be
				// trusted mid-session); never a frozen boolean.
				return live === undefined ? undefined : { cwd: live.cwd, projectTrusted: live.isProjectTrusted() };
			}),
		);
	});
}

/**
 * The autocomplete-provider wrapper (registered once per ui context on
 * session_start; a fresh ui context must register again — pi clears its
 * wrapper list on session replacement): serves
 * `/mistral` argument lines — including FORCED requests, which pi-tui
 * routes to path completion when the line contains a space after the
 * command name — with the same items as registerCommand's completion, and
 * delegates everything else (command-name position, other commands, plain
 * text, applyCompletion, shouldTriggerFileCompletion) to the wrapped
 * provider unchanged.
 *
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */
export function mistralAutocompleteProviderWrapper(
	current: AutocompleteProviderLike,
	getSession: () => CompletionSessionState | undefined,
): AutocompleteProviderLike {
	return {
		async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }) {
			const line = lines[cursorLine] ?? "";
			const commandText = line.slice(0, cursorCol).trimStart();
			// Mirror the base provider's extraction exactly: the argument text is
			// everything after the FIRST space of the trimmed line. A line without
			// the "/mistral " prefix (command-name position, other commands, plain
			// text) keeps the base provider's behavior untouched.
			if (!commandText.startsWith("/mistral ")) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const argumentText = commandText.slice(commandText.indexOf(" ") + 1);
			const session = getSession();
			const items = mistralArgumentCompletions(
				argumentText,
				session === undefined ? undefined : { cwd: session.cwd, projectTrusted: session.projectTrusted },
			);
			if (items.length === 0) return null;
			return { items, prefix: argumentText };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
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
		`unknown subcommand: ${JSON.stringify(sub)}\nUsage: /mistral [set [--project] <key> <value> | test]`,
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

/**
 * `/mistral set [--project] <key> <value>`: scope-parameterized atomic
 * write-then-verify. The user scope stays the default; `--project` writes
 * `<cwd>/.pi/mistral-native.json` and is refused without project trust
 * (pi loads the project scope only for trusted projects). A no-op
 * mutation (nothing to add/remove) notifies its note without writing.
 *
 * ADR 0016 — /mistral command family: show, set, test
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */
async function handleSet(rest: string, ctx: CommandContext, env: Record<string, string | undefined>): Promise<void> {
	const parts = rest.split(/\s+/).filter((part) => part.length > 0);
	// Exactly one leading flag; a second "--project" falls through to the
	// key position and errors as an unknown key.
	const scope: "user" | "project" = parts[0] === "--project" ? "project" : "user";
	const tail = scope === "project" ? parts.slice(1) : parts;
	// A --project in a VALUE position (after the key) is a flag-position
	// error; the key position is excluded — that is the second-flag case above.
	if (tail.length > 1 && tail.slice(1).includes("--project")) {
		ctx.ui.notify("the --project flag goes before the key", "error");
		return;
	}
	if (scope === "project" && !ctx.isProjectTrusted()) {
		ctx.ui.notify(
			"refusing to write the project scope: this project is not trusted — pi only loads project config for trusted projects",
			"error",
		);
		return;
	}
	if (tail.length === 0) {
		ctx.ui.notify(usageMessage(), "error");
		return;
	}
	const [key, ...valueParts] = tail;
	// A list key with NO value means "clear the list" (the key description
	// says so) — only list keys accept the empty form; every other key
	// needs a value (its empty form is a usage error).
	let value: string;
	if (valueParts.length === 0) {
		if (key !== undefined && SET_KEYS[key]?.kind !== "list") {
			ctx.ui.notify(`missing value for "${key}"; Usage: /mistral set [--project] <key> <value>`, "error");
			return;
		}
		value = "";
	} else {
		value = valueParts.join(" ");
	}
	let outcome: SetKeyOutcome;
	try {
		outcome = scope === "project"
			? setProjectConfigKey(ctx.cwd, key!, value)
			: setUserConfigKey(key!, value, env);
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
		return;
	}
	if (!outcome.wrote) {
		// No-op mutation: nothing was written, so no refresh, no verify.
		ctx.ui.notify(outcome.note ?? "nothing to write", "info");
		return;
	}
	// Sync the live session's cached config (the sanctioned cached-path
	// touch; only a successful set refreshes). The env bag keeps the
	// refresh's user-chain read hermetic in tests.
	refreshMistralConfig(ctx.cwd, ctx.isProjectTrusted(), undefined, env);
	const scopes = loadMistralScopes(ctx.cwd, ctx.isProjectTrusted(), env);
	const verify = verifySetResult(scopes, key!, scope);
	const noteSuffix = outcome.note !== undefined ? `\n${outcome.note}` : "";
	ctx.ui.notify(verify.message + noteSuffix + `\nwritten to: ${outcome.target}`, verify.ok ? "info" : "error");
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
