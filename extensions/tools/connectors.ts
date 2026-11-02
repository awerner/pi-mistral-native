/**
 * pi tools for Mistral's connector management APIs: list
 * connectors, inspect a connector's tools, fetch its OAuth authorization
 * URL, and activate/deactivate/share/unshare it. Wire formats verified
 * against vendor/mistral-openapi.yaml (`/v1/connectors` family).
 *
 * Connector OAuth grants are stored server-side at Mistral; nothing is
 * stored locally (auth.json stays untouched). The `auth_url` returned by
 * `mistral_connector_auth_url` is a bearer URL: it goes to the caller via
 * `content` and `structuredContent` only, never into `details`, which pi
 * persists in transcripts and logs.
 *
 * ADR 0004 — API-key credential chain without Mistral OAuth; ADR 0007 — Server-side tools as opaque content.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import type { MistralClient } from "./mistral-client.js";
import { createMistralClient } from "./mistral-client.js";

/** Dependencies of {@link createConnectorTools}: a lazy per-call client factory. */
export interface ConnectorToolsDeps {
	/** Resolves a client for one execute call (fresh API key + abort signal). */
	getClient: (ctx: ExtensionToolContext | undefined, signal?: AbortSignal) => Promise<MistralClient>;
}

type AnyToolDefinition = ToolDefinition<any, any>;

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

/** Renders any caught error as a concise, log-safe message (never headers/auth). */
function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Builds the seven connector tools. `getClient` is called once per execute
 * call so each request uses the currently resolved API key and signal.
 */
export function createConnectorTools(deps: ConnectorToolsDeps): AnyToolDefinition[] {
	const { getClient } = deps;

	/** Wraps an execute body with client resolution and error mapping. */
	async function run(
		ctx: ExtensionToolContext | undefined,
		signal: AbortSignal | undefined,
		tool: string,
		work: (client: MistralClient) => Promise<AgentToolResult<any>>,
	): Promise<AgentToolResult<any>> {
		try {
			const client = await getClient(ctx, signal);
			return await work(client);
		} catch (error) {
			return fail(`${tool} failed: ${errorMessage(error)}`, { tool, error: errorMessage(error) });
		}
	}

	const mistralConnectorList = defineTool({
		name: "mistral_connector_list",
		label: "Mistral connector list",
		description: "List available Mistral connectors (e.g. notion, gdrive) with cursor pagination.",
		parameters: Type.Object({
			cursor: Type.Optional(Type.String({ description: "Continuation cursor from a previous result's nextCursor" })),
			pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Page size (1..1000)" })),
		}),
		outputSchema: Type.Object({
			connectors: Type.Array(
				Type.Object({ id: Type.String(), name: Type.String(), description: Type.Optional(Type.String()) }, { additionalProperties: true }),
			),
			nextCursor: Type.Union([Type.String(), Type.Null()]),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_connector_list", async (client) => {
				const page = await client.listConnectors({
					cursor: params.cursor,
					pageSize: params.pageSize,
					signal,
				});
				const summary =
					page.items.length > 0
						? page.items
								.map((connector) => `- ${connector.name} (${connector.id}): ${connector.description ?? "(no description)"}`)
								.join("\n")
						: "No connectors found";
				const nextPage = page.nextCursor ? `\nMore pages available (nextCursor: ${page.nextCursor})` : "";
				return ok(
					`${page.items.length} connector(s):\n${summary}${nextPage}`,
					{
						connectors: page.items.map((connector) => ({
							id: connector.id,
							name: connector.name,
							...(connector.description != null ? { description: connector.description } : {}),
						})) as unknown as Record<string, unknown>[],
						nextCursor: page.nextCursor,
					},
					{ count: page.items.length },
				);
			});
		},
	});

	const mistralConnectorTools = defineTool({
		name: "mistral_connector_tools",
		label: "Mistral connector tools",
		description:
			"List the tools a connector exposes (requires the connector to be authenticated). " +
			"Use mistral_connector_auth_url first when the connector reports missing credentials.",
		parameters: Type.Object({
			connectorIdOrName: Type.String({ description: "Connector id (UUID) or name (e.g. notion)" }),
		}),
		outputSchema: Type.Object({
			tools: Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()) }, { additionalProperties: true })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_connector_tools", async (client) => {
				const tools = await client.listConnectorTools({
					connectorIdOrName: params.connectorIdOrName,
					signal,
				});
				const summary =
					tools.length > 0
						? tools
								.map((tool) => `- ${tool.name}: ${tool.description ?? "(no description)"}`)
								.join("\n")
						: "No tools found";
				return ok(
					`${tools.length} tool(s) for connector ${params.connectorIdOrName}:\n${summary}`,
					{
						tools: tools.map((tool) => ({
							name: tool.name,
							...(tool.description != null ? { description: tool.description } : {}),
						})) as unknown as Record<string, unknown>[],
					},
					{ connectorIdOrName: params.connectorIdOrName, count: tools.length },
				);
			});
		},
	});

	const mistralConnectorAuthUrl = defineTool({
		name: "mistral_connector_auth_url",
		label: "Mistral connector auth URL",
		description:
			"Get the OAuth authorization URL for a connector. Open it in a browser to grant access; " +
			"the grant is stored on Mistral's side (nothing is stored locally).",
		parameters: Type.Object({
			connectorIdOrName: Type.String({ description: "Connector id (UUID) or name (e.g. notion)" }),
			appReturnUrl: Type.Optional(Type.String({ description: "Optional URL the user is returned to after granting access" })),
		}),
		outputSchema: Type.Object({
			authUrl: Type.String(),
			ttl: Type.Integer(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_connector_auth_url", async (client) => {
				const { authUrl, ttl } = await client.getConnectorAuthUrl({
					connectorIdOrName: params.connectorIdOrName,
					appReturnUrl: params.appReturnUrl,
					signal,
				});
				// SECURITY: the auth_url is a bearer URL (it grants access once
				// opened). It is returned to the caller via `content` and
				// `structuredContent` only — never `details`, which pi persists in
				// transcripts and logs.
				return ok(
					`Connector OAuth authorization URL (valid for ${ttl} seconds):\n${authUrl}\nOpen it in a browser to grant access; the grant is stored on Mistral's side.`,
					{ authUrl, ttl },
					{ connectorIdOrName: params.connectorIdOrName },
				);
			});
		},
	});

	const mistralConnectorActivate = defineTool({
		name: "mistral_connector_activate",
		label: "Mistral connector activate",
		description:
			"Activate a connector for a consumer scope (user, workspace or organization), making its tools available to chat requests.",
		parameters: Type.Object({
			connectorId: Type.String({ description: "Connector id (UUID)" }),
			// Optional + execute fallback: pi's validation never applies JSON-Schema
			// defaults, so a required-with-default property would fail when omitted.
			consumerScope: Type.Optional(
				StringEnum(["user", "workspace", "organization"] as const, {
					description: "Scope to activate the connector for (defaults to user)",
					default: "user",
				}),
			),
		}),
		outputSchema: Type.Object({ message: Type.String() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_connector_activate", async (client) => {
				const scope = params.consumerScope ?? "user";
				const message = await client.activateConnector({
					connectorId: params.connectorId,
					consumerScope: scope,
					signal,
				});
				return ok(message, { message }, { connectorId: params.connectorId, consumerScope: scope });
			});
		},
	});

	const mistralConnectorDeactivate = defineTool({
		name: "mistral_connector_deactivate",
		label: "Mistral connector deactivate",
		description: "Deactivate a connector for a consumer scope (user, workspace or organization).",
		parameters: Type.Object({
			connectorId: Type.String({ description: "Connector id (UUID)" }),
			consumerScope: Type.Optional(
				StringEnum(["user", "workspace", "organization"] as const, {
					description: "Scope to deactivate the connector for (defaults to user)",
					default: "user",
				}),
			),
		}),
		outputSchema: Type.Object({ message: Type.String() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_connector_deactivate", async (client) => {
				const scope = params.consumerScope ?? "user";
				const message = await client.deactivateConnector({
					connectorId: params.connectorId,
					consumerScope: scope,
					signal,
				});
				return ok(message, { message }, { connectorId: params.connectorId, consumerScope: scope });
			});
		},
	});

	const mistralConnectorShare = defineTool({
		name: "mistral_connector_share",
		label: "Mistral connector share",
		description: "Share a private connector with the current workspace.",
		parameters: Type.Object({
			connectorId: Type.String({ description: "Connector id (UUID)" }),
		}),
		outputSchema: Type.Object({ message: Type.String() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_connector_share", async (client) => {
				const message = await client.shareConnector({
					connectorId: params.connectorId,
					signal,
				});
				return ok(message, { message }, { connectorId: params.connectorId });
			});
		},
	});

	const mistralConnectorUnshare = defineTool({
		name: "mistral_connector_unshare",
		label: "Mistral connector unshare",
		description: "Unshare a connector from the current workspace.",
		parameters: Type.Object({
			connectorId: Type.String({ description: "Connector id (UUID)" }),
		}),
		outputSchema: Type.Object({ message: Type.String() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_connector_unshare", async (client) => {
				const message = await client.unshareConnector({
					connectorId: params.connectorId,
					signal,
				});
				return ok(message, { message }, { connectorId: params.connectorId });
			});
		},
	});

	return [
		mistralConnectorList,
		mistralConnectorTools,
		mistralConnectorAuthUrl,
		mistralConnectorActivate,
		mistralConnectorDeactivate,
		mistralConnectorShare,
		mistralConnectorUnshare,
	];
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
 * Registers the connector tools with pi, wiring a lazy client factory that
 * resolves the API key per execute call. Tools pass pi's per-call abort
 * signal through to each client request individually.
 */
export function registerConnectorTools(pi: ExtensionAPI): void {
	const getClient = async (ctx: ExtensionToolContext | undefined, _signal?: AbortSignal) => {
		const apiKey = await resolveApiKey(ctx);
		return createMistralClient({ apiKey });
	};
	const tools = createConnectorTools({ getClient });
	for (const tool of tools) {
		pi.registerTool(tool);
	}
}
