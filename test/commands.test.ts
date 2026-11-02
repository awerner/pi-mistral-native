/**
 * Tests for the `/mistral` command family: status-card
 * provenance, user-scope-only set (atomic write-then-verify, no speculative
 * creation, first-set minimal file), the Usage error for unknown keys, the
 * live test's named failing steps (auth/network/http/ok), and the env-only
 * regression. No network, no real keys; file seams are injected.
 *
 * ADR 0016 — /mistral command family: show, set, test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userConfigPaths } from "../extensions/mistral/config.js";
import {
	type CommandContext,
	loadMistralScopes,
	buildStatusCard,
	setUserConfigKey,
	setUserConfigTargetPath,
	verifySetResult,
	runMistralTest,
	mistralArgumentCompletions,
	handleMistralCommand,
} from "../extensions/mistral/commands.js";

// --- scope fixtures: a tiny in-memory file chain via injected seams ------

interface MemoryFs {
	files: Map<string, string>;
}

/**
 * Hermetic env bag: config.ts reads `env?.[name] || process.env[name]`, so
 * explicit `undefined` would fall through to the LIVE process env — use a
 * non-empty sentinel dir instead so the chain head is fully test-controlled.
 */
const SENTINEL_DIR = "/nonexistent-sentinel-for-hermetic-tests";

function memoryEnv(fs: MemoryFs, home: string): Record<string, string | undefined> {
	void fs;
	return { HOME: home, PI_CODING_AGENT_DIR: SENTINEL_DIR, XDG_CONFIG_HOME: SENTINEL_DIR };
}

function memoryRead(fs: MemoryFs) {
	return (path: string): string => {
		if (!fs.files.has(path)) throw new Error("ENOENT: " + path);
		return fs.files.get(path)!;
	};
}

function memoryExists(fs: MemoryFs) {
	return (path: string): boolean => fs.files.has(path);
}

function memoryWrite(fs: MemoryFs) {
	return (path: string, text: string): void => {
		fs.files.set(path, text);
	};
}

/** Default: no file anywhere in the chain (env-only). */
function emptyFs(): MemoryFs {
	return { files: new Map() };
}

const HOME = "/home/test-user";

// --- target resolution ----------------------------------------------------

test("set target: no file exists -> chain head (agent dir with PI_CODING_AGENT_DIR)", () => {
	const env = { HOME: HOME, PI_CODING_AGENT_DIR: "/tmp/agent", XDG_CONFIG_HOME: "" };
	const fs = emptyFs();
	assert.equal(setUserConfigTargetPath(env, memoryExists(fs)), "/tmp/agent/mistral-native.json");
});

test("set target: no file, no PI_CODING_AGENT_DIR -> XDG head", () => {
	const env = { HOME: HOME, PI_CODING_AGENT_DIR: "", XDG_CONFIG_HOME: "/tmp/xdg" };
	const fs = emptyFs();
	assert.equal(setUserConfigTargetPath(env, memoryExists(fs)), "/tmp/xdg/pi/mistral-native.json");
});

test("set target: first existing file wins over the chain head", () => {
	const env = { HOME: HOME, PI_CODING_AGENT_DIR: "", XDG_CONFIG_HOME: "" };
	const fs = emptyFs();
	const legacy = `${HOME}/.pi/mistral-native.json`;
	fs.files.set(legacy, "{}");
	assert.equal(setUserConfigTargetPath(env, memoryExists(fs)), legacy);
});

// --- set: write behavior --------------------------------------------------

test("first set creates a minimal file with only the written key", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	setUserConfigKey("endpoint.region", "eu", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as Record<string, unknown>;
	assert.deepEqual(written, { endpoint: { region: "eu" } });
});

test("set merges into an existing file without touching other keys", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ agentId: "my-agent", serverTools: ["web_search"] }));
	setUserConfigKey("endpoint.region", "us", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as Record<string, unknown>;
	assert.deepEqual(written, { agentId: "my-agent", serverTools: ["web_search"], endpoint: { region: "us" } });
});

test("set a nested key preserves sibling section keys", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ endpoint: { baseUrl: "https://gw.example/v1" } }));
	setUserConfigKey("endpoint.region", "eu", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as { endpoint: Record<string, unknown> };
	assert.deepEqual(written.endpoint, { baseUrl: "https://gw.example/v1", region: "eu" });
});

test("set refuses invalid JSON in the existing file (no write)", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, "{ not json");
	const before = fs.files.get(target);
	assert.throws(
		() => setUserConfigKey("agentId", "x", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/not valid JSON.*fix the file by hand/,
	);
	assert.equal(fs.files.get(target), before);
});

test("set refuses an existing file that fails validation (no write)", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ unknownField: true }));
	assert.throws(
		() => setUserConfigKey("agentId", "x", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/unknown field.*fix the file by hand/,
	);
});

test("set validates the value before writing (bad region: no file created)", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	assert.throws(
		() => setUserConfigKey("endpoint.region", "moon", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/must be global, eu or us/,
	);
	assert.equal(fs.files.size, 0);
});

test("set unknown key -> Usage error listing settable keys", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	assert.throws(
		() => setUserConfigKey("endpoint.regiion", "eu", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/Usage: \/mistral set <key> <value>[\s\S]*Settable keys:/,
	);
});

test("set models.rateCard is rejected with a hand-edit pointer", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	assert.throws(
		() => setUserConfigKey("models.rateCard", "x", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/models\.rateCard is not settable here.*hand-edit/,
	);
});

test("set list key accepts comma-separated values", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	setUserConfigKey("serverTools", "web_search, code_interpreter", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as { serverTools: string[] };
	assert.deepEqual(written.serverTools, ["web_search", "code_interpreter"]);
});

test("set empty list value clears to []", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	setUserConfigKey("serverTools", "", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as { serverTools: string[] };
	assert.deepEqual(written.serverTools, []);
});

test("set empty string value for a plain string key is refused", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	assert.throws(
		() => setUserConfigKey("agentId", "  ", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/empty; unset it by editing the file/,
	);
});

test("set boolean key accepts true/false case-insensitively", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	setUserConfigKey("rag.streaming", "FALSE", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as { rag: { streaming: boolean } };
	assert.equal(written.rag.streaming, false);
});

// --- verify + provenance + status card ------------------------------------

test("verify: written key took when nothing shadows it", () => {
	const user = { value: { agentId: "my-agent" }, path: "/u/mistral-native.json", warning: undefined };
	const scopes = { user, project: { value: undefined, path: undefined, warning: undefined } };
	const result = verifySetResult(scopes, "agentId");
	assert.equal(result.ok, true);
	assert.match(result.message, /Saved: agentId = my-agent \(user scope\)/);
});

test("verify: a project key shadowing the written key is reported", () => {
	const user = { value: { agentId: "from-user" }, path: "/u/mistral-native.json", warning: undefined };
	const project = { value: { agentId: "from-project" }, path: "/p/.pi/mistral-native.json", warning: undefined };
	const result = verifySetResult({ user, project }, "agentId");
	assert.equal(result.ok, true);
	assert.match(result.message, /project-scope value shadows it/);
	assert.match(result.message, /effective here: from-project/);
});

test("verify: an unset re-read reports did-not-take", () => {
	const scopes = { user: { value: undefined, path: undefined, warning: undefined }, project: { value: undefined, path: undefined, warning: undefined } };
	const result = verifySetResult(scopes, "agentId");
	assert.equal(result.ok, false);
	assert.match(result.message, /did not take/);
});

test("status card shows provenance per source layer", () => {
	const fs = emptyFs();
	const env = {
		...memoryEnv(fs, HOME),
		MISTRAL_AGENT_ID: "agent-from-env",
		// Pin the region so an ambient MISTRAL_REGION cannot flip the
		// default-region provenance line.
		MISTRAL_REGION: "",
	};
	const user = { value: { connectors: ["notion"] }, path: "/u/mistral-native.json", warning: undefined };
	const project = { value: { serverTools: ["web_search"] }, path: "/p/.pi/mistral-native.json", warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, env);
	assert.match(card, /Server-side tools: web_search  \[project file \/p\/\.pi\/mistral-native\.json\]/);
	assert.match(card, /Connectors: notion  \[user file \/u\/mistral-native\.json\]/);
	assert.match(card, /Agent id: agent-from-env  \[env MISTRAL_AGENT_ID\]/);
	assert.match(card, /RAG default library: unset  \[unset\]/);
	assert.match(card, /Region: global  \[default\]/);
	// web_search is rejected by chat completions: the card names it.
	assert.match(card, /\(web_search do not run in chat completions — use the mistral_web_search tool for web search; see docs\/server-tools\.md\)/);
});

test("status card shows the Web search model row with default provenance", () => {
	const fs = emptyFs();
	const env = { ...memoryEnv(fs, HOME), MISTRAL_REGION: "" };
	const user = { value: undefined, path: undefined, warning: undefined };
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, env);
	// No file sets the key: the effective default shows with default provenance.
	assert.match(card, /Web search model: mistral-small-latest  \[default\]/);
});

test("status card: a user-file knowledge.searchModel shows with file provenance; /mistral set writes it", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	// Status card: user-file provenance.
	const user = { value: { knowledge: { streaming: undefined, searchModel: "mistral-medium-latest" } }, path: "/u/mistral-native.json", warning: undefined };
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, { ...env, MISTRAL_REGION: "" });
	assert.match(card, /Web search model: mistral-medium-latest  \[user file \/u\/mistral-native\.json\]/);
	// Set-map: the key is settable as a string kind (mirrors rag.defaultLibraryId).
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	setUserConfigKey("knowledge.searchModel", "mistral-medium-latest", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as { knowledge: { searchModel: string } };
	assert.equal(written.knowledge.searchModel, "mistral-medium-latest");
	// Completion offers the key.
	const items = mistralArgumentCompletions("set knowledge.");
	assert.ok(items.some((item) => item.value === "knowledge.searchModel"), "key must be offered");
});

test("status card: no server-tools footnote when the configured set is supported", () => {
	const fs = emptyFs();
	const env = {
		...memoryEnv(fs, HOME),
		MISTRAL_SERVER_TOOLS: "image_generation",
		MISTRAL_REGION: "",
	};
	const user = { value: undefined, path: undefined, warning: undefined };
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, env);
	assert.doesNotMatch(card, /do not run in chat completions/);
	assert.doesNotMatch(card, /mistral_web_search/);
});

test("status card: auth shows the source label, never the key", () => {
	const scopes = { user: { value: undefined, path: undefined, warning: undefined }, project: { value: undefined, path: undefined, warning: undefined } };
	const configured = buildStatusCard(scopes, { configured: true, source: "stored", label: "stored credential" }, true, {});
	assert.match(configured, /Auth: configured \(stored credential\)/);
	const unconfigured = buildStatusCard(scopes, { configured: false }, true, {});
	assert.match(unconfigured, /Auth: not configured/);
	assert.doesNotMatch(unconfigured, /sk-/);
});

test("status card: loader warnings are surfaced", () => {
	const user = { value: undefined, path: "/u/broken.json", warning: "failed to parse /u/broken.json: boom" };
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, {});
	assert.match(card, /Warning: failed to parse \/u\/broken\.json: boom/);
});

test("status card: effective chat endpoint resolves via the merged config", () => {
	const user = {
		value: { endpoint: { region: "eu" as const, baseUrl: undefined } },
		path: "/u/mistral-native.json",
		warning: undefined,
	};
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, {});
	assert.match(card, /Effective chat endpoint: https:\/\/api\.eu\.mistral\.ai\/v1/);
});

// --- /mistral test: named failing steps -----------------------------------

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("test: missing key -> auth step with fix hint", async () => {
	const result = await runMistralTest("https://api.mistral.ai/v1", undefined, async () => {
		throw new Error("must not be called");
	});
	assert.equal(result.ok, false);
	assert.equal(result.step, "auth");
	assert.match(result.fix, /\/login mistral-native/);
});

test("test: 401 -> auth step, key never in the message", async () => {
	const result = await runMistralTest("https://api.mistral.ai/v1", "sk-secret", async () => jsonResponse(401, { error: "unauthorized" }));
	assert.equal(result.ok, false);
	assert.equal(result.step, "auth");
	assert.match(result.message, /HTTP 401/);
	assert.doesNotMatch(result.message + result.fix, /sk-secret/);
});

test("test: 403 -> auth step", async () => {
	const result = await runMistralTest("https://api.mistral.ai/v1", "k", async () => jsonResponse(403, {}));
	assert.equal(result.ok, false);
	assert.equal(result.step, "auth");
});

test("test: network failure -> network step with fix hint", async () => {
	const result = await runMistralTest("https://api.mistral.ai/v1", "k", async () => {
		throw new Error("ECONNREFUSED");
	});
	assert.equal(result.ok, false);
	assert.equal(result.step, "network");
	assert.match(result.message, /ECONNREFUSED/);
	assert.match(result.fix, /endpoint\.baseUrl or endpoint\.region/);
});

test("test: 500 -> http step", async () => {
	const result = await runMistralTest("https://api.mistral.ai/v1", "k", async () => jsonResponse(500, {}));
	assert.equal(result.ok, false);
	assert.equal(result.step, "http");
});

test("test: 200 with model list -> ok with count", async () => {
	const result = await runMistralTest("https://api.mistral.ai/v1", "k", async () => jsonResponse(200, { data: [{ id: "a" }, { id: "b" }] }));
	assert.equal(result.ok, true);
	assert.match(result.message, /returned 2 models/);
});

test("test: 200 with non-JSON body -> http step naming a possible gateway", async () => {
	const result = await runMistralTest("https://api.mistral.ai/v1", "k", async () => new Response("<html>", { status: 200 }));
	assert.equal(result.ok, false);
	assert.equal(result.step, "http");
	assert.match(result.fix, /gateway/);
});

// --- env-only regression + real-fs atomic write ---------------------------

test("env-only: no file anywhere -> set creates at the chain head (hermetic)", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	// The sentinel dir is set for BOTH chain-defining vars, so the head is
	// PI_CODING_AGENT_DIR-controlled regardless of the machine's env.
	assert.equal(target, `${SENTINEL_DIR}/mistral-native.json`);
});

test("env-only: without sentinel vars the chain head derives from HOME only", () => {
	// The un-sentineled combination: no PI_CODING_AGENT_DIR, no XDG on the
	// live machine (pinned by deriving the expectation from the chain
	// itself rather than a hardcoded pattern).
	const fs = emptyFs();
	void fs;
	// A bag-present empty string is the code's unset marker, so pinning both
	// chain-defining vars to "" keeps the bag hermetic even on machines
	// that export XDG_CONFIG_HOME system-wide.
	const hermetic = { HOME: HOME, PI_CODING_AGENT_DIR: "", XDG_CONFIG_HOME: "" };
	const paths = userConfigPaths(hermetic);
	const target = setUserConfigTargetPath(hermetic, memoryExists(fs));
	assert.equal(target, paths[0]);
	assert.equal(target, join(HOME, ".config", "pi", "mistral-native.json"));
});

test("real fs: atomic write leaves no temp file behind and lands at the target", () => {
	// Real write path: temp sibling + rename in the same directory.
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-test-"));
	try {
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		const target = `${dir}/mistral-native.json`;
		// setUserConfigKey with the real fs (no injected writer).
		const returned = setUserConfigKey("endpoint.region", "eu", env);
		assert.equal(returned, target);
		const written = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
		assert.deepEqual(written, { endpoint: { region: "eu" } });
		const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
		assert.deepEqual(leftovers, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- tab completion --------------------------------------------------------

test("completion: empty prefix offers the subcommands", () => {
	const items = mistralArgumentCompletions("");
	assert.deepEqual(items.map((item) => item.value).sort(), ["set", "test"]);
});

test("completion: 'se' prefix offers only set", () => {
	const items = mistralArgumentCompletions("se");
	assert.deepEqual(items.map((item) => item.value), ["set"]);
});

test("completion: 'set ' offers all settable keys", () => {
	const items = mistralArgumentCompletions("set ");
	assert.ok(items.length >= 10);
	assert.ok(items.some((item) => item.value === "endpoint.region"));
});

test("completion: 'set endpoint.' offers the dotted endpoint keys", () => {
	const items = mistralArgumentCompletions("set endpoint.");
	assert.deepEqual(items.map((item) => item.value), ["endpoint.baseUrl", "endpoint.region"]);
});

test("completion: 'set endpoint.region ' (value position) offers nothing", () => {
	assert.deepEqual(mistralArgumentCompletions("set endpoint.region "), []);
});

test("completion: models.rateCard is never offered", () => {
	const items = mistralArgumentCompletions("set ");
	assert.ok(!items.some((item) => item.value === "models.rateCard"));
});

// --- handler layer (dispatch, set wiring, refresh invariant) --------------

/** Minimal CommandContext fake: records notifications, never touches fs. */
function makeCtx(): { ctx: CommandContext; notifications: Array<{ message: string; type?: string }> } {
	const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	const notify = (message: string, type?: "info" | "warning" | "error") => {
		notifications.push(type === undefined ? { message } : { message, type });
	};
	return {
		ctx: {
			ui: { notify },
			hasUI: true,
			mode: "tui",
			cwd: "/tmp",
			isProjectTrusted: () => true,
			modelRegistry: {
				getProviderAuthStatus: () => ({ configured: true, source: "stored", label: "stored credential" }),
				getApiKeyForProvider: async () => "k",
			},
		},
		notifications,
	};
}

test("handler: unknown subcommand -> error naming it and the usage", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("frobnicate", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.type, "error");
	assert.match(notifications[0]!.message, /unknown subcommand: "frobnicate"/);
	assert.match(notifications[0]!.message, /Usage: \/mistral/);
});

test("handler: bare invocation renders the status card", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("", ctx);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!.message, /Mistral configuration/);
	assert.match(notifications[0]!.message, /Auth: configured \(stored credential\)/);
});

test("handler: set with no key -> usage error", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("set", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.type, "error");
	assert.match(notifications[0]!.message, /Usage: \/mistral set <key> <value>/);
	assert.match(notifications[0]!.message, /Settable keys:/);
});

test("handler: set with a non-list key and no value -> missing value error", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("set agentId", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.type, "error");
	assert.match(notifications[0]!.message, /missing value for "agentId"/);
});

test("handler: set with a list key and no value clears the list (writes [])", async () => {
	// Real fs in a hermetic HOME chain: the cleared list must land on disk
	// in the temp dir, never the user's live config.
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-clear-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		const target = `${dir}/mistral-native.json`;
		writeFileSync(target, JSON.stringify({ serverTools: ["web_search"] }));
		await handleMistralCommand("set serverTools", ctx, { env });
		const written = JSON.parse(readFileSync(target, "utf8")) as { serverTools: string[] };
		assert.deepEqual(written.serverTools, []);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /Saved: serverTools = \(empty list\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("handler: set refusal (bad value) does not refresh cached config or write", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-refuse-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		await handleMistralCommand("set endpoint.region moon", ctx, { env });
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.type, "error");
		assert.match(notifications[0]!.message, /must be global, eu or us/);
		assert.equal(readdirSync(dir).includes("mistral-native.json"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("status card: an env value the resolver ignores is not shown as effective (region)", () => {
	const user = { value: undefined, path: undefined, warning: undefined };
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, { MISTRAL_REGION: "EU" });
	// getEffectiveEndpoint ignores non-exact region values — the card must
	// show the default, not the ignored env string.
	assert.match(card, /Region: global  \[default\]/);
});

test("status card: an honored env region is shown with env provenance", () => {
	const user = { value: undefined, path: undefined, warning: undefined };
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, { MISTRAL_REGION: "eu" });
	assert.match(card, /Region: eu  \[env MISTRAL_REGION\]/);
});

test("status card: an unrecognized MISTRAL_RAG_STREAMING value falls to the default", () => {
	const user = { value: undefined, path: undefined, warning: undefined };
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, { MISTRAL_RAG_STREAMING: "banana" });
	assert.match(card, /RAG streaming: true  \[default\]/);
});
