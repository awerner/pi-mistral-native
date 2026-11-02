/**
 * Tests for the `mistral-native.json` configuration layer.
 *
 * Covers the user-scope resolution chain (each hop, first existing file
 * wins), the project scope and project-over-user precedence (per-key deep
 * merge), JSON-over-env precedence for the behavioral keys, the
 * config-value protocol (`$VAR`, `${VAR}`, `!cmd`, `$$`/`$!` escapes),
 * strict validation with named-path errors (loader warns, never throws),
 * reserved-and-parsed sections (endpoint incl. the `MISTRAL_REGION` env
 * override, models/knowledge/rag/ocr/connectorTools), protocol resolution
 * of the credential-adjacent fields through the effective config, and the
 * stream integration with a file config injected via
 * `setMistralConfigForTests`.
 *
 * No network access, no real keys. The stream tests reuse the mocked-SSE
 * harness style of test/server-tools.test.ts. Every touched
 * `process.env` key and the effective-config test override are restored in
 * `finally` blocks.
 *
 * ADR 0010 — Configuration via mistral-native.json;
 * ADR 0004 — Mocked-SSE test suite and user docs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Message, TranscriptContext } from "@earendil-works/pi-ai";

import { MISTRAL_BASE_URL, MODELS, applyRegionSurcharge, mistralStreamSimple } from "../extensions/mistral.js";
import {
	CONFIG_FILE_NAME,
	defaultAgentDir,
	getEffectiveEndpoint,
	clearMistralConfigValueCache,
	getEffectiveMistralConfig,
	loadProjectMistralConfig,
	loadUserMistralConfig,
	mergeMistralFileConfigs,
	MISTRAL_REGION_BASE_URLS,
	projectConfigPath,
	resolveConfigValueProtocol,
	resolveMistralRegionBaseUrl,
	resolveProtocolFields,
	setMistralConfigForTests,
	userConfigPaths,
	validateMistralFileConfig,
} from "../extensions/mistral/config.js";
import { parseServerToolsConfig } from "../extensions/mistral/server-tools.js";

// Force the no-file baseline for this suite: each test file runs in its own
// node --test process, so this module-top override keeps every test here
// deterministic regardless of the developer's real mistral-native.json. The
// `finally` restores below re-force `null` (restoring `undefined` would
// re-expose the machine's real merged scopes).
setMistralConfigForTests(null);

// =============================================================================
// Harness helpers
// =============================================================================

/** Injectable readFile recording which paths were probed, serving per-path content. */
function fakeReadFile(files: Record<string, string>): {
	read: (path: string) => string;
	readAttempts: string[];
} {
	const readAttempts: string[] = [];
	return {
		readAttempts,
		read(path: string): string {
			readAttempts.push(path);
			const content = files[path];
			if (content === undefined) {
				const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string };
				error.code = "ENOENT";
				throw error;
			}
			return content;
		},
	};
}

/** Snapshot + restore helper for process.env keys. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const keys = Object.keys(env);
	const previous = keys.map((key) => process.env[key]);
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fn();
	} finally {
		keys.forEach((key, i) => {
			const prior = previous[i];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		});
	}
}

/** A minimal valid config body as a JSON string. */
function json(body: Record<string, unknown>): string {
	return JSON.stringify(body);
}

// =============================================================================
// User-scope resolution chain
// =============================================================================

const HOME_PLACEHOLDER = "/home/test-user";

test("userConfigPaths: ordered chain with PI_CODING_AGENT_DIR, XDG and agent-dir hops", () => {
	const agentDir = "/custom/agent-dir";
	const xdg = "/custom/xdg";
	const paths = userConfigPaths({
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: xdg,
		HOME: HOME_PLACEHOLDER,
	});
	assert.deepEqual(paths, [
		join(agentDir, CONFIG_FILE_NAME),
		join(xdg, "pi", CONFIG_FILE_NAME),
		// Step 3 collapses with step 1 when PI_CODING_AGENT_DIR is set — fine.
		join(agentDir, CONFIG_FILE_NAME),
		join(HOME_PLACEHOLDER, ".pi", CONFIG_FILE_NAME),
	]);
});

test("userConfigPaths: XDG default and legacy hops when env is unset", () => {
	const paths = userConfigPaths({
		PI_CODING_AGENT_DIR: undefined,
		XDG_CONFIG_HOME: undefined,
		HOME: HOME_PLACEHOLDER,
	});
	assert.deepEqual(paths, [
		join(HOME_PLACEHOLDER, ".config", "pi", CONFIG_FILE_NAME),
		join(HOME_PLACEHOLDER, ".pi", "agent", CONFIG_FILE_NAME),
		join(HOME_PLACEHOLDER, ".pi", CONFIG_FILE_NAME),
	]);
});

test("defaultAgentDir: PI_CODING_AGENT_DIR wins, else ~/.pi/agent", () => {
	assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "/x", HOME: HOME_PLACEHOLDER }), "/x");
	assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: undefined, HOME: HOME_PLACEHOLDER }), join(HOME_PLACEHOLDER, ".pi", "agent"));
});

test("loadUserMistralConfig: first existing file in the chain wins", () => {
	const agentDir = "/custom/agent-dir";
	const first = join(agentDir, CONFIG_FILE_NAME);
	const xdgFile = join("/custom/xdg", "pi", CONFIG_FILE_NAME);
	const legacy = join(HOME_PLACEHOLDER, ".pi", CONFIG_FILE_NAME);
	const env = { PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: "/custom/xdg", HOME: HOME_PLACEHOLDER };

	// Only the last hop exists → the legacy file wins.
	let fs = fakeReadFile({ [legacy]: json({ agentId: "legacy-agent" }) });
	let result = loadUserMistralConfig(env, fs.read);
	assert.equal(result.path, legacy);
	assert.equal(result.value?.agentId, "legacy-agent");

	// Two hops exist → the earlier one wins.
	fs = fakeReadFile({
		[xdgFile]: json({ agentId: "xdg-agent" }),
		[legacy]: json({ agentId: "legacy-agent" }),
	});
	result = loadUserMistralConfig(env, fs.read);
	assert.equal(result.path, xdgFile);
	assert.equal(result.value?.agentId, "xdg-agent");

	// PI_CODING_AGENT_DIR hop wins over everything.
	fs = fakeReadFile({
		[first]: json({ agentId: "pi-dir-agent" }),
		[xdgFile]: json({ agentId: "xdg-agent" }),
		[legacy]: json({ agentId: "legacy-agent" }),
	});
	result = loadUserMistralConfig(env, fs.read);
	assert.equal(result.path, first);
	assert.equal(result.value?.agentId, "pi-dir-agent");
});

test("loadUserMistralConfig: each hop is probed in order when earlier ones are missing", () => {
	const agentDir = "/custom/agent-dir";
	const env = { PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: "/custom/xdg", HOME: HOME_PLACEHOLDER };
	const legacy = join(HOME_PLACEHOLDER, ".pi", CONFIG_FILE_NAME);
	const fs = fakeReadFile({ [legacy]: json({}) });
	const result = loadUserMistralConfig(env, fs.read);
	assert.equal(result.path, legacy);
	// The chain probed: PI dir (== agent dir), XDG default, then legacy.
	assert.deepEqual(fs.readAttempts, [
		join(agentDir, CONFIG_FILE_NAME),
		join("/custom/xdg", "pi", CONFIG_FILE_NAME),
		join(agentDir, CONFIG_FILE_NAME),
		legacy,
	]);
});

test("loadUserMistralConfig: no file anywhere → empty result (defaults + env apply)", () => {
	const fs = fakeReadFile({});
	const result = loadUserMistralConfig({ HOME: HOME_PLACEHOLDER }, fs.read);
	assert.equal(result.value, undefined);
	assert.equal(result.path, undefined);
	assert.equal(result.warning, undefined);
});

test("loadProjectMistralConfig: reads <cwd>/.pi/mistral-native.json", () => {
	const cwd = "/project";
	const file = projectConfigPath(cwd);
	assert.equal(file, join(cwd, ".pi", CONFIG_FILE_NAME));
	const fs = fakeReadFile({ [file]: json({ agentId: "project-agent" }) });
	const result = loadProjectMistralConfig(cwd, fs.read);
	assert.equal(result.path, file);
	assert.equal(result.value?.agentId, "project-agent");
	const missing = loadProjectMistralConfig(cwd, fakeReadFile({}).read);
	assert.equal(missing.value, undefined);
	assert.equal(missing.warning, undefined);
});

// =============================================================================
// Merging and precedence
// =============================================================================

test("mergeMistralFileConfigs: project wins per key; user keys survive otherwise", () => {
	const user = {
		serverTools: ["web_search"],
		agentId: "user-agent",
		endpoint: { region: "eu" as const, baseUrl: undefined },
		knowledge: { streaming: true },
	};
	const project = {
		agentId: "project-agent",
		endpoint: { region: "us" as const, baseUrl: "https://eu.example/v1" },
		rag: { streaming: false, defaultLibraryId: "lib-1" },
	};
	const merged = mergeMistralFileConfigs(user, project)!;
	assert.equal(merged.serverTools, user.serverTools, "user-only key survives");
	assert.equal(merged.agentId, "project-agent", "project key wins");
	// Nested section merge: project region wins; user-only knowledge survives.
	assert.equal(merged.endpoint?.region, "us");
	assert.equal(merged.endpoint?.baseUrl, "https://eu.example/v1");
	assert.deepEqual(merged.knowledge, { streaming: true });
	assert.deepEqual(merged.rag, { streaming: false, defaultLibraryId: "lib-1" });
});

test("mergeMistralFileConfigs: undefined sides pass through", () => {
	const only = { agentId: "a" };
	assert.equal(mergeMistralFileConfigs(undefined, only), only);
	assert.equal(mergeMistralFileConfigs(only, undefined), only);
	assert.equal(mergeMistralFileConfigs(undefined, undefined), undefined);
});

test("parseServerToolsConfig: JSON wins over env; env applies when the JSON key is absent", () => {
	withEnv({ MISTRAL_SERVER_TOOLS: "web_search", MISTRAL_CONNECTORS: "notion", MISTRAL_AGENT_ID: "env-agent" }, () => {
		// File config sets all three → file wins.
		let config = parseServerToolsConfig(undefined, {
			serverTools: ["image_generation"],
			connectors: ["confluence"],
			agentId: "file-agent",
		});
		assert.deepEqual(config.serverTools, ["image_generation"]);
		assert.deepEqual(config.connectorIds, ["confluence"]);
		assert.equal(config.agentId, "file-agent");

		// File config sets only serverTools → connectors/agentId fall to env.
		config = parseServerToolsConfig(undefined, { serverTools: ["web_search_premium"] });
		assert.deepEqual(config.serverTools, ["web_search_premium"]);
		assert.deepEqual(config.connectorIds, ["notion"]);
		assert.equal(config.agentId, "env-agent");

		// Empty arrays are defined values: JSON suppresses the env layer.
		config = parseServerToolsConfig(undefined, { serverTools: [] });
		assert.deepEqual(config.serverTools, []);
		assert.equal(config.serverExecutionPossible, true, "env connectors still enable execution");
	});
});

test("parseServerToolsConfig: empty serverTools array in JSON suppresses env-only execution when nothing else is set", () => {
	withEnv({ MISTRAL_SERVER_TOOLS: "web_search" }, () => {
		const config = parseServerToolsConfig(undefined, { serverTools: [] });
		assert.deepEqual(config.serverTools, []);
		assert.equal(config.serverExecutionPossible, false);
	});
});

test("parseServerToolsConfig: env-only regression — one-argument call unchanged", () => {
	withEnv(
		{ MISTRAL_SERVER_TOOLS: "web_search, bogus_tool image_generation", MISTRAL_AGENT_ID: "  spaced-agent  " },
		() => {
			const config = parseServerToolsConfig(undefined);
			assert.deepEqual(config.serverTools, ["web_search", "image_generation"], "unknown values filtered");
			assert.equal(config.agentId, "spaced-agent", "trimmed");
			assert.equal(config.serverExecutionPossible, true);
		},
	);
});

// =============================================================================
// Stream integration (file config injected via setMistralConfigForTests)
// =============================================================================

type RegisteredModel = (typeof MODELS)[number];
type RuntimeModel = RegisteredModel & { provider: string; baseUrl: string };

function makeModel(): RuntimeModel {
	return { ...MODELS[0]!, provider: "mistral-native", baseUrl: MISTRAL_BASE_URL };
}

const CONTEXT: TranscriptContext = {
	messages: [
		{ role: "system", content: "You are a test harness.", timestamp: 1 },
		{ role: "user", content: "What is 2+2? Answer briefly.", timestamp: 2 },
	],
} as unknown as TranscriptContext;

type SseChunk = Record<string, unknown>;

function sseResponse(chunks: SseChunk[]): Response {
	const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chunk = (delta: Record<string, unknown>): SseChunk => ({
	id: "config-1",
	choices: [{ index: 0, delta, finish_reason: null }],
});

const finalChunk = (finishReason: string | null): SseChunk => ({
	id: "config-1",
	choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
});

/** Captures the outgoing request body while streaming mocked SSE chunks. */
async function runCapturedStream(
	chunks: SseChunk[],
	streamOptions: Record<string, unknown> = {},
): Promise<{ events: { type: string }[]; body: Record<string, unknown>; url: string }> {
	let url = "";
	let body: Record<string, unknown> = {};
	const stream = mistralStreamSimple(makeModel() as never, CONTEXT, {
		apiKey: "test-key",
		fetch: async (requestUrl: unknown, init?: RequestInit) => {
			url = String(requestUrl);
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse(chunks);
		},
		maxRetries: 0,
		...streamOptions,
	} as never);
	const events: { type: string }[] = [];
	for await (const event of stream) events.push(event as never);
	const last = events[events.length - 1]!;
	assert.ok(last.type === "done" || last.type === "error", `stream ended with ${last.type}`);
	return { events, body, url };
}

test("stream carries the file config's serverTools and connectors in the request body", async () => {
	setMistralConfigForTests({
		serverTools: ["web_search", "image_generation"],
		connectors: ["notion"],
		agentId: undefined,
	});
	try {
		const { body } = await runCapturedStream([chunk({ role: "assistant", content: "hi" }), finalChunk("stop")]);
		const tools = body.tools as { type: string; connector_id?: string }[];
		assert.deepEqual(tools, [
			{ type: "web_search" },
			{ type: "image_generation" },
			{ type: "connector", connector_id: "notion" },
		]);
	} finally {
		setMistralConfigForTests(null);
	}
});

test("stream switches to agent mode from the file config's agentId", async () => {
	setMistralConfigForTests({ agentId: "file-agent" });
	try {
		const { url, body } = await runCapturedStream([chunk({ role: "assistant", content: "ok" }), finalChunk("stop")]);
		assert.equal(url, `${MISTRAL_BASE_URL}/agents/completions`);
		assert.equal(body.agent_id, "file-agent");
	} finally {
		setMistralConfigForTests(null);
	}
});

test("stream: JSON serverTools wins over env when both are set", async () => {
	setMistralConfigForTests({ serverTools: ["code_interpreter"] });
	try {
		const { body } = await runCapturedStream([chunk({ role: "assistant", content: "" }), finalChunk("stop")], {
			env: { MISTRAL_SERVER_TOOLS: "web_search" },
		});
		const tools = body.tools as { type: string }[];
		assert.deepEqual(tools, [{ type: "code_interpreter" }]);
	} finally {
		setMistralConfigForTests(null);
	}
});

test("stream: null override forces today's env-only behavior", async () => {
	setMistralConfigForTests(null);
	try {
		const { body } = await runCapturedStream([chunk({ role: "assistant", content: "" }), finalChunk("stop")], {
			env: { MISTRAL_SERVER_TOOLS: "web_search" },
		});
		assert.deepEqual(body.tools, [{ type: "web_search" }]);
	} finally {
		setMistralConfigForTests(null);
	}
});

test("null override forces env-only even after a config object was set", () => {
	// A real config object set first proves the null sentinel genuinely
	// forces "no file present" (machine-independent): the effective config
	// must be undefined, so env-only parsing applies.
	setMistralConfigForTests({ serverTools: ["image_generation"], agentId: "file-agent" });
	setMistralConfigForTests(null);
	assert.equal(getEffectiveMistralConfig(), undefined);
	withEnv({ MISTRAL_SERVER_TOOLS: "web_search", MISTRAL_AGENT_ID: "env-agent" }, () => {
		const config = parseServerToolsConfig(process.env, getEffectiveMistralConfig());
		assert.deepEqual(config.serverTools, ["web_search"]);
		assert.equal(config.agentId, "env-agent");
	});
});

// =============================================================================
// Config-value protocol
// =============================================================================

test("resolveConfigValueProtocol: literals pass through unchanged", () => {
	assert.equal(resolveConfigValueProtocol("my-agent", {}), "my-agent");
	assert.equal(resolveConfigValueProtocol("https://api.mistral.ai/v1", {}), "https://api.mistral.ai/v1");
});

test("resolveConfigValueProtocol: $VAR and ${VAR} interpolate the environment", () => {
	const env = { MY_AGENT: "agent-from-var", MY_URL: "https://gateway.example/v1" };
	assert.equal(resolveConfigValueProtocol("$MY_AGENT", env), "agent-from-var");
	assert.equal(resolveConfigValueProtocol("${MY_AGENT}", env), "agent-from-var");
	assert.equal(resolveConfigValueProtocol("prefix-$MY_URL-suffix", env), "prefix-https://gateway.example/v1-suffix");
});

test("resolveConfigValueProtocol: a referenced-but-unset env var resolves to undefined", () => {
	assert.equal(resolveConfigValueProtocol("$DEFINITELY_UNSET_VAR_27", { DEFINITELY_UNSET_VAR_27: undefined }), undefined);
	assert.equal(resolveConfigValueProtocol("keep-$DEFINITELY_UNSET_VAR_27", {}), undefined);
});

test("resolveConfigValueProtocol: $$ and $! escapes resolve to literals", () => {
	assert.equal(resolveConfigValueProtocol("a$$b", {}), "a$b");
	assert.equal(resolveConfigValueProtocol("a$!b", {}), "a!b");
	assert.equal(resolveConfigValueProtocol("$$HOME", { HOME: "/x" }), "$HOME", "$$ escapes, no interpolation");
});

test("resolveConfigValueProtocol: !command executes the shell command and trims stdout", () => {
	assert.equal(resolveConfigValueProtocol("!echo command-result", {}), "command-result");
	assert.equal(resolveConfigValueProtocol("!printf 'padded   '", {}), "padded", "stdout trimmed");
	assert.equal(resolveConfigValueProtocol("!exit 1", {}), undefined, "command failure resolves to undefined");
	assert.equal(resolveConfigValueProtocol("!definitely-not-a-real-command-27", {}), undefined);
});

test("resolveConfigValueProtocol: !command results are cached for the process lifetime", () => {
	// A node-based counting command (not echo/printf) so the append count is
	// deterministic evidence of how often the command actually ran.
	const marker = join(tmpdir(), `mistral-cmd-cache-${process.pid}-${Date.now()}.txt`);
	const command = `node -e "require('fs').appendFileSync('${marker}', 'x')"`;
	try {
		clearMistralConfigValueCache();
		resolveConfigValueProtocol(`!${command}`, {});
		resolveConfigValueProtocol(`!${command}`, {});
		assert.equal(readFileSync(marker, "utf-8"), "x", "second resolve served from the cache");

		clearMistralConfigValueCache();
		resolveConfigValueProtocol(`!${command}`, {});
		assert.equal(readFileSync(marker, "utf-8"), "xx", "cache cleared → command runs again");
	} finally {
		rmSync(marker, { force: true });
		clearMistralConfigValueCache();
	}
});

// =============================================================================
// Strict validation (loader warns, never throws)
// =============================================================================

const VALIDATION_PATH = join(tmpdir(), "validation", CONFIG_FILE_NAME);

function validateWarning(raw: string): string {
	const { value, warning } = (() => {
		const fs = fakeReadFile({ [VALIDATION_PATH]: raw });
		return loadUserMistralConfig({ HOME: HOME_PLACEHOLDER, PI_CODING_AGENT_DIR: join(tmpdir(), "validation") }, fs.read);
	})();
	assert.equal(value, undefined, "an invalid file must not produce a config value");
	assert.ok(warning, "an invalid file must produce a warning");
	return warning!;
}

test("validation: unknown top-level field names the field, file and known fields (alphabetical)", () => {
	const warning = validateWarning(json({ serverToolss: [] }));
	assert.equal(
		warning,
		`unknown field "serverToolss" in ${VALIDATION_PATH}; known fields: agentId, connectorTools, connectors, endpoint, knowledge, models, ocr, rag, serverTools`,
	);
});

test("validation: unknown key inside a section uses the section-qualified path", () => {
	const warning = validateWarning(json({ endpoint: { regiion: "global" } }));
	assert.equal(warning, `unknown field "endpoint.regiion" in ${VALIDATION_PATH}; known fields: baseUrl, region`);
});

test("validation: invalid enum names the key, file and valid options", () => {
	const warning = validateWarning(json({ endpoint: { region: "moon" } }));
	assert.equal(
		warning,
		`field "endpoint.region" in ${VALIDATION_PATH} must be one of: "global", "eu", "us"; got "moon"`,
	);
});

test("validation: serverTools must be an array of known tool names", () => {
	let warning = validateWarning(json({ serverTools: "web_search" }));
	assert.equal(
		warning,
		`field "serverTools" in ${VALIDATION_PATH} must be an array of strings; known tools: web_search, web_search_premium, image_generation, code_interpreter`,
	);
	warning = validateWarning(json({ serverTools: ["web_search", "bogus"] }));
	assert.equal(
		warning,
		`field "serverTools" in ${VALIDATION_PATH} must be one of: "web_search", "web_search_premium", "image_generation", "code_interpreter" (per entry); got "bogus"`,
	);
});

test("validation: invalid types and negative rate-card numbers name the exact key", () => {
	let warning = validateWarning(json({ agentId: 42 }));
	assert.equal(warning, `field "agentId" in ${VALIDATION_PATH} must be a string; got 42`);
	warning = validateWarning(json({ models: { rateCard: [{ match: "m", rates: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }] } }));
	assert.equal(warning, `field "models.rateCard[0].rates.input" in ${VALIDATION_PATH} must be a non-negative number`);
	warning = validateWarning(json({ rag: { streaming: "yes" } }));
	assert.equal(warning, `field "rag.streaming" in ${VALIDATION_PATH} must be a boolean; got "yes"`);
});

test("validation: malformed JSON produces a parse error naming the path", () => {
	const warning = validateWarning("{\"agentId\": \"x\",}");
	assert.ok(warning.startsWith(`failed to parse ${VALIDATION_PATH}: `), `unexpected warning: ${warning}`);
	assert.ok(warning.includes("property name in JSON"), `parse failure surfaced: ${warning}`);
});

test("validation: a non-object JSON root is rejected", () => {
	const warning = validateWarning("[\"agentId\"]");
	assert.equal(warning, `failed to parse ${VALIDATION_PATH}: the file must contain a JSON object`);
});

test("validation: JSON null is an error, not unset", () => {
	const warning = validateWarning(json({ serverTools: null }));
	assert.equal(warning, `field "serverTools" in ${VALIDATION_PATH} must not be null; omit the key to leave it unset`);
});

test("loader: validation and read errors surface as warnings, never throw", () => {
	const file = join(HOME_PLACEHOLDER, ".pi", "mistral-native.json");
	const env = { HOME: HOME_PLACEHOLDER, PI_CODING_AGENT_DIR: undefined, XDG_CONFIG_HOME: undefined };
	// Read error other than ENOENT: the first hop that throws aborts the
	// chain with a warning (the chain does not skip unreadable hops —
	// a broken file must be visible, not silently bypassed).
	const denied = loadUserMistralConfig(env, (path: string): string => {
		const error = new Error(`EACCES: permission denied, open '${path}'`) as Error & { code: string };
		error.code = "EACCES";
		throw error;
	});
	assert.equal(denied.value, undefined);
	const firstHop = join(HOME_PLACEHOLDER, ".config", "pi", CONFIG_FILE_NAME);
	assert.ok(denied.warning?.startsWith(`failed to read ${firstHop}: `), `unexpected warning: ${denied.warning}`);
});

// =============================================================================
// Reserved-and-parsed sections round-trip onto the resolved config
// =============================================================================

test("validation: a complete valid file round-trips every section", () => {
	const body = {
		serverTools: ["web_search_premium"],
		connectors: ["notion", "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f"],
		agentId: "  my-agent  ",
		endpoint: { region: "eu", baseUrl: "https://api.eu.mistral.ai/v1" },
		connectorTools: { enabled: true, autoLoad: ["notion"] },
		models: {
			rateCard: [{ match: "mistral-large", rates: { input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0 } }],
			fallThrough: true,
		},
		knowledge: { streaming: true },
		rag: { streaming: false, defaultLibraryId: "lib-id" },
		ocr: { defaultModel: "mistral-ocr-latest" },
	};
	const { config, error } = validateMistralFileConfig(body, VALIDATION_PATH);
	assert.equal(error, undefined);
	assert.ok(config);
	assert.deepEqual(config.serverTools, ["web_search_premium"]);
	assert.deepEqual(config.connectors, ["notion", "8b6b3f2e-9f4a-4a1e-9c1e-0a2b3c4d5e6f"]);
	assert.equal(config.agentId, "my-agent", "agentId trimmed");
	assert.deepEqual(config.endpoint, { region: "eu", baseUrl: "https://api.eu.mistral.ai/v1" });
	assert.deepEqual(config.connectorTools, { enabled: true, autoLoad: ["notion"] });
	assert.deepEqual(config.models, {
		rateCard: [{ match: "mistral-large", rates: { input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0 } }],
		fallThrough: true,
	});
	assert.deepEqual(config.knowledge, { streaming: true });
	assert.deepEqual(config.rag, { streaming: false, defaultLibraryId: "lib-id" });
	assert.deepEqual(config.ocr, { defaultModel: "mistral-ocr-latest" });
});

test("validation: absent keys stay undefined (unset), empty-after-trim agentId is unset", () => {
	const { config } = validateMistralFileConfig({ agentId: "   " }, VALIDATION_PATH);
	assert.ok(config);
	assert.equal(config.agentId, undefined);
	assert.equal(config.serverTools, undefined);
	assert.equal(config.endpoint, undefined);
});

test("validation: endpoint with only baseUrl parses with region unset", () => {
	const { config } = validateMistralFileConfig({ endpoint: { baseUrl: "https://api.eu.mistral.ai/v1" } }, VALIDATION_PATH);
	assert.ok(config);
	assert.deepEqual(config.endpoint, { region: undefined, baseUrl: "https://api.eu.mistral.ai/v1" });
});

test("getEffectiveEndpoint: JSON region wins over MISTRAL_REGION; env applies when JSON is absent", () => {
	withEnv({ MISTRAL_REGION: "us" }, () => {
		// JSON region set → JSON wins, env does not apply.
		let endpoint = getEffectiveEndpoint(process.env, { endpoint: { region: "eu", baseUrl: undefined } });
		assert.equal(endpoint.region, "eu");
		// JSON endpoint section present without region → env applies.
		endpoint = getEffectiveEndpoint(process.env, { endpoint: { region: undefined, baseUrl: undefined } });
		assert.equal(endpoint.region, "us");
		// No endpoint section at all → env applies.
		endpoint = getEffectiveEndpoint(process.env, {});
		assert.equal(endpoint.region, "us");
	});
	withEnv({ MISTRAL_REGION: undefined }, () => {
		// No JSON, no env → default "global".
		const endpoint = getEffectiveEndpoint(process.env, undefined);
		assert.equal(endpoint.region, "global");
		assert.equal(endpoint.baseUrl, undefined);
	});
});

test("getEffectiveEndpoint: an invalid MISTRAL_REGION value is ignored (default global)", () => {
	withEnv({ MISTRAL_REGION: "moon" }, () => {
		assert.equal(getEffectiveEndpoint(process.env, undefined).region, "global");
	});
});

// =============================================================================
/*
 * Region resolution and the +10% surcharge.
 * ADR 0012 — Selectable region endpoint with per-family routing
 */
// =============================================================================

test("MISTRAL_REGION_BASE_URLS maps every region, each with the /v1 suffix baked in", () => {
	assert.deepEqual(MISTRAL_REGION_BASE_URLS, {
		global: "https://api.mistral.ai/v1",
		eu: "https://api.eu.mistral.ai/v1",
		us: "https://api.us.mistral.ai/v1",
	});
	for (const url of Object.values(MISTRAL_REGION_BASE_URLS)) {
		assert.match(url, /\/v1$/);
	}
});

test("resolveMistralRegionBaseUrl: all three regions map, default global, empty baseUrl treated as unset", () => {
	assert.equal(resolveMistralRegionBaseUrl({ region: "global", baseUrl: undefined }), "https://api.mistral.ai/v1");
	assert.equal(resolveMistralRegionBaseUrl({ region: "eu", baseUrl: undefined }), "https://api.eu.mistral.ai/v1");
	assert.equal(resolveMistralRegionBaseUrl({ region: "us", baseUrl: undefined }), "https://api.us.mistral.ai/v1");
	// Empty/whitespace baseUrl falls through to the region mapping.
	assert.equal(resolveMistralRegionBaseUrl({ region: "eu", baseUrl: "" }), "https://api.eu.mistral.ai/v1");
	assert.equal(resolveMistralRegionBaseUrl({ region: "us", baseUrl: "   " }), "https://api.us.mistral.ai/v1");
});

test("resolveMistralRegionBaseUrl: an explicit baseUrl wins over the region mapping", () => {
	assert.equal(resolveMistralRegionBaseUrl({ region: "us", baseUrl: "https://gateway.example/v1" }), "https://gateway.example/v1");
	assert.equal(resolveMistralRegionBaseUrl({ region: "global", baseUrl: "https://gateway.example/v1" }), "https://gateway.example/v1");
	// baseUrlOverride wins over both region and endpoint.baseUrl.
	assert.equal(
		resolveMistralRegionBaseUrl({ region: "eu", baseUrl: "https://gateway.example/v1" }, "https://override.example/v1"),
		"https://override.example/v1",
	);
	assert.equal(resolveMistralRegionBaseUrl({ region: "eu", baseUrl: undefined }, "https://override.example/v1"), "https://override.example/v1");
	// Empty-string override is unset: the endpoint resolution applies.
	assert.equal(resolveMistralRegionBaseUrl({ region: "eu", baseUrl: undefined }, ""), "https://api.eu.mistral.ai/v1");
	// A whitespace-only override is unset, symmetric with endpoint.baseUrl.
	assert.equal(resolveMistralRegionBaseUrl({ region: "eu", baseUrl: undefined }, "   "), "https://api.eu.mistral.ai/v1");
});

test("resolveMistralRegionBaseUrl: a default getEffectiveEndpoint result resolves the global URL", () => {
	// getEffectiveEndpoint defaults region to "global" and leaves baseUrl
	// undefined — the resolver must return the global URL.
	const endpoint = getEffectiveEndpoint({ MISTRAL_REGION: undefined }, undefined);
	assert.deepEqual(endpoint, { region: "global", baseUrl: undefined });
	assert.equal(resolveMistralRegionBaseUrl(endpoint), "https://api.mistral.ai/v1");
});

test("resolveMistralRegionBaseUrl: JSON region wins over MISTRAL_REGION; env applies when JSON is absent (through the resolver)", () => {
	withEnv({ MISTRAL_REGION: "us" }, () => {
		// JSON region set → JSON wins.
		assert.equal(
			resolveMistralRegionBaseUrl(getEffectiveEndpoint(process.env, { endpoint: { region: "eu", baseUrl: undefined } })),
			"https://api.eu.mistral.ai/v1",
		);
		// JSON endpoint section without region → env applies.
		assert.equal(
			resolveMistralRegionBaseUrl(getEffectiveEndpoint(process.env, { endpoint: { region: undefined, baseUrl: undefined } })),
			"https://api.us.mistral.ai/v1",
		);
		// No JSON at all → env applies.
		assert.equal(resolveMistralRegionBaseUrl(getEffectiveEndpoint(process.env, undefined)), "https://api.us.mistral.ai/v1");
	});
	withEnv({ MISTRAL_REGION: undefined }, () => {
		// No JSON, no env → global.
		assert.equal(resolveMistralRegionBaseUrl(getEffectiveEndpoint(process.env, undefined)), MISTRAL_BASE_URL);
	});
});

test("applyRegionSurcharge multiplies all four fields and rounds to 4 decimals (pure)", () => {
	const rates = { input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0.12345 };
	const surcharged = applyRegionSurcharge(rates);
	// Multiplier over all four fields, rounded to 4 decimals.
	assert.equal(surcharged.input, 0.748);
	assert.equal(surcharged.output, 2.299);
	assert.equal(surcharged.cacheRead, 0.077);
	assert.equal(surcharged.cacheWrite, Math.round(0.12345 * 1.1 * 10000) / 10000);
	// Purity: the input object is not mutated.
	assert.deepEqual(rates, { input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0.12345 });
});

test("applyRegionSurcharge is the identity for the DEFAULT_RATES zero-cost cacheWrite", () => {
	// 0 × 1.1 stays exactly 0 (the surcharge keeps zero-rate fields at zero).
	assert.equal(applyRegionSurcharge({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }).cacheWrite, 0);
});

// =============================================================================
// Protocol resolution through the effective config
// =============================================================================

test("resolveProtocolFields: agentId and baseUrl resolve through the config-value protocol", () => {
	const env = { MISTRAL_AGENT: "protocol-agent" };
	const resolved = resolveProtocolFields(
		{
			serverTools: undefined,
			connectors: undefined,
			agentId: "$MISTRAL_AGENT",
			endpoint: { region: "global", baseUrl: "!echo https://gateway.example/v1" },
			connectorTools: undefined,
			models: undefined,
			knowledge: undefined,
			rag: undefined,
			ocr: undefined,
		},
		env,
	);
	assert.equal(resolved?.agentId, "protocol-agent");
	assert.equal(resolved?.endpoint?.baseUrl, "https://gateway.example/v1");
	assert.equal(resolved?.endpoint?.region, "global", "endpoint untouched by protocol");
});

test("resolveProtocolFields: unset referenced env vars leave the field unset; undefined passes through", () => {
	const resolved = resolveProtocolFields({ agentId: "$NEVER_SET_VAR_27" }, {});
	assert.equal(resolved?.agentId, undefined);
	assert.equal(resolveProtocolFields(undefined, {}), undefined);
});

test("resolveProtocolFields: literal values pass through unchanged", () => {
	const resolved = resolveProtocolFields({ agentId: "plain-agent" }, {});
	assert.equal(resolved?.agentId, "plain-agent");
});

test("effective config resolves the protocol over agentId/baseUrl when consumed", async () => {
	// The effective config applies the config-value protocol over the
	// credential-adjacent fields against process.env when built.
	const envName = `MISTRAL_TEST_AGENT_${Date.now()}`;
	process.env[envName] = "injected-agent";
	try {
		setMistralConfigForTests({ agentId: `$${envName}` });
		try {
			const { url, body } = await runCapturedStream([chunk({ role: "assistant", content: "ok" }), finalChunk("stop")]);
			assert.equal(url, `${MISTRAL_BASE_URL}/agents/completions`);
			assert.equal(body.agent_id, "injected-agent", "$VAR agentId resolved through the effective config");
		} finally {
			setMistralConfigForTests(null);
		}
	} finally {
		delete process.env[envName];
	}
});
