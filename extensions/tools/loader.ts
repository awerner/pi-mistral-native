/**
 * Client-side connector tools via a loader pattern: authenticated Mistral
 * connectors become client-side callable pi tools, registered passively
 * (deferred exposure, never auto-activated) and activated on demand via
 * setActiveTools. Counterpart to the server-side connector refs: same
 * connectors, two execution models.
 *
 * Wire facts live-verified 2026-11-02: GET /v1/connectors?fetch_user_data=true
 * populates is_authenticated (absent without the flag; authenticated
 * connectors also carry secret-adjacent connection_credentials, which are
 * never parsed into results — only booleans and counts flow out of
 * discovery); GET /v1/connectors/{id}/tools answers HTTP 401 for
 * unauthenticated connectors; POST /v1/connectors/{id}/tools/{tool}/call
 * returns MCP-style content blocks with metadata.mcp_meta.isError.
 *
 * pi cannot unregister tools: unloading re-registers each tool definition
 * with exposure "hidden" (the documented withdraw path) and drops the names
 * from the active set. Re-registering replaces a definition, so the loader
 * tool re-registers itself with a dynamic description after each discovery.
 *
 * ADR 0007 — Server-side tools as opaque content; ADR 0011 — Client-side connector tools via the loader pattern.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	SessionStartEvent,
	ToolAnnotations,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createMistralClient, MistralApiError } from "./mistral-client.js";
import type { MistralClient, MistralConnectorTool } from "./mistral-client.js";
import { getEffectiveMistralConfig } from "../mistral/config.js";

type AnyToolDefinition = ToolDefinition<any, any>;

/** One parsed connector from discovery (booleans only; credentials never retained). */
export interface ConnectorInfo {
	id: string;
	name: string;
	description: string | null;
	authenticated: boolean;
}

/** Dependencies of the connector loader: injected so tests can drive it without pi. */
export interface ConnectorLoaderDeps {
	/** Resolves a client for one call (fresh API key + abort signal), like ConnectorToolsDeps.getClient. */
	getClient: (ctx: ExtensionToolContext | undefined, signal?: AbortSignal) => Promise<MistralClient>;
	/** Active/registered tool management, injected so tests can drive it without pi. */
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
	registerTool: (tool: AnyToolDefinition) => void;
	/**
	 * All tools currently registered in the session (mirrors pi's
	 * ExtensionAPI.getAllTools()) — used for session-wide name uniqueness:
	 * a connector tool named like a pi built-in (read, find, …), an MCP
	 * tool or another extension's tool must NOT silently shadow it (pi's
	 * tool registry replaces same-name custom registrations). Optional for
	 * tests.
	 */
	getAllTools?: (() => { name: string }[]) | undefined;
}

/** A loader session: the three loader tools plus its session_start entry point. */
export interface ConnectorLoaderSession {
	/** The loader tools (load/unload/reload); registration happens via deps.registerTool. */
	tools: AnyToolDefinition[];
	/**
	 * Session-start discovery + registration; never throws, notifies
	 * warnings via ctx.ui. `reason: "new"` (session replacement via /new)
	 * clears loaded-tool state carried over from the previous session;
	 * resume/fork/startup/reload keep it.
	 */
	onSessionStart: (ctx: ExtensionContext, reason?: SessionStartEvent["reason"]) => Promise<void>;
}

// =============================================================================
// Pure helpers
// =============================================================================

/** Sanitized namespace name for one connector: `mistral_cn_<connectorName>` over [a-z0-9_]. */
export function connectorNamespaceName(connectorName: string): string {
	return `mistral_cn_${connectorName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

/**
 * Folds MCP-style content blocks to text: text blocks joined with "\n";
 * non-text blocks (image/audio/resource/resource_link) fold to a
 * placeholder like `[(image content)]`. Unknown shapes fold to "".
 */
export function foldConnectorContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block !== null && typeof block === "object" && !Array.isArray(block)) {
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") {
				parts.push(record.text);
				continue;
			}
			const type = typeof record.type === "string" && record.type.length > 0 ? record.type : "unknown";
			parts.push(`[(${type} content)]`);
			continue;
		}
		parts.push("[(unknown content)]");
	}
	return parts.join("\n");
}

/** Forwards boolean MCP tool annotations (readOnlyHint etc.); undefined when none are booleans. */
export function mapConnectorAnnotations(annotations: unknown): ToolAnnotations | undefined {
	if (annotations === null || typeof annotations !== "object" || Array.isArray(annotations)) {
		return undefined;
	}
	const record = annotations as Record<string, unknown>;
	const mapped: ToolAnnotations = {};
	let any = false;
	for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
		const value = record[key];
		if (typeof value === "boolean") {
			mapped[key] = value;
			any = true;
		}
	}
	return any ? mapped : undefined;
}

/**
 * Pure parse of GET /v1/connectors?fetch_user_data=true items: keeps only
 * connectors with supports_mcp !== false. A connector is authenticated when
 * is_authenticated === true, or (defensively, when the flag is missing) when
 * it carries a non-empty connection_credentials array — the credentials
 * themselves are secret-adjacent and never retained, only the boolean.
 */
export function buildConnectorRegistry(items: unknown): { authenticated: ConnectorInfo[]; all: ConnectorInfo[] } {
	const all: ConnectorInfo[] = [];
	for (const item of Array.isArray(items) ? items : []) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.id !== "string" || record.id.length === 0) continue;
		if (typeof record.name !== "string" || record.name.length === 0) continue;
		if (record.supports_mcp === false) continue;
		let authenticated = false;
		if (record.is_authenticated === true) {
			authenticated = true;
		} else if (
			record.is_authenticated === undefined &&
			Array.isArray(record.connection_credentials) &&
			record.connection_credentials.length > 0
		) {
			authenticated = true;
		}
		all.push({
			id: record.id,
			name: record.name,
			description: typeof record.description === "string" ? record.description : null,
			authenticated,
		});
	}
	return { authenticated: all.filter((connector) => connector.authenticated), all };
}

/** First sentence of a text (whitespace-normalized); "" for missing/empty input. */
function firstSentence(text: string | null | undefined): string {
	if (typeof text !== "string") return "";
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return "";
	const match = /^(.*?[.!?])(?:\s|$)/.exec(normalized);
	return match?.[1] ?? normalized;
}

/** Truncates a single line to `max` chars (ellipsis included in the budget). */
function truncateLine(text: string, max = 100): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Renders any caught error as a concise, log-safe message (never headers/auth). */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether metadata.mcp_meta.isError is true on a connector tool call response. */
function isMcpError(response: Record<string, unknown>): boolean {
	const metadata = response.metadata;
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
	const mcpMeta = (metadata as Record<string, unknown>).mcp_meta;
	if (mcpMeta === null || typeof mcpMeta !== "object" || Array.isArray(mcpMeta)) return false;
	return (mcpMeta as Record<string, unknown>).isError === true;
}

// =============================================================================
// Config gating (mistral-native.json connectorTools section)
// =============================================================================

/**
 * Effective enablement of the connector loader. Precedence (highest wins):
 * connectorTools.enabled from the merged file config (project JSON > user
 * JSON) > the MISTRAL_CONNECTOR_TOOLS environment variable > default true.
 * Env values "0", "false" and "off" (case-insensitive) disable; any other
 * non-empty value enables; absent/empty means unset.
 *
 * ADR 0010 — Configuration via mistral-native.json.
 */
export function connectorToolsEnabled(
	env: Record<string, string | undefined> | undefined = process.env,
	fileConfig = getEffectiveMistralConfig(),
): boolean {
	const fileEnabled = fileConfig?.connectorTools?.enabled;
	if (fileEnabled !== undefined) return fileEnabled;
	// An explicit env map without the key means UNSET — no fall-through to
	// the live process env (the default parameter already passes process.env).
	const raw = (env ?? process.env).MISTRAL_CONNECTOR_TOOLS;
	if (raw === undefined || raw.trim().length === 0) return true;
	const normalized = raw.trim().toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

// =============================================================================
// Session state and loader construction
// =============================================================================

/** One loaded connector tool: the remote shape plus its session-unique registration. */
interface LoadedTool {
	tool: MistralConnectorTool;
	/** Registered name (original, or `<original>__<connectorName>` after a cross-connector collision). */
	sessionName: string;
	definition: AnyToolDefinition;
}

/** Per-connector loaded tools (module-private loader state, per session). */
interface LoadedConnector {
	connector: ConnectorInfo;
	tools: LoadedTool[];
}

/** The result of one load attempt (renames note session-wide name collisions). */
type LoadResult =
	| {
			ok: true;
			names: string[];
			tools: { name: string; description: string | undefined }[];
			renames: { from: string; to: string }[];
	  }
	| { ok: false; message: string };

/** Model-facing text plus structuredContent and log-safe details. */
function ok(text: string, structured: Record<string, unknown>, details: Record<string, unknown>): AgentToolResult<any> {
	return {
		content: [{ type: "text", text }],
		structuredContent: structured as never,
		details,
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

/** Keyset-paginated discovery: all connector pages, then the pure registry parse. */
async function discoverConnectors(
	client: MistralClient,
	signal: AbortSignal | undefined,
): Promise<{ authenticated: ConnectorInfo[]; all: ConnectorInfo[] }> {
	const raw: unknown[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await client.listConnectors({ cursor, pageSize: 1000, fetchUserData: true, signal });
		raw.push(...page.items);
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	return buildConnectorRegistry(raw);
}

/** Builds the session: loader state, the three tools, and the session_start path. */
export function createConnectorLoaderSession(deps: ConnectorLoaderDeps): ConnectorLoaderSession {
	const state = {
		all: [] as ConnectorInfo[],
		authenticated: [] as ConnectorInfo[],
		loaded: new Map<string, LoadedConnector>(),
	};

	/** Resolves a connector by name or UUID from the registry (names are stable handles). */
	function findConnector(query: string): ConnectorInfo | undefined {
		const inRegistry = state.all.find((connector) => connector.name === query || connector.id === query);
		if (inRegistry !== undefined) return inRegistry;
		for (const entry of state.loaded.values()) {
			if (entry.connector.name === query || entry.connector.id === query) return entry.connector;
		}
		return undefined;
	}

	/** Builds one callable pi tool for a connector tool (deferred exposure; activated on demand). */
	function buildConnectorTool(
		connector: ConnectorInfo,
		remote: MistralConnectorTool,
		sessionName: string,
		toolCount: number,
	): AnyToolDefinition {
		const description =
			typeof remote.description === "string" && remote.description.length > 0
				? remote.description
				: `Tool ${remote.name} from connector ${connector.name}`;
		// Real JSON Schema from the connector (Mistral's anyOf-nullable idiom
		// included); fall back to an empty object schema when it is not a
		// non-null object.
		const parameters =
			remote.inputSchema !== null &&
			typeof remote.inputSchema === "object" &&
			!Array.isArray(remote.inputSchema)
				? remote.inputSchema
				: Type.Object({});
		const annotations = mapConnectorAnnotations(remote.annotations);
		const namespaceDescription = firstSentence(connector.description) || connector.name;
		const definition: AnyToolDefinition = {
			name: sessionName,
			label: typeof remote.title === "string" && remote.title.length > 0 ? remote.title : remote.name,
			description,
			parameters,
			exposure: "deferred",
			namespace: {
				name: connectorNamespaceName(connector.name),
				aliases: [connector.name],
				description: `${namespaceDescription} — ${toolCount} tools`,
			},
			...(annotations !== undefined ? { annotations } : {}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const toolArguments = (params ?? {}) as Record<string, unknown>;
				try {
					const client = await deps.getClient(ctx, signal);
					const response = await client.callConnectorTool({
						connectorIdOrName: connector.id,
						toolName: remote.name,
						arguments: toolArguments,
						signal,
					});
					const text = foldConnectorContent(response.content);
					if (isMcpError(response)) {
						return {
							content: [{ type: "text", text }],
							details: { connector: connector.name, tool: remote.name },
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text }],
						details: { connector: connector.name, tool: remote.name },
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `${remote.name} failed: ${errorMessage(error)}` }],
						details: { connector: connector.name, tool: remote.name },
						isError: true,
					};
				}
			},
		};
		return definition;
	}

	/**
	 * Loads one connector's tools: fetches the raw list (a 401 fails the load
	 * with authenticate guidance), registers every tool with session-wide
	 * unique names (collisions with tools of other connectors, pi built-ins,
	 * MCP tools or other extensions rename to `<original>__<connectorName>`;
	 * re-loading the SAME connector stays idempotent — a name registered by
	 * this loader for this very connector replaces its own definition),
	 * tracks them in the loader state and activates them. Never embeds connection_credentials anywhere.
	 */
	async function loadConnectorTools(
		connector: ConnectorInfo,
		ctx: ExtensionToolContext | undefined,
		signal: AbortSignal | undefined,
	): Promise<LoadResult> {
		const client = await deps.getClient(ctx, signal);
		let remoteTools: MistralConnectorTool[];
		try {
			remoteTools = await client.listConnectorToolsRaw({ connectorIdOrName: connector.id, signal });
		} catch (error) {
			if (error instanceof MistralApiError && error.status === 401) {
				return {
					ok: false,
					message:
						`Connector ${connector.name} is not authenticated (no credentials found). ` +
						"Use mistral_connector_auth_url to authenticate, then mistral_connector_reload.",
				};
			}
			throw error;
		}
		// Session-wide uniqueness: pi's tool registry replaces same-name
		// custom registrations (a connector tool literally named `read` would
		// shadow pi's built-in read tool), so a remote name collides when it
		// is (a) already used by this loader for a DIFFERENT connector, or
		// (b) already registered in the session per deps.getAllTools (pi
		// built-ins, MCP tools, other extensions). Exception: re-loading the
		// SAME connector stays idempotent — its own previously registered
		// names replace their own definitions and must NOT trigger a rename.
		const ownPrevious = state.loaded.get(connector.name);
		const ownNames = new Set(ownPrevious?.tools.map((loaded) => loaded.sessionName) ?? []);
		const used = new Map<string, string>();
		for (const [name, entry] of state.loaded) {
			if (name === connector.name) continue;
			for (const loaded of entry.tools) used.set(loaded.sessionName, name);
		}
		const sessionRegistered = new Set(deps.getAllTools?.().map((tool) => tool.name) ?? []);
		const renames: { from: string; to: string }[] = [];
		const picked: { remote: MistralConnectorTool; sessionName: string }[] = [];
		for (const remote of remoteTools) {
			if (remote === null || typeof remote !== "object" || typeof remote.name !== "string" || remote.name.length === 0) {
				continue;
			}
			const collides = used.has(remote.name) || (sessionRegistered.has(remote.name) && !ownNames.has(remote.name));
			let sessionName = remote.name;
			if (collides) {
				// The rename target is re-checked too: `<original>__<connector>`
				// may itself be held by another extension/MCP tool, so try
				// `_2`, `_3`, … until the candidate is free in BOTH `used` and
				// `sessionRegistered` (the own-name exception applies to the
				// original name only — a suffixed candidate is never our own).
				const base = `${remote.name}__${connector.name}`;
				let candidate = base;
				let counter = 2;
				while (used.has(candidate) || sessionRegistered.has(candidate)) {
					candidate = `${base}_${counter}`;
					counter += 1;
				}
				sessionName = candidate;
				renames.push({ from: remote.name, to: sessionName });
			}
			used.set(sessionName, connector.name);
			picked.push({ remote, sessionName });
		}
		const tools: LoadedTool[] = picked.map(({ remote, sessionName }) => ({
			tool: remote,
			sessionName,
			definition: buildConnectorTool(connector, remote, sessionName, picked.length),
		}));
		for (const loaded of tools) deps.registerTool(loaded.definition);
		state.loaded.set(connector.name, { connector, tools });
		const names = tools.map((loaded) => loaded.sessionName);
		deps.setActiveTools([...new Set([...deps.getActiveTools(), ...names])]);
		return {
			ok: true,
			names,
			tools: tools.map((loaded) => ({
				name: loaded.sessionName,
				description:
					typeof loaded.tool.description === "string" && loaded.tool.description.length > 0
						? loaded.tool.description
						: undefined,
			})),
			renames,
		};
	}

	/** Dynamic loader description: one line per authenticated connector. */
	function loaderDescription(): string {
		const lines = state.authenticated.map(
			(connector) => `- ${connector.name}: ${firstSentence(connector.description) || "(no description)"}`,
		);
		return (
			"Load tools from an authenticated Mistral connector into this session as client-side callable tools. " +
			"Call this tool with a connector name to load its tools into the session." +
			(lines.length > 0 ? `\nAvailable connectors:\n${lines.join("\n")}` : "")
		);
	}

	const buildLoadTool = (): AnyToolDefinition =>
		defineTool({
			name: "mistral_connector_load",
			label: "Mistral connector load",
			description: loaderDescription(),
			parameters: Type.Object({
				connector: Type.String({ description: "Connector name (e.g. sharepoint_mcp) or its UUID id" }),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const connector = findConnector(params.connector);
				if (connector === undefined) {
					const available = state.authenticated.map((entry) => entry.name).join(", ");
					return fail(
						`Unknown connector "${params.connector}". Authenticated connectors: ${
							available.length > 0 ? available : "(none — call mistral_connector_reload)"
						}.`,
						{ connector: params.connector },
					);
				}
				try {
					const result = await loadConnectorTools(connector, ctx, signal);
					if (!result.ok) {
						return fail(result.message, { connector: connector.name });
					}
					const entry = state.loaded.get(connector.name);
					const lines = (entry?.tools ?? []).map(
						(loaded) =>
							`- ${loaded.sessionName}: ${truncateLine(firstSentence(loaded.definition.description)) || "(no description)"}`,
					);
					let text = `Loaded ${result.names.length} tools from connector ${connector.name} (now active; usable from the next model request):`;
					if (lines.length > 0) text += `\n${lines.join("\n")}`;
					for (const rename of result.renames) {
						text += `\nNote: tool "${rename.from}" registered as "${rename.to}" (name already used).`;
					}
					return ok(
						text,
						{
							connector: connector.name,
							toolCount: result.names.length,
							tools: result.tools.map((tool) => ({
								name: tool.name,
								...(tool.description !== undefined ? { description: tool.description } : {}),
							})),
						},
						{ connector: connector.name, toolCount: result.names.length },
					);
				} catch (error) {
					return fail(`mistral_connector_load failed: ${errorMessage(error)}`, {
						connector: connector.name,
						error: errorMessage(error),
					});
				}
			},
		});

	const unloadTool: AnyToolDefinition = defineTool({
		name: "mistral_connector_unload",
		label: "Mistral connector unload",
		description:
			"Unload a connector's tools from this session: they are re-registered hidden (pi cannot unregister) and removed from the active set.",
		parameters: Type.Object({
			connector: Type.String({ description: "Connector name (e.g. sharepoint_mcp) or its UUID id" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const entry = state.loaded.get(params.connector);
			const resolved = entry ?? (() => {
				const connector = findConnector(params.connector);
				return connector !== undefined ? state.loaded.get(connector.name) : undefined;
			})();
			if (resolved === undefined) {
				return fail(`Connector ${params.connector} has no loaded tools.`, { connector: params.connector });
			}
			const names = new Set(resolved.tools.map((loaded) => loaded.sessionName));
			for (const loaded of resolved.tools) {
				// pi cannot unregister: re-registering with exposure "hidden" is
				// the withdraw path; everything else stays identical.
				deps.registerTool({ ...loaded.definition, exposure: "hidden" });
			}
			deps.setActiveTools(deps.getActiveTools().filter((name) => !names.has(name)));
			state.loaded.delete(resolved.connector.name);
			const text = `Unloaded ${resolved.tools.length} tools from connector ${resolved.connector.name} (now hidden and inactive).`;
			return ok(
				text,
				{ connector: resolved.connector.name, toolCount: resolved.tools.length },
				{ connector: resolved.connector.name, toolCount: resolved.tools.length },
			);
		},
	});

	const reloadTool: AnyToolDefinition = defineTool({
		name: "mistral_connector_reload",
		label: "Mistral connector reload",
		description:
			"Re-run the Mistral connector discovery and refresh the loader's connector list (covers /reload and session-resume staleness).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			try {
				const previous = new Set(state.authenticated.map((connector) => connector.name));
				const client = await deps.getClient(ctx, signal);
				const registry = await discoverConnectors(client, signal);
				state.all = registry.all;
				state.authenticated = registry.authenticated;
				// Re-registering replaces the definition: the load tool's dynamic
				// description now lists the refreshed connector set.
				if (registry.authenticated.length > 0) {
					deps.registerTool(buildLoadTool());
				}
				const lines = registry.authenticated.map(
					(connector) => `- ${connector.name}: ${firstSentence(connector.description) || "(no description)"}`,
				);
				let text = `Discovery refreshed: ${registry.authenticated.length} authenticated connector(s).`;
				if (lines.length > 0) text += `\n${lines.join("\n")}`;
				const added = registry.authenticated.filter((connector) => !previous.has(connector.name));
				const removed = [...previous].filter(
					(name) => !registry.authenticated.some((connector) => connector.name === name),
				);
				if (added.length > 0) text += `\nNewly authenticated: ${added.map((connector) => connector.name).join(", ")}`;
				if (removed.length > 0) text += `\nNo longer authenticated: ${removed.join(", ")}`;
				return ok(
					text,
					{
						connectors: registry.authenticated.map((connector) => ({
							name: connector.name,
							id: connector.id,
							authenticated: true,
						})),
						newlyAuthenticated: added.map((connector) => connector.name),
						noLongerAuthenticated: removed,
					},
					{ count: registry.authenticated.length },
				);
			} catch (error) {
				return fail(`mistral_connector_reload failed: ${errorMessage(error)}`, {
					error: errorMessage(error),
				});
			}
		},
	});

	/** Registers the three loader tools (load/unload/reload; default direct exposure). */
	function registerLoaderTools(): void {
		deps.registerTool(buildLoadTool());
		deps.registerTool(unloadTool);
		deps.registerTool(reloadTool);
	}

	async function onSessionStart(ctx: ExtensionContext, reason?: SessionStartEvent["reason"]): Promise<void> {
		try {
			if (!connectorToolsEnabled()) return;
			// No Mistral credentials: the provider is simply unconfigured —
			// register nothing, silently (mirrors the model catalog's
			// unconfigured-provider handling; a session-start warning would
			// fire in every pi session without a Mistral key).
			const apiKey = await resolveApiKey(ctx as unknown as ExtensionToolContext | undefined);
			if (apiKey === undefined || apiKey.length === 0) return;
			// Session replacement (/new): pi reuses this loaded extension
			// instance for the new session's runner, so loaded-tool state from
			// the PREVIOUS session is stale — names it "reserved" no longer
			// exist, and unloading them would inject unreachable hidden
			// definitions while reporting success. Clear it. resume/fork/
			// startup/reload keep it: stable rename decisions let pending
			// transcript tool names re-activate.
			if (reason === "new") {
				state.loaded.clear();
			}
			// ExtensionContext is structurally sufficient for key resolution
			// (only modelRegistry is read); cast for the getClient signature.
			const toolCtx = ctx as unknown as ExtensionToolContext | undefined;
			let registry: { authenticated: ConnectorInfo[]; all: ConnectorInfo[] };
			try {
				const client = await deps.getClient(toolCtx, undefined);
				registry = await discoverConnectors(client, undefined);
			} catch (error) {
				// Network error or non-2xx with credentials present: register
				// NOTHING and surface why via a warning.
				ctx.ui.notify(`Mistral connector loader unavailable: ${errorMessage(error)}`, "warning");
				return;
			}
			state.all = registry.all;
			state.authenticated = registry.authenticated;
			if (registry.authenticated.length === 0) return; // silent: nothing to offer
			registerLoaderTools();
			// autoLoad (connectorTools.autoLoad from mistral-native.json): load
			// authenticated names at session start, without a model-facing result.
			const autoLoad = getEffectiveMistralConfig()?.connectorTools?.autoLoad;
			if (autoLoad !== undefined) {
				for (const name of autoLoad) {
					const connector = state.authenticated.find((entry) => entry.name === name);
					if (connector === undefined) {
						// Configured but not authenticated: never silent — the user
						// asked for it, so say why nothing was loaded.
						ctx.ui.notify(`Auto-load: connector ${name} is not authenticated (skipped)`, "warning");
						continue;
					}
					try {
						const result = await loadConnectorTools(connector, toolCtx, undefined);
						if (result.ok) {
							ctx.ui.notify(`Auto-loaded ${result.names.length} tools from connector ${connector.name}`, "info");
						} else {
							ctx.ui.notify(`Auto-load of connector ${connector.name} failed: ${result.message}`, "warning");
						}
					} catch (error) {
						ctx.ui.notify(`Auto-load of connector ${connector.name} failed: ${errorMessage(error)}`, "warning");
					}
				}
			}
		} catch (error) {
			// Never throw from the session_start handler.
			try {
				ctx.ui.notify(`Mistral connector loader failed: ${errorMessage(error)}`, "warning");
			} catch {
				// A broken UI context must not propagate either.
			}
		}
	}

	return {
		tools: [buildLoadTool(), unloadTool, reloadTool],
		onSessionStart,
	};
}

/** Builds the three connector loader tools (tests drive them via injected deps). */
export function createConnectorLoaderTools(deps: ConnectorLoaderDeps): AnyToolDefinition[] {
	return createConnectorLoaderSession(deps).tools;
}

// =============================================================================
// pi registration
// =============================================================================

/**
 * Resolves the Mistral API key for discovery and tool calls: the
 * mistral-native provider's registered key if available, else the
 * MISTRAL_API_KEY environment variable (local copy of the module-private
 * resolveApiKey in extensions/tools/connectors.ts). The resolved key is
 * never logged or embedded in results.
 */
async function resolveApiKey(ctx: ExtensionToolContext | undefined): Promise<string | undefined> {
	const providerKey = await ctx?.modelRegistry?.getApiKeyForProvider?.("mistral-native");
	if (providerKey) return providerKey;
	return process.env.MISTRAL_API_KEY;
}

/** Test seam: overrides the fetch implementation used by registerConnectorLoaderTools (mirrors setMistralTestFetch in extensions/mistral/api.ts). */
let loaderTestFetch: typeof fetch | undefined;

/** Overrides (or clears) the fetch implementation registerConnectorLoaderTools uses. */
export function setConnectorLoaderTestFetch(fetchImpl: typeof fetch | undefined): void {
	loaderTestFetch = fetchImpl;
}

/**
 * Registers the connector loader with pi. Discovery runs at session_start
 * (the loader tool's description needs the result); the loader tools are
 * registered only when the feature is enabled and at least one connector
 * is authenticated. Connector tools themselves register deferred and are
 * activated on demand.
 */
export function registerConnectorLoaderTools(pi: ExtensionAPI): void {
	const deps: ConnectorLoaderDeps = {
		getClient: async (ctx, _signal) => {
			const apiKey = await resolveApiKey(ctx);
			return createMistralClient({
				apiKey,
				...(loaderTestFetch !== undefined ? { fetchImpl: loaderTestFetch } : {}),
			});
		},
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
		registerTool: (tool) => pi.registerTool(tool),
		getAllTools: () => pi.getAllTools(),
	};
	const session = createConnectorLoaderSession(deps);
	// The session_start event itself may be undefined; only the reason is
	// read, and a missing event must behave like an ordinary start (no
	// state clear).
	pi.on("session_start", (event, ctx) => session.onSessionStart(ctx, event?.reason));
}
