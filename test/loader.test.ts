/**
 * Unit tests for the client-side connector tools loader.
 *
 * All HTTP is mocked via injected fetch implementations; no network access
 * and no real API keys ("test-key" literal only). The session_start path is
 * driven through a stub pi object (or the loader session directly); config
 * gating goes through setMistralConfigForTests and is reset after every
 * test so no state leaks between tests.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createMistralClient } from "../extensions/tools/mistral-client.js";
import {
	buildConnectorRegistry,
	connectorNamespaceName,
	connectorToolsEnabled,
	createConnectorLoaderSession,
	createConnectorLoaderTools,
	foldConnectorContent,
	mapConnectorAnnotations,
	registerConnectorLoaderTools,
	setConnectorLoaderTestFetch,
} from "../extensions/tools/loader.js";
import { setMistralConfigForTests } from "../extensions/mistral/config.js";
import type { MistralFileConfig } from "../extensions/mistral/config.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Harness: recording fetch mock (modeled on test/knowledge-tools.test.ts)
// =============================================================================

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	signal?: AbortSignal | undefined;
}

/** Builds a recording fetch mock with a queue of canned responses. */
function createMockFetch() {
	const requests: RecordedRequest[] = [];
	let responseIndex = 0;
	const responses: { status: number; body: string }[] = [];

	const mockFetch = (async (_url: unknown, init?: RequestInit) => {
		const url = String(_url);
		requests.push({
			url,
			method: init?.method ?? "GET",
			headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
			body: init?.body,
			signal: init?.signal ?? undefined,
		});
		const response = responses[responseIndex++];
		if (!response) {
			throw new Error(`unexpected request #${responseIndex - 1} to ${url}`);
		}
		const nullBodyStatus = response.status === 204 || response.status === 304;
		return new Response(nullBodyStatus ? null : response.body, {
			status: response.status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	return {
		mockFetch,
		requests,
		/** Queue a canned response for the next request. */
		respond(status: number, body: unknown) {
			responses.push({ status: status, body: typeof body === "string" ? body : JSON.stringify(body) });
		},
	};
}

// =============================================================================
// Wire fixtures (live-recorded shapes)
// =============================================================================

/** One connector in the live GET /v1/connectors?fetch_user_data=true shape. */
function connectorFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "00000000-0000-0000-0000-000000000000",
		name: "outlook",
		description: "Connects to Microsoft Outlook mail and calendar. Additional capabilities may apply.",
		supports_mcp: true,
		is_authenticated: false,
		...overrides,
	};
}

const CONNECTORS_RESPONSE = {
	items: [
		connectorFixture({
			id: "11111111-1111-1111-1111-111111111111",
			name: "outlook",
			description: "Connects to Microsoft Outlook mail. Read and search messages, drafts, and folders.",
			is_authenticated: true,
			connection_credentials: [
				{
					name: "outlook-cred",
					title: "Outlook credential",
					authentication_type: "oauth2",
					scope: "user",
					status: { status_type: "valid" },
					is_default: true,
				},
			],
		}),
		connectorFixture({
			id: "22222222-2222-2222-2222-222222222222",
			name: "notion",
			description: "Connects to Notion workspaces. Pages, databases, and blocks.",
			is_authenticated: false,
		}),
		connectorFixture({
			id: "33333333-3333-3333-3333-333333333333",
			name: "slack_http",
			description: "Connects to Slack via HTTP. Messages and channels.",
			supports_mcp: false,
			is_authenticated: true,
		}),
		connectorFixture({
			id: "44444444-4444-4444-4444-444444444444",
			name: "sharepoint_mcp",
			description: "Connects to Microsoft SharePoint. Sites, lists, and drive items.",
			is_authenticated: true,
		}),
	],
	pagination: { next_cursor: null, page_size: 1000 },
};

/** MCPTool entries for the tools fixtures (live shapes: anyOf-nullable schema, annotations, missing description). */
const OUTLOOK_TOOLS = [
	{
		name: "search_mail",
		title: "Search mail",
		description: "Search mail messages in folders. Returns matching messages.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				folder: {
					// Mistral's anyOf-nullable idiom.
					anyOf: [{ type: "string" }, { type: "null" }],
					default: null,
				},
			},
			required: ["query"],
		},
		annotations: {
			readOnlyHint: true,
			title: "Search mail",
			extraHint: "not-a-boolean-annotation",
		},
	},
	{
		name: "send_mail",
		title: "Send mail",
		description: "Send a mail message from the authenticated account.",
		inputSchema: {
			type: "object",
			properties: { to: { type: "string" }, body: { type: "string" } },
			required: ["to", "body"],
		},
		annotations: { destructiveHint: false, idempotentHint: true },
	},
	{
		name: "no_description_tool",
		inputSchema: null,
	},
];

// =============================================================================
// Deps and stubs
// =============================================================================

/** A recorded ui notification. */
interface Notification {
	message: string;
	type?: string | undefined;
}

/** Stub ctx: ui.notify + modelRegistry key resolution (session_start shape); apiKey null = no key. */
function stubCtx(notifications: Notification[] = [], apiKey: string | null = "test-key") {
	return {
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, ...(type !== undefined ? { type } : {}) });
			},
		},
		modelRegistry: {
			getApiKeyForProvider: async () => (apiKey === null ? undefined : apiKey),
		},
	} as never;
}

/** A loader test harness bound to a mock fetch. */
interface LoaderHarness {
	tools: ToolDefinition<any, any>[];
	/** All registerTool calls, in order (last registration of a name wins). */
	registered: ToolDefinition<any, any>[];
	active: string[];
	notifications: Notification[];
	mock: ReturnType<typeof createMockFetch>;
	session: ReturnType<typeof createConnectorLoaderSession>;
}

/** The pi built-in tool names a realistic session already has registered. */
const PI_BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/**
 * Builds a loader harness: one loader session bound to recording deps, with
 * the registry primed through the session_start discovery path (the realistic
 * flow — the registry is empty until discovery runs). By default the deps
 * report the pi built-ins as already registered, so name-collision behavior
 * matches a real session.
 */
async function buildLoader(
	mock: ReturnType<typeof createMockFetch>,
	options: {
		initialActive?: string[];
		connectors?: unknown;
		getAllTools?: () => { name: string }[];
		/** session_start reason for the priming discovery (default "startup"). */
		reason?: "startup" | "reload" | "new" | "resume" | "fork";
	} = {},
): Promise<LoaderHarness> {
	mock.respond(200, options.connectors ?? CONNECTORS_RESPONSE);
	const registered: ToolDefinition<any, any>[] = [];
	let active = [...(options.initialActive ?? [])];
	const notifications: Notification[] = [];
	const getClient = async () => createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	const session = createConnectorLoaderSession({
		getClient,
		getActiveTools: () => active,
		setActiveTools: (names) => {
			active = [...names];
		},
		registerTool: (tool) => {
			registered.push(tool);
		},
		...(options.getAllTools !== undefined
			? { getAllTools: options.getAllTools }
			: { getAllTools: () => PI_BUILTINS.map((name) => ({ name })) }),
	});
	await session.onSessionStart(stubCtx(notifications), options.reason ?? "startup");
	return {
		tools: session.tools,
		registered,
		// Getter: the loader reassigns the active array via setActiveTools.
		get active(): string[] {
			return active;
		},
		notifications,
		mock,
		session,
	};
}

/** Finds a tool by name and asserts it exists. */
function toolByName(tools: ToolDefinition<any, any>[], name: string) {
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `tool ${name} must exist`);
	return tool;
}

/** Calls a tool's execute with the standard pi signature (ctx: key-resolving stub context). */
async function execute(
	tool: ToolDefinition<any, any>,
	params: unknown,
	signal?: AbortSignal,
	ctx: unknown = stubCtx([]),
) {
	const result = await tool.execute("call-1", params as never, signal, undefined, ctx as never);
	return result as {
		content: { type: string; text?: string }[];
		structuredContent?: Record<string, unknown>;
		details?: unknown;
		isError?: boolean;
	};
}

/** A tool's registered definition: the LAST registration with that name (re-registration replaces). */
function lastRegistered(harness: LoaderHarness, name: string): ToolDefinition<any, any> {
	const found = [...harness.registered].reverse().find((tool) => tool.name === name);
	assert.ok(found, `registered tool ${name} must exist`);
	return found;
}

/** Drives registerConnectorLoaderTools with a stub pi; returns captured handlers and registrations. */
async function driveSessionStart(options: {
	connectors?: unknown | undefined;
	/** HTTP status of the discovery response (default 200). */
	connectorsStatus?: number | undefined;
	toolsFor?: Record<string, unknown> | undefined;
	env?: Record<string, string | undefined> | undefined;
	config?: MistralFileConfig | null | undefined;
	apiKey?: string | null | undefined;
	active?: string[] | undefined;
}) {
	const previousEnv: Record<string, string | undefined> = {};
	for (const key of Object.keys(options.env ?? {})) {
		previousEnv[key] = process.env[key];
		const value = options.env?.[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (options.config !== undefined) setMistralConfigForTests(options.config);

	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
	const registered: ToolDefinition<any, any>[] = [];
	const notifications: Notification[] = [];
	let active = [...(options.active ?? [])];
	const mock = createMockFetch();
	// Discovery request (+ autoLoad tool-list requests).
	mock.respond(options.connectorsStatus ?? 200, options.connectors ?? CONNECTORS_RESPONSE);
	for (const tools of Object.values(options.toolsFor ?? {})) mock.respond(200, tools);
	setConnectorLoaderTestFetch(mock.mockFetch);

	const stubPi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			handlers[event] = handler;
		},
		registerTool: (tool: ToolDefinition<any, any>) => {
			registered.push(tool);
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		getAllTools: () => PI_BUILTINS.map((name) => ({ name })),
	} as never;
	registerConnectorLoaderTools(stubPi as never);
	const handler = handlers["session_start"];
	assert.ok(handler, "session_start handler must be registered");
	await handler({ type: "session_start", reason: "startup" }, stubCtx(notifications, options.apiKey === undefined ? "test-key" : options.apiKey));

	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return { registered, notifications, active, mock };
}

// Reset test-overridable state around every test so nothing leaks between tests.
beforeEach(() => {
	setConnectorLoaderTestFetch(undefined);
	// null: force "no config file present" so a developer-machine config
	// cannot influence gating; afterEach restores the real merged scopes.
	setMistralConfigForTests(null);
	delete process.env.MISTRAL_CONNECTOR_TOOLS;
});

afterEach(() => {
	setConnectorLoaderTestFetch(undefined);
	setMistralConfigForTests(undefined);
	delete process.env.MISTRAL_CONNECTOR_TOOLS;
});

// =============================================================================
// 1. Namespace/name helpers
// =============================================================================

test("connectorNamespaceName sanitizes: lowercase, dashes and invalid chars to underscores", () => {
	assert.equal(connectorNamespaceName("sharepoint_mcp"), "mistral_cn_sharepoint_mcp");
	assert.equal(connectorNamespaceName("Outlook"), "mistral_cn_outlook");
	assert.equal(connectorNamespaceName("outlook-calendar"), "mistral_cn_outlook_calendar");
	assert.equal(connectorNamespaceName("G-Drive.v2"), "mistral_cn_g_drive_v2");
});

test("createConnectorLoaderTools exposes the three loader tools", () => {
	const tools = createConnectorLoaderTools({
		getClient: async () => createMistralClient({ apiKey: "test-key" }),
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		registerTool: () => undefined,
	});
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["mistral_connector_load", "mistral_connector_unload", "mistral_connector_reload"],
	);
});

// =============================================================================
// 2. Connector list parse
// =============================================================================

test("buildConnectorRegistry: only authenticated supports_mcp connectors are offered", () => {
	const { authenticated, all } = buildConnectorRegistry(CONNECTORS_RESPONSE.items);
	assert.equal(all.length, 3); // slack_http (supports_mcp: false) is dropped
	assert.equal(authenticated.length, 2);
	assert.deepEqual(
		authenticated.map((connector) => connector.name).sort(),
		["outlook", "sharepoint_mcp"],
	);
	// Secret-adjacent credentials never flow into the registry shape.
	for (const connector of all) {
		assert.deepEqual(Object.keys(connector).sort(), ["authenticated", "description", "id", "name"]);
	}
});

test("buildConnectorRegistry: non-empty connection_credentials counts as authenticated when is_authenticated is missing", () => {
	const { authenticated } = buildConnectorRegistry([
		{ id: "a", name: "creds_only", supports_mcp: true, connection_credentials: [{ name: "c" }] },
		{ id: "b", name: "no_flag", supports_mcp: true },
		{ id: "c", name: "empty_creds", supports_mcp: true, connection_credentials: [] },
	]);
	assert.deepEqual(authenticated.map((connector) => connector.name), ["creds_only"]);
});

test("listConnectors fetchUserData flows as fetch_user_data=true; pagination is followed", async () => {
	const mock = createMockFetch();
	mock.respond(200, { items: [connectorFixture({ name: "page1" })], pagination: { next_cursor: "cursor-2", page_size: 1000 } });
	mock.respond(200, { items: [connectorFixture({ name: "page2" })], pagination: { next_cursor: null, page_size: 1000 } });
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	const names: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await client.listConnectors({ cursor, pageSize: 1000, fetchUserData: true });
		names.push(...page.items.map((connector) => connector.name));
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	assert.deepEqual(names, ["page1", "page2"]);
	assert.ok(mock.requests[0]!.url.includes("fetch_user_data=true"), mock.requests[0]!.url);
	assert.ok(mock.requests[0]!.url.includes("page_size=1000"), mock.requests[0]!.url);
	assert.ok(mock.requests[1]!.url.includes("cursor=cursor-2"), mock.requests[1]!.url);
});

// =============================================================================
// 3. Loader registration + activation (incl. collision renames)
// =============================================================================

test("load registers tools with deferred exposure, namespace, and mapped annotations; activates them", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, OUTLOOK_TOOLS);
	await execute(harness.tools[0]!, { connector: "outlook" });

	const search = lastRegistered(harness, "search_mail");
	assert.equal(search.exposure, "deferred");
	assert.equal(search.namespace?.name, "mistral_cn_outlook");
	assert.deepEqual(search.namespace?.aliases, ["outlook"]);
	assert.equal(search.namespace?.description?.includes("3 tools"), true);
	assert.deepEqual(search.annotations, { readOnlyHint: true });

	const send = lastRegistered(harness, "send_mail");
	assert.equal(send.exposure, "deferred");
	assert.deepEqual(send.annotations, { destructiveHint: false, idempotentHint: true });

	// Parameters: the tool's real JSON Schema (anyOf-nullable idiom preserved).
	assert.deepEqual(search.parameters, OUTLOOK_TOOLS[0]!.inputSchema);

	// Activation: active set gains exactly the registered names.
	assert.deepEqual(harness.active, ["search_mail", "send_mail", "no_description_tool"]);
});

test("load with a null inputSchema falls back to an empty object schema; missing description falls back to a generated one", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, OUTLOOK_TOOLS);
	await execute(harness.tools[0]!, { connector: "outlook" });
	const plain = lastRegistered(harness, "no_description_tool");
	// Type.Object({}) fallback: a valid empty object schema.
	assert.equal((plain.parameters as { type?: string }).type, "object");
	assert.equal(plain.description, "Tool no_description_tool from connector outlook");
	assert.equal(plain.label, "no_description_tool");
});

test("load resolves the connector by name or by UUID id", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, OUTLOOK_TOOLS);
	await execute(harness.tools[0]!, { connector: "11111111-1111-1111-1111-111111111111" });
	assert.ok(harness.registered.some((tool) => tool.name === "search_mail"));
});

test("collision rename keeps original names when unique, appends __<connectorName> when colliding across connectors", async () => {
	const harness = await buildLoader(createMockFetch());
	// Load outlook first: original names kept.
	harness.mock.respond(200, [
		{ name: "search_mail", title: "Search", description: "d", inputSchema: { type: "object" } },
	]);
	const first = await execute(harness.tools[0]!, { connector: "outlook" });
	assert.equal(first.isError, undefined);
	assert.ok(harness.registered.some((tool) => tool.name === "search_mail"));
	assert.ok(!harness.registered.some((tool) => tool.name === "search_mail__sharepoint_mcp"));

	// Load sharepoint_mcp with a colliding tool name → renamed.
	harness.mock.respond(200, [
		{ name: "search_mail", title: "SP Search", description: "d2", inputSchema: { type: "object" } },
		{ name: "list_sites", title: "Sites", description: "d3", inputSchema: { type: "object" } },
	]);
	const second = await execute(harness.tools[0]!, { connector: "sharepoint_mcp" });
	assert.equal(second.isError, undefined);
	const text = second.content[0]?.text ?? "";
	assert.ok(text.includes("search_mail__sharepoint_mcp"), `result must note the rename: ${text}`);
	assert.ok(
		text.includes('(name already used)'),
		`result note wording must be cause-neutral: ${text}`,
	);
	assert.ok(harness.registered.some((tool) => tool.name === "search_mail__sharepoint_mcp"));
	assert.ok(harness.registered.some((tool) => tool.name === "list_sites"));
	assert.deepEqual(harness.active, ["search_mail", "search_mail__sharepoint_mcp", "list_sites"]);
});

test("a connector tool named like a pi built-in (read) is renamed and never shadows the built-in", async () => {
	const harness = await buildLoader(createMockFetch(), {
		// Realistic session: pi built-ins read/bash already registered.
		getAllTools: () => [{ name: "read" }, { name: "bash" }],
	});
	harness.mock.respond(200, [
		// `read` and `find` are real sharepoint_mcp tool names (live-verified);
		// `read` collides with pi's built-in read tool.
		{ name: "read", title: "Read file", description: "Read a file from SharePoint.", inputSchema: { type: "object" } },
		{ name: "list_sites", title: "Sites", description: "d", inputSchema: { type: "object" } },
	]);
	const result = await execute(harness.tools[0]!, { connector: "sharepoint_mcp" });
	assert.equal(result.isError, undefined);
	const text = result.content[0]?.text ?? "";
	// Renamed to <original>__<connectorName> and noted in the result.
	assert.ok(text.includes("read__sharepoint_mcp"), `result must note the rename: ${text}`);
	assert.ok(text.includes('tool "read" registered as "read__sharepoint_mcp" (name already used)'), text);
	assert.ok(harness.registered.some((tool) => tool.name === "read__sharepoint_mcp"));
	assert.ok(harness.registered.some((tool) => tool.name === "list_sites"));
	// CRITICAL: the built-in is never shadowed — no registration with a
	// definition named exactly `read` ever reaches pi.
	assert.ok(
		!harness.registered.some((tool) => tool.name === "read"),
		"the loader must never register a tool named exactly like a session tool",
	);
	assert.deepEqual(harness.active, ["read__sharepoint_mcp", "list_sites"]);
});

test("re-loading the same connector stays idempotent: own names are not renamed", async () => {
	const harness = await buildLoader(createMockFetch());
	// First load: search_mail collides with the session's built-in-free name
	// space, so it stays original; it becomes part of the session registry.
	harness.mock.respond(200, [
		{ name: "search_mail", title: "Search", description: "d", inputSchema: { type: "object" } },
	]);
	const first = await execute(harness.tools[0]!, { connector: "outlook" });
	assert.equal(first.isError, undefined);
	assert.ok(harness.registered.some((tool) => tool.name === "search_mail"));

	// Second load of the SAME connector: the previous registration is this
	// loader's own for this very connector — re-registration replaces the
	// definition (refresh semantics) and must NOT trigger a rename.
	harness.mock.respond(200, [
		{ name: "search_mail", title: "Search", description: "d refreshed", inputSchema: { type: "object" } },
	]);
	const second = await execute(harness.tools[0]!, { connector: "outlook" });
	assert.equal(second.isError, undefined);
	const text = second.content[0]?.text ?? "";
	assert.ok(text.includes("- search_mail:"), `name must stay original: ${text}`);
	assert.ok(!text.includes("search_mail__outlook"), `no rename note expected: ${text}`);
	assert.ok(!harness.registered.some((tool) => tool.name === "search_mail__outlook"));
	assert.deepEqual(harness.active, ["search_mail"]);
	// The refreshed description replaced the definition (last wins).
	const refreshed = [...harness.registered].reverse().find((tool) => tool.name === "search_mail");
	assert.equal(refreshed?.description, "d refreshed");
});

test("a colliding name registered by the same connector earlier still renames for a different cause", async () => {
	// After a rename, the renamed name lives in the session registry; a
	// re-load of the same connector keeps idempotency against BOTH the
	// original and the renamed registration.
	const harness = await buildLoader(createMockFetch(), { getAllTools: () => [{ name: "read" }] });
	harness.mock.respond(200, [
		{ name: "read", title: "Read", description: "d", inputSchema: { type: "object" } },
	]);
	const first = await execute(harness.tools[0]!, { connector: "sharepoint_mcp" });
	assert.equal(first.isError, undefined);
	assert.ok(harness.registered.some((tool) => tool.name === "read__sharepoint_mcp"));

	// Re-load: `read` still collides with the built-in (NOT with its own
	// registration — the own registration is read__sharepoint_mcp), so the
	// rename persists and does not double-append.
	harness.mock.respond(200, [
		{ name: "read", title: "Read", description: "d2", inputSchema: { type: "object" } },
	]);
	const second = await execute(harness.tools[0]!, { connector: "sharepoint_mcp" });
	assert.equal(second.isError, undefined);
	assert.ok(!harness.registered.some((tool) => tool.name === "read__sharepoint_mcp__sharepoint_mcp"));
	const readTool = [...harness.registered].reverse().find((tool) => tool.name === "read__sharepoint_mcp");
	assert.equal(readTool?.description, "d2");
});

test("rename target is re-checked: a held <original>__<connector> name bumps to _2", async () => {
	// Simulate another extension/MCP tool already holding the suffixed name
	// `search_mail__outlook`, plus a loaded connector holding `search_mail`.
	const harness = await buildLoader(createMockFetch(), {
		getAllTools: () => [{ name: "search_mail__outlook" }, ...PI_BUILTINS.map((name) => ({ name }))],
	});
	// Load sharepoint_mcp first: it takes `search_mail`.
	harness.mock.respond(200, [
		{ name: "search_mail", title: "SP Search", description: "d", inputSchema: { type: "object" } },
	]);
	const first = await execute(harness.tools[0]!, { connector: "sharepoint_mcp" });
	assert.equal(first.isError, undefined);
	assert.ok(harness.registered.some((tool) => tool.name === "search_mail"));

	// Load outlook: `search_mail` collides with sharepoint's tool, and the
	// first rename candidate `search_mail__outlook` collides with the other
	// extension's tool → the loader bumps to `search_mail__outlook_2`.
	harness.mock.respond(200, [
		{ name: "search_mail", title: "Search", description: "d2", inputSchema: { type: "object" } },
	]);
	const second = await execute(harness.tools[0]!, { connector: "outlook" });
	assert.equal(second.isError, undefined);
	const text = second.content[0]?.text ?? "";
	assert.ok(text.includes("search_mail__outlook_2"), `result must note the bumped rename: ${text}`);
	assert.ok(harness.registered.some((tool) => tool.name === "search_mail__outlook_2"));
	// Neither the other extension's tool nor sharepoint's tool was shadowed.
	assert.ok(!harness.registered.some((tool) => tool.name === "search_mail__outlook"));
	const spSearch = [...harness.registered].reverse().find((tool) => tool.name === "search_mail");
	assert.equal(spSearch?.description, "d", "sharepoint's original registration must be untouched");
});

// =============================================================================
// 3a. Session replacement (/new clears loaded state; resume/fork keep it)
// =============================================================================

test("session replacement with reason new clears loaded state: no spurious renames, unload errors", async () => {
	const mock = createMockFetch();
	const harness = await buildLoader(mock);
	// Previous session: load sharepoint_mcp, whose search_mail takes the name.
	mock.respond(200, [{ name: "search_mail", title: "SP Search", description: "d", inputSchema: { type: "object" } }]);
	await execute(harness.tools[0]!, { connector: "sharepoint_mcp" });
	assert.ok(harness.registered.some((tool) => tool.name === "search_mail"));

	// /new: pi re-fires session_start with reason "new" on the SAME loader
	// instance — the loaded state from the previous session must be cleared.
	mock.respond(200, CONNECTORS_RESPONSE);
	await harness.session.onSessionStart(stubCtx(harness.notifications), "new");

	// (a) A load of outlook with the same tool name must NOT get a spurious
	// `__outlook` rename from the previous session's stale state.
	mock.respond(200, [{ name: "search_mail", title: "Search", description: "d2", inputSchema: { type: "object" } }]);
	const loadResult = await execute(harness.tools[0]!, { connector: "outlook" });
	assert.equal(loadResult.isError, undefined);
	const text = loadResult.content[0]?.text ?? "";
	assert.ok(text.includes("- search_mail:"), `name must stay original after /new: ${text}`);
	assert.ok(!text.includes("search_mail__outlook"), `no rename note expected after /new: ${text}`);
	assert.ok(!harness.registered.some((tool) => tool.name === "search_mail__outlook"));

	// (b) Unloading sharepoint_mcp (loaded only in the PREVIOUS session)
	// must report the no-loaded-tools error, not a fake success.
	const unload = toolByName(harness.tools, "mistral_connector_unload");
	const unloadResult = await execute(unload, { connector: "sharepoint_mcp" });
	assert.equal(unloadResult.isError, true);
	assert.ok((unloadResult.content[0]?.text ?? "").includes("has no loaded tools"));
});

test("session start with reason new clears loaded state even mid-sequence (load survives a prior load)", async () => {
	// Covers the stale-unload-success variant: load one connector, then a
	// /new, then unload that connector → must error (state cleared).
	const mock = createMockFetch();
	const harness = await buildLoader(mock);
	mock.respond(200, [{ name: "ping", title: "Ping", description: "d", inputSchema: { type: "object" } }]);
	await execute(harness.tools[0]!, { connector: "outlook" });
	assert.deepEqual(harness.active, ["ping"]);

	mock.respond(200, CONNECTORS_RESPONSE);
	await harness.session.onSessionStart(stubCtx(harness.notifications), "new");

	const unload = toolByName(harness.tools, "mistral_connector_unload");
	const result = await execute(unload, { connector: "outlook" });
	assert.equal(result.isError, true);
	assert.ok((result.content[0]?.text ?? "").includes("has no loaded tools"));
});

test("session start with reason resume keeps loaded state (names stable, unload works)", async () => {
	const mock = createMockFetch();
	const harness = await buildLoader(mock);
	mock.respond(200, [{ name: "search_mail", title: "Search", description: "d", inputSchema: { type: "object" } }]);
	await execute(harness.tools[0]!, { connector: "outlook" });
	assert.deepEqual(harness.active, ["search_mail"]);

	// /resume: pending transcript tool names must re-activate with stable
	// names — loaded state is NOT cleared.
	mock.respond(200, CONNECTORS_RESPONSE);
	await harness.session.onSessionStart(stubCtx(harness.notifications), "resume");

	// The previously loaded connector still unloads normally.
	const unload = toolByName(harness.tools, "mistral_connector_unload");
	const result = await execute(unload, { connector: "outlook" });
	assert.equal(result.isError, undefined);
	assert.ok((result.content[0]?.text ?? "").startsWith("Unloaded 1 tools from connector outlook"));
	assert.deepEqual(harness.active, []);
});

test("session start with reason fork keeps loaded state", async () => {
	const mock = createMockFetch();
	const harness = await buildLoader(mock);
	mock.respond(200, [{ name: "ping", title: "Ping", description: "d", inputSchema: { type: "object" } }]);
	await execute(harness.tools[0]!, { connector: "outlook" });

	mock.respond(200, CONNECTORS_RESPONSE);
	await harness.session.onSessionStart(stubCtx(harness.notifications), "fork");

	const unload = toolByName(harness.tools, "mistral_connector_unload");
	const result = await execute(unload, { connector: "outlook" });
	assert.equal(result.isError, undefined);
	assert.ok((result.content[0]?.text ?? "").startsWith("Unloaded 1 tools from connector outlook"));
});

test("rename decisions stay stable across a resume re-load (no double suffix)", async () => {
	const mock = createMockFetch();
	const harness = await buildLoader(mock, { getAllTools: () => [{ name: "read" }] });
	mock.respond(200, [{ name: "read", title: "Read", description: "d", inputSchema: { type: "object" } }]);
	await execute(harness.tools[0]!, { connector: "sharepoint_mcp" });
	assert.ok(harness.registered.some((tool) => tool.name === "read__sharepoint_mcp"));

	// /resume then re-load the same connector: stable rename decision — the
	// own-registration exception keeps read__sharepoint_mcp (no _2 bump).
	mock.respond(200, CONNECTORS_RESPONSE);
	await harness.session.onSessionStart(stubCtx(harness.notifications), "resume");
	mock.respond(200, [{ name: "read", title: "Read", description: "d2", inputSchema: { type: "object" } }]);
	const result = await execute(harness.tools[0]!, { connector: "sharepoint_mcp" });
	assert.equal(result.isError, undefined);
	assert.ok(!harness.registered.some((tool) => tool.name === "read__sharepoint_mcp_2"));
	assert.ok(!harness.registered.some((tool) => tool.name === "read__sharepoint_mcp__sharepoint_mcp"));
});

// =============================================================================
// 4. Load result text
// =============================================================================

test("load result text lists each tool name and one-line description", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, OUTLOOK_TOOLS);
	const result = await execute(harness.tools[0]!, { connector: "outlook" });
	const text = result.content[0]?.text ?? "";
	assert.ok(text.startsWith("Loaded 3 tools from connector outlook (now active; usable from the next model request):"), text);
	assert.ok(text.includes("- search_mail:"), text);
	assert.ok(text.includes("- send_mail:"), text);
	assert.ok(text.includes("- no_description_tool:"), text);
	assert.equal(result.structuredContent?.toolCount, 3);
	assert.deepEqual(result.details, { connector: "outlook", toolCount: 3 });
	const tools = result.structuredContent?.tools as { name: string; description?: string }[];
	assert.equal(tools.length, 3);
	assert.equal(tools[0]?.name, "search_mail");
});

test("long tool descriptions are truncated to ~100 chars per line", async () => {
	const longDescription = "A very long tool description sentence. ".repeat(10).trim();
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, [
		{ name: "verbose_tool", description: longDescription, inputSchema: { type: "object" } },
	]);
	const result = await execute(harness.tools[0]!, { connector: "outlook" });
	const line = (result.content[0]?.text ?? "").split("\n").find((part) => part.startsWith("- verbose_tool:"));
	assert.ok(line, "result must list verbose_tool");
	// First sentence only + truncation: far shorter than the raw description.
	assert.ok(line.length <= 110, `line not truncated: ${line.length}`);
});

// =============================================================================
// 5. Unload
// =============================================================================

test("unload re-registers tools as hidden and removes them from the active set", async () => {
	const harness = await buildLoader(createMockFetch(), { initialActive: ["pi_bash"] });
	harness.mock.respond(200, OUTLOOK_TOOLS);
	await execute(harness.tools[0]!, { connector: "outlook" });
	assert.deepEqual(harness.active, ["pi_bash", "search_mail", "send_mail", "no_description_tool"]);

	const unload = toolByName(harness.tools, "mistral_connector_unload");
	const result = await execute(unload, { connector: "outlook" });
	const text = result.content[0]?.text ?? "";
	assert.ok(text.startsWith("Unloaded 3 tools from connector outlook (now hidden and inactive)."), text);
	// The last registration of each tool is the hidden withdraw registration.
	assert.equal(lastRegistered(harness, "search_mail").exposure, "hidden");
	assert.equal(lastRegistered(harness, "send_mail").exposure, "hidden");
	assert.equal(lastRegistered(harness, "no_description_tool").exposure, "hidden");
	assert.deepEqual(harness.active, ["pi_bash"]);
});

test("unload with no loaded tools is an error", async () => {
	const harness = await buildLoader(createMockFetch());
	const unload = toolByName(harness.tools, "mistral_connector_unload");
	const result = await execute(unload, { connector: "notion" });
	assert.equal(result.isError, true);
	assert.ok((result.content[0]?.text ?? "").includes("has no loaded tools"));
});

// =============================================================================
// 6. Reload
// =============================================================================

test("reload refreshes the registry and re-registers the loader with an updated description", async () => {
	const { registered } = await driveSessionStart({});
	const loader = [...registered].reverse().find((tool) => tool.name === "mistral_connector_load");
	assert.ok(loader, "loader tool must be registered at session start");
	assert.ok(loader.description.includes("outlook"), loader.description);
	assert.ok(loader.description.includes("- sharepoint_mcp:"), loader.description);
	assert.ok(!loader.description.includes("- notion:"), "unauthenticated connectors stay unlisted");

	// Reload with a changed registry: notion becomes authenticated.
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, {
		items: [
			connectorFixture({ id: "11111111-1111-1111-1111-111111111111", name: "outlook", is_authenticated: true }),
			connectorFixture({ id: "22222222-2222-2222-2222-222222222222", name: "notion", is_authenticated: true }),
		],
		pagination: { next_cursor: null, page_size: 1000 },
	});
	const reload = toolByName(harness.tools, "mistral_connector_reload");
	const result = await execute(reload, {});
	const text = result.content[0]?.text ?? "";
	assert.ok(text.includes("2 authenticated connector(s)"), text);
	assert.ok(text.includes("Newly authenticated: notion"), text);
	// The re-registered loader definition carries the updated description.
	const reLoader = lastRegistered(harness, "mistral_connector_load");
	assert.ok(reLoader.description.includes("- notion:"), reLoader.description);
});

test("reload reports de-authenticated connectors", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, {
		items: [
			connectorFixture({ id: "11111111-1111-1111-1111-111111111111", name: "outlook", is_authenticated: true }),
		],
		pagination: { next_cursor: null, page_size: 1000 },
	});
	const reload = toolByName(harness.tools, "mistral_connector_reload");
	const result = await execute(reload, {});
	const text = result.content[0]?.text ?? "";
	assert.ok(text.includes("No longer authenticated: sharepoint_mcp"), text);
});

// =============================================================================
// 7. Annotations forwarding
// =============================================================================

test("mapConnectorAnnotations forwards only the boolean hints", () => {
	assert.deepEqual(mapConnectorAnnotations({ readOnlyHint: true, openWorldHint: false, title: "x" }), {
		readOnlyHint: true,
		openWorldHint: false,
	});
	assert.equal(mapConnectorAnnotations({ title: "x" }), undefined);
	assert.equal(mapConnectorAnnotations(undefined), undefined);
	assert.equal(mapConnectorAnnotations(null), undefined);
	assert.equal(mapConnectorAnnotations("read-only"), undefined);
	assert.equal(mapConnectorAnnotations([true]), undefined);
});

test("readOnlyHint true flows into the registered ToolDefinition.annotations", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, OUTLOOK_TOOLS);
	await execute(harness.tools[0]!, { connector: "outlook" });
	const search = lastRegistered(harness, "search_mail");
	assert.deepEqual(search.annotations, { readOnlyHint: true });
});

// =============================================================================
// 8. Content folding + isError
// =============================================================================

test("foldConnectorContent joins text blocks and placeholders non-text blocks", () => {
	assert.equal(
		foldConnectorContent([
			{ type: "text", text: "first" },
			{ type: "image", data: "..." },
			{ type: "text", text: "second" },
			{ type: "resource_link" },
		]),
		"first\n[(image content)]\nsecond\n[(resource_link content)]",
	);
	assert.equal(foldConnectorContent("plain"), "");
	assert.equal(foldConnectorContent(undefined), "");
	assert.equal(foldConnectorContent([]), "");
	// A text block without a text string is malformed → placeholder.
	assert.equal(foldConnectorContent([{ type: "text" }]), "[(text content)]");
});

test("connector tool execute folds content; metadata.mcp_meta.isError marks the result", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, OUTLOOK_TOOLS);
	await execute(harness.tools[0]!, { connector: "outlook" });
	const search = lastRegistered(harness, "search_mail");

	harness.mock.respond(200, {
		content: [
			{ type: "text", text: "part one" },
			{ type: "text", text: "part two" },
			{ type: "image", data: "zzz" },
		],
		metadata: { mcp_meta: { isError: false } },
	});
	const good = await execute(search, { query: "inbox" });
	assert.equal(good.isError, undefined);
	assert.equal(good.content[0]?.text, "part one\npart two\n[(image content)]");
	assert.equal(harness.mock.requests.at(-1)?.method, "POST");
	assert.ok(harness.mock.requests.at(-1)?.url.endsWith("/connectors/11111111-1111-1111-1111-111111111111/tools/search_mail/call"));
	assert.equal((good.details as Record<string, unknown>).connector, "outlook");

	harness.mock.respond(200, {
		content: [{ type: "text", text: "server-side failure" }],
		metadata: { mcp_meta: { isError: true } },
	});
	const bad = await execute(search, { query: "inbox" });
	assert.equal(bad.isError, true);
	assert.equal(bad.content[0]?.text, "server-side failure");
});

test("connector tool execute maps thrown errors to isError with the server message", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, OUTLOOK_TOOLS);
	await execute(harness.tools[0]!, { connector: "outlook" });
	const search = lastRegistered(harness, "search_mail");
	harness.mock.respond(500, { detail: "upstream exploded" });
	const result = await execute(search, { query: "inbox" });
	assert.equal(result.isError, true);
	assert.ok((result.content[0]?.text ?? "").includes("upstream exploded"));
});

// =============================================================================
// 9. Empty arguments
// =============================================================================

test("executing a loaded tool with {} records the request body {\"arguments\":{}}", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, [
		{ name: "ping", title: "Ping", description: "d", inputSchema: { type: "object", properties: {} } },
	]);
	await execute(harness.tools[0]!, { connector: "outlook" });
	const ping = lastRegistered(harness, "ping");
	harness.mock.respond(200, { content: [{ type: "text", text: "pong" }] });
	await execute(ping, {});
	const last = harness.mock.requests.at(-1)!;
	assert.equal(last.body, JSON.stringify({ arguments: {} }));
});

// =============================================================================
// 10. 401 on load
// =============================================================================

test("a 401 on the tools listing fails the load with authenticate guidance", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(401, { detail: "No credentials found for connector 'notion'. Please authenticate." });
	const result = await execute(harness.tools[0]!, { connector: "notion" });
	assert.equal(result.isError, true);
	const text = result.content[0]?.text ?? "";
	assert.ok(text.includes("not authenticated"), text);
	assert.ok(text.includes("mistral_connector_auth_url"), text);
	assert.ok(text.includes("mistral_connector_reload"), text);
});

// =============================================================================
// 11. Config gating
// =============================================================================

test("connectorToolsEnabled: file config wins over env; env 0/false/off disables; default enabled", () => {
	assert.equal(connectorToolsEnabled({}, { connectorTools: { enabled: false, autoLoad: undefined } }), false);
	assert.equal(connectorToolsEnabled({ MISTRAL_CONNECTOR_TOOLS: "0" }, undefined), false);
	assert.equal(connectorToolsEnabled({ MISTRAL_CONNECTOR_TOOLS: "FALSE" }, undefined), false);
	assert.equal(connectorToolsEnabled({ MISTRAL_CONNECTOR_TOOLS: "Off" }, undefined), false);
	assert.equal(connectorToolsEnabled({ MISTRAL_CONNECTOR_TOOLS: "1" }, undefined), true);
	assert.equal(connectorToolsEnabled({ MISTRAL_CONNECTOR_TOOLS: "  " }, undefined), true);
	assert.equal(connectorToolsEnabled({}, undefined), true);
	// File config wins over env in both directions.
	assert.equal(connectorToolsEnabled({ MISTRAL_CONNECTOR_TOOLS: "0" }, { connectorTools: { enabled: true, autoLoad: undefined } }), true);
	assert.equal(connectorToolsEnabled({ MISTRAL_CONNECTOR_TOOLS: "1" }, { connectorTools: { enabled: false, autoLoad: undefined } }), false);
});

test("enabled=false in the file config registers no loader tools at session start", async () => {
	const { registered } = await driveSessionStart({ config: { connectorTools: { enabled: false, autoLoad: undefined } } });
	assert.equal(registered.length, 0);
});

test("MISTRAL_CONNECTOR_TOOLS=0 disables the loader at session start", async () => {
	const { registered } = await driveSessionStart({ env: { MISTRAL_CONNECTOR_TOOLS: "0" }, config: null });
	assert.equal(registered.length, 0);
});

test("a discovery failure registers nothing and notifies a warning; never throws", async () => {
	const { registered, notifications } = await driveSessionStart({ connectors: { detail: "boom" }, connectorsStatus: 500 });
	assert.equal(registered.length, 0);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.type, "warning");
	assert.ok(notifications[0]!.message.includes("connector loader"), notifications[0]!.message);
});

test("no API key at session start registers nothing, silently (unconfigured provider)", async () => {
	// MISTRAL_API_KEY explicitly deleted (restored afterwards) so the env
	// fallback cannot resolve a key on a developer machine that sets it.
	// No credentials = the provider is simply unconfigured: no loader
	// tools AND no warning (a session-start warning would fire in every
	// pi session without a Mistral key).
	const { registered, notifications } = await driveSessionStart({ apiKey: null, env: { MISTRAL_API_KEY: undefined } });
	assert.equal(registered.length, 0);
	assert.equal(notifications.length, 0);
});

test("zero authenticated connectors registers nothing silently", async () => {
	const { registered, notifications } = await driveSessionStart({
		connectors: { items: [connectorFixture({ is_authenticated: false })], pagination: { next_cursor: null } },
	});
	assert.equal(registered.length, 0);
	assert.equal(notifications.length, 0);
});

test("session start registers the three loader tools with dynamic descriptions", async () => {
	const { registered } = await driveSessionStart({});
	assert.deepEqual(
		registered.map((tool) => tool.name),
		["mistral_connector_load", "mistral_connector_unload", "mistral_connector_reload"],
	);
	const loader = registered[0]!;
	assert.ok(loader.description.includes("Call this tool with a connector name"), loader.description);
	assert.ok(loader.description.includes("- outlook:"), loader.description);
	assert.ok(loader.description.includes("- sharepoint_mcp:"), loader.description);
	assert.equal(loader.exposure, undefined); // default direct: model-visible from the next turn
});

test("autoLoad registers and activates the listed authenticated connectors at session start", async () => {
	const { registered, notifications, active } = await driveSessionStart({
		config: { connectorTools: { enabled: undefined, autoLoad: ["outlook", "notion"] } },
		toolsFor: { outlook: OUTLOOK_TOOLS },
	});
	// Three loader tools + the three outlook tools; notion is not authenticated.
	assert.equal(registered.length, 6);
	assert.ok(registered.some((tool) => tool.name === "search_mail"));
	assert.deepEqual(active, ["search_mail", "send_mail", "no_description_tool"]);
	const auto = notifications.filter((entry) => entry.message.startsWith("Auto-loaded"));
	assert.equal(auto.length, 1);
	assert.equal(auto[0]?.type, "info");
	assert.ok(auto[0]!.message.includes("3 tools from connector outlook"), auto[0]!.message);
});

test("autoLoad warns for configured-but-unauthenticated connectors and skips them", async () => {
	const { registered, notifications, active } = await driveSessionStart({
		config: { connectorTools: { enabled: undefined, autoLoad: ["outlook", "notion"] } },
		toolsFor: { outlook: OUTLOOK_TOOLS },
	});
	// notion is configured but NOT authenticated: one skip warning, nothing
	// registered for it (its tool list was never fetched).
	const skipped = notifications.filter(
		(entry) => entry.message.includes("notion") && entry.message.includes("not authenticated"),
	);
	assert.equal(skipped.length, 1, `expected exactly one skip warning: ${JSON.stringify(notifications)}`);
	assert.equal(skipped[0]?.type, "warning");
	assert.ok(skipped[0]!.message.includes("(skipped)"), skipped[0]!.message);
	// outlook still auto-loaded (info notification, tools registered).
	const auto = notifications.filter((entry) => entry.message.startsWith("Auto-loaded"));
	assert.equal(auto.length, 1);
	assert.equal(auto[0]?.type, "info");
	assert.ok(registered.some((tool) => tool.name === "search_mail"));
	assert.ok(!registered.some((tool) => tool.name === "notion"));
	assert.deepEqual(active, ["search_mail", "send_mail", "no_description_tool"]);
});

test("autoLoad with a name not authenticated warns and nothing is registered for it", async () => {
	const { registered, notifications, active } = await driveSessionStart({
		config: { connectorTools: { enabled: undefined, autoLoad: ["notion"] } },
		// No toolsFor entry: notion's tool list must never be fetched.
	});
	assert.equal(notifications.length, 1);
	const warning = notifications[0]!;
	assert.equal(warning.type, "warning");
	assert.ok(warning.message.includes("notion"), warning.message);
	assert.ok(warning.message.includes("is not authenticated (skipped)"), warning.message);
	// Only the three loader tools registered; no notion tools, nothing active.
	assert.equal(registered.length, 3);
	assert.ok(!registered.some((tool) => tool.name === "notion" || tool.name.includes("notion")));
	assert.deepEqual(active, []);
});

test("autoLoad failures notify a warning and continue", async () => {
	const { registered, notifications, active } = await driveSessionStart({
		config: { connectorTools: { enabled: undefined, autoLoad: ["outlook", "sharepoint_mcp"] } },
		toolsFor: {
			outlook: { detail: "No credentials found." },
			sharepoint_mcp: [{ name: "list_sites", inputSchema: { type: "object" } }],
		},
	});
	// sharepoint_mcp still loaded despite outlook's failure.
	assert.ok(registered.some((tool) => tool.name === "list_sites"));
	assert.deepEqual(active, ["list_sites"]);
	const warnings = notifications.filter((entry) => entry.type === "warning");
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0]!.message.includes("outlook"), warnings[0]!.message);
});

test("config gating: enabled=false blocks a non-empty autoLoad list", async () => {
	const { registered, active, notifications } = await driveSessionStart({
		config: { connectorTools: { enabled: false, autoLoad: ["outlook"] } },
		toolsFor: { outlook: OUTLOOK_TOOLS },
	});
	assert.equal(registered.length, 0);
	assert.deepEqual(active, []);
	assert.equal(notifications.length, 0);
});

// =============================================================================
// 12. Defensive tools-response shape
// =============================================================================

test("listConnectorToolsRaw follows an items-array object shape with next_cursor pagination", async () => {
	const mock = createMockFetch();
	mock.respond(200, { items: [{ name: "a", inputSchema: { type: "object" } }], pagination: { next_cursor: "page-2" } });
	mock.respond(200, { items: [{ name: "b", inputSchema: { type: "object" } }], pagination: { next_cursor: null } });
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	const tools = await client.listConnectorToolsRaw({ connectorIdOrName: "outlook" });
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["a", "b"],
	);
	assert.ok(mock.requests[0]!.url.includes("pretty=false"), mock.requests[0]!.url);
	assert.ok(mock.requests[0]!.url.includes("page_size=1000"), mock.requests[0]!.url);
	assert.ok(mock.requests[1]!.url.includes("cursor=page-2"), mock.requests[1]!.url);
});

test("listConnectorToolsRaw accepts a data-array object shape and a bare array", async () => {
	const dataShape = createMockFetch();
	dataShape.respond(200, { data: [{ name: "d1", inputSchema: { type: "object" } }] });
	const client1 = createMistralClient({ apiKey: "test-key", fetchImpl: dataShape.mockFetch });
	assert.equal((await client1.listConnectorToolsRaw({ connectorIdOrName: "outlook" })).length, 1);

	const bare = createMockFetch();
	bare.respond(200, [{ name: "bare", inputSchema: { type: "object" } }]);
	const client2 = createMistralClient({ apiKey: "test-key", fetchImpl: bare.mockFetch });
	assert.equal((await client2.listConnectorToolsRaw({ connectorIdOrName: "outlook" })).length, 1);
	assert.equal(bare.requests.length, 1, "a bare array must not trigger a second page request");
});

test("listConnectorToolsRaw tolerates a null pagination block in an object-shaped response", async () => {
	const mock = createMockFetch();
	// Live bodies may carry `"pagination": null` — reading next_cursor off
	// null must not throw; the tools are still parsed.
	mock.respond(200, { items: [{ name: "a", inputSchema: { type: "object" } }], pagination: null });
	const client = createMistralClient({ apiKey: "test-key", fetchImpl: mock.mockFetch });
	const tools = await client.listConnectorToolsRaw({ connectorIdOrName: "outlook" });
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["a"],
	);
	assert.equal(mock.requests.length, 1, "a null pagination must not trigger a second page request");
});

test("load via a defensive object-shaped tools response registers the tools", async () => {
	const harness = await buildLoader(createMockFetch());
	harness.mock.respond(200, { items: OUTLOOK_TOOLS, pagination: { next_cursor: null } });
	const result = await execute(harness.tools[0]!, { connector: "outlook" });
	assert.equal(result.isError, undefined);
	assert.equal(result.structuredContent?.toolCount, 3);
	assert.ok(harness.registered.some((tool) => tool.name === "send_mail"));
});

// =============================================================================
// Session_start-driven end-to-end: load → call → unload
// =============================================================================

test("session-start loader drives a full load/call/unload cycle", async () => {
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
	const registered: ToolDefinition<any, any>[] = [];
	const notifications: Notification[] = [];
	let active: string[] = [];
	const mock = createMockFetch();
	setConnectorLoaderTestFetch(mock.mockFetch);

	const stubPi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			handlers[event] = handler;
		},
		registerTool: (tool: ToolDefinition<any, any>) => {
			registered.push(tool);
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		getAllTools: () => PI_BUILTINS.map((name) => ({ name })),
	} as never;
	registerConnectorLoaderTools(stubPi as never);
	// Discovery response must be queued before the session_start handler runs.
	mock.respond(200, CONNECTORS_RESPONSE);
	await handlers["session_start"]!({ type: "session_start", reason: "startup" }, stubCtx(notifications));
	assert.deepEqual(
		registered.map((tool) => tool.name),
		["mistral_connector_load", "mistral_connector_unload", "mistral_connector_reload"],
	);

	// Load outlook via the registered loader tool.
	mock.respond(200, OUTLOOK_TOOLS);
	const loader = [...registered].reverse().find((tool) => tool.name === "mistral_connector_load")!;
	const loadResult = await execute(loader, { connector: "outlook" });
	assert.equal(loadResult.isError, undefined);
	assert.deepEqual(active, ["search_mail", "send_mail", "no_description_tool"]);

	// Call a loaded tool.
	mock.respond(200, { content: [{ type: "text", text: "42 messages" }], metadata: { mcp_meta: { isError: false } } });
	const search = [...registered].reverse().find((tool) => tool.name === "search_mail")!;
	const callResult = await execute(search, { query: "inbox" });
	assert.equal(callResult.content[0]?.text, "42 messages");

	// Unload.
	const unload = [...registered].reverse().find((tool) => tool.name === "mistral_connector_unload")!;
	const unloadResult = await execute(unload, { connector: "outlook" });
	assert.ok((unloadResult.content[0]?.text ?? "").startsWith("Unloaded 3 tools from connector outlook"));
	assert.deepEqual(active, []);
});
