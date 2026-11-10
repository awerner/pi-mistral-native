/**
 * Tests for the `/mistral` command family: status-card provenance,
 * scope-parameterized set (user default, --project with trust refusal;
 * atomic write-then-verify, no speculative creation, first-set minimal
 * file), list-entry mutation (+append dedup / -remove / clear /
 * wholesale-replace), the Usage error for unknown keys, the live test's
 * named failing steps (auth/network/http/ok), the env-only regression,
 * and the completion surface — the pure argument-completion function
 * (full-argument item values, key/flag/value positions, static and
 * seam-driven dynamic hints) plus the autocomplete-provider wrapper.
 *
 * The wrapper regression tests drive pi's REAL
 * `CombinedAutocompleteProvider` (imported from `@earendil-works/pi-tui`
 * — an accepted coupling to the installed pi-tui, same pattern as
 * test/auth.test.ts's composer coupling): pi applies a completion item
 * by replacing the entire stored argument prefix with `item.value`, and
 * explicit Tab on a slash line with a space issues a forced request that
 * skips registerCommand argument completions, so the real provider (not a
 * replica) must observe both fixes.
 *
 * No network, no real keys. Handler tests run against the real fs
 * inside throwaway temp dirs with hermetic env bags (never the
 * machine's live config); pure-function tests use injected seams; the
 * wrapper regression tests read the process-env user chain for dynamic
 * +/- hints with machine-tolerant shape/membership assertions.
 *
 * ADR 0016 — /mistral command family: show, set, test
 * ADR 0022 — Project-scope writes and list mutation for /mistral set
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userConfigPaths, projectConfigPath } from "../extensions/mistral/config.js";
import {
	type CommandContext,
	loadMistralScopes,
	buildStatusCard,
	setUserConfigKey,
	setProjectConfigKey,
	setUserConfigTargetPath,
	verifySetResult,
	runMistralTest,
	mistralArgumentCompletions,
	mistralAutocompleteProviderWrapper,
	handleMistralCommand,
	registerMistralCommands,
} from "../extensions/mistral/commands.js";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

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
	const outcome = setUserConfigKey("endpoint.region", "eu", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.target, target);
	assert.equal(outcome.wrote, true);
	assert.equal(outcome.note, undefined);
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
		/Usage: \/mistral set \[--project\] <key> <value>[\s\S]*Settable keys:/,
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

test("set +entry appends to the current list with dedup (memory fs)", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ serverTools: ["web_search"] }));
	const outcome = setUserConfigKey("serverTools", "+code_interpreter", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.wrote, true);
	const written = JSON.parse(fs.files.get(target)!) as { serverTools: string[] };
	assert.deepEqual(written.serverTools, ["web_search", "code_interpreter"]);
});

test("set +entry on an unset list creates the list", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	setUserConfigKey("connectors", "+notion", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as { connectors: string[] };
	assert.deepEqual(written.connectors, ["notion"]);
});

test("set +entry already present is a no-op with a note, file unchanged", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	const before = JSON.stringify({ serverTools: ["web_search"] });
	fs.files.set(target, before);
	const outcome = setUserConfigKey("serverTools", "+web_search", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.wrote, false);
	assert.match(outcome.note ?? "", /nothing added/);
	assert.match(outcome.note ?? "", /web_search already in the list/);
	assert.equal(fs.files.get(target), before);
});

test("set -entry removes from the current list", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ serverTools: ["web_search", "code_interpreter"] }));
	const outcome = setUserConfigKey("serverTools", "-web_search", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.wrote, true);
	const written = JSON.parse(fs.files.get(target)!) as { serverTools: string[] };
	assert.deepEqual(written.serverTools, ["code_interpreter"]);
});

test("set -entry missing from the list is a no-op with a note", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	const before = JSON.stringify({ serverTools: ["web_search"] });
	fs.files.set(target, before);
	const outcome = setUserConfigKey("serverTools", "-code_interpreter", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.wrote, false);
	assert.match(outcome.note ?? "", /nothing removed/);
	assert.match(outcome.note ?? "", /code_interpreter not in the list/);
	assert.equal(fs.files.get(target), before);
});

test("set -entry on an unset list is a no-op; the key stays absent", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	// unset falls through to env; [] suppresses it — never turn one into the other.
	const outcome = setUserConfigKey("serverTools", "-web_search", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.wrote, false);
	assert.match(outcome.note ?? "", /the list is unset/);
	assert.equal(fs.files.has(target), false, "no file may be created by a no-op removal");
});

test("set mixed +a,+b with a already present writes and notes the skip", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ connectors: ["a"] }));
	const outcome = setUserConfigKey("connectors", "+a,+b", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.wrote, true);
	assert.match(outcome.note ?? "", /added \+?b/);
	assert.match(outcome.note ?? "", /skipped a/);
	const written = JSON.parse(fs.files.get(target)!) as { connectors: string[] };
	assert.deepEqual(written.connectors, ["a", "b"]);
});

test("set mixed -a,-c removes a and notes the missing c", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ connectors: ["a", "b"] }));
	const outcome = setUserConfigKey("connectors", "-a,-c", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.wrote, true);
	assert.match(outcome.note ?? "", /removed a/);
	assert.match(outcome.note ?? "", /skipped \+?c/);
	const written = JSON.parse(fs.files.get(target)!) as { connectors: string[] };
	assert.deepEqual(written.connectors, ["b"]);
});

test("set '+' alone is an invalid value error", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	assert.throws(
		() => setUserConfigKey("serverTools", "+", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/"serverTools": "\+" needs at least one entry/,
	);
});

test("set non-list keys store +/- values literally or reject them", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	// String keys: a literal "+foo"/"-foo" stays untouched.
	setUserConfigKey("agentId", "-foo", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	let written = JSON.parse(fs.files.get(target)!) as { agentId: string };
	assert.equal(written.agentId, "-foo");
	// Boolean/region keys: the existing invalid-value errors apply.
	assert.throws(
		() => setUserConfigKey("rag.streaming", "-x", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/invalid boolean for "rag\.streaming"/,
	);
	assert.throws(
		() => setUserConfigKey("endpoint.region", "+eu", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/must be global, eu or us/,
	);
});

test("set stores a protocol value literally (endpoint.baseUrl)", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	// The raw `!cmd` string is stored untouched — the config-value
	// protocol resolves at read time, never at write time.
	setUserConfigKey("endpoint.baseUrl", "!pass show gateway-url", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as { endpoint: { baseUrl: string } };
	assert.equal(written.endpoint.baseUrl, "!pass show gateway-url");
});

test("setProjectConfigKey writes and merges at projectConfigPath(cwd)", () => {
	const fs = emptyFs();
	const cwd = "/proj";
	const target = projectConfigPath(cwd);
	fs.files.set(target, JSON.stringify({ agentId: "keep-me" }));
	const outcome = setProjectConfigKey(cwd, "endpoint.region", "eu", {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	assert.equal(outcome.target, target);
	assert.equal(outcome.wrote, true);
	const written = JSON.parse(fs.files.get(target)!) as Record<string, unknown>;
	assert.deepEqual(written, { agentId: "keep-me", endpoint: { region: "eu" } });
});

test("setProjectConfigKey refuses invalid JSON at the project path", () => {
	const fs = emptyFs();
	const cwd = "/proj";
	const target = projectConfigPath(cwd);
	fs.files.set(target, "{ not json");
	assert.throws(
		() => setProjectConfigKey(cwd, "agentId", "x", {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/not valid JSON.*fix the file by hand/,
	);
	assert.equal(fs.files.get(target), "{ not json");
});

test("setProjectConfigKey refuses a project file failing schema validation (no write)", () => {
	const fs = emptyFs();
	const cwd = "/proj";
	const target = projectConfigPath(cwd);
	fs.files.set(target, JSON.stringify({ unknownField: true }));
	assert.throws(
		() => setProjectConfigKey(cwd, "agentId", "x", {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/unknown field.*fix the file by hand/,
	);
	assert.equal(fs.files.get(target), JSON.stringify({ unknownField: true }));
});

test("setProjectConfigKey: list mutation works on the project scope's own list", () => {
	const fs = emptyFs();
	const cwd = "/proj";
	const target = projectConfigPath(cwd);
	fs.files.set(target, JSON.stringify({ serverTools: ["web_search"] }));
	setProjectConfigKey(cwd, "serverTools", "+code_interpreter", {
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

test("set list value is comma-only: clears; no whitespace fallback", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	// A comma-only value has no non-empty parts -> the empty list (spaces
	// are significant within an entry; there is no space-split fallback).
	setUserConfigKey("serverTools", ",", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	let written = JSON.parse(fs.files.get(target)!) as { serverTools: string[] };
	assert.deepEqual(written.serverTools, []);
	// A comma-only mutation has no entries -> the existing error.
	assert.throws(
		() => setUserConfigKey("serverTools", "+,", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/"serverTools": "\+" needs at least one entry/,
	);
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

test("verify: a content-equal project list value is not a shadow", () => {
	const user = { value: { serverTools: ["web_search"] }, path: "/u/mistral-native.json", warning: undefined };
	const project = { value: { serverTools: ["web_search"] }, path: "/p/.pi/mistral-native.json", warning: undefined };
	const result = verifySetResult({ user, project }, "serverTools");
	assert.equal(result.ok, true);
	assert.match(result.message, /Saved: serverTools = web_search \(user scope\)/);
	assert.doesNotMatch(result.message, /shadows/);
});

test("verify: a content-equal user list value is not an override", () => {
	const user = { value: { serverTools: ["web_search"] }, path: "/u/mistral-native.json", warning: undefined };
	const project = { value: { serverTools: ["web_search"] }, path: "/p/.pi/mistral-native.json", warning: undefined };
	const result = verifySetResult({ user, project }, "serverTools", "project");
	assert.equal(result.ok, true);
	assert.match(result.message, /Saved: serverTools = web_search \(project scope\)/);
	assert.doesNotMatch(result.message, /overrides/);
});

test("verify: an unset re-read reports did-not-take", () => {
	const scopes = { user: { value: undefined, path: undefined, warning: undefined }, project: { value: undefined, path: undefined, warning: undefined } };
	const result = verifySetResult(scopes, "agentId");
	assert.equal(result.ok, false);
	assert.match(result.message, /did not take/);
});

test("verify: project-scope write reports the project scope", () => {
	const user = { value: { agentId: "from-user" }, path: "/u/mistral-native.json", warning: undefined };
	const project = { value: { agentId: "from-project" }, path: "/p/.pi/mistral-native.json", warning: undefined };
	const result = verifySetResult({ user, project }, "agentId", "project");
	assert.equal(result.ok, true);
	assert.match(result.message, /Saved: agentId = from-project \(project scope\)/);
	assert.match(result.message, /overrides the user-scope value from-user/);
});

test("verify: project-scope write with no user value says so plainly", () => {
	const user = { value: undefined, path: undefined, warning: undefined };
	const project = { value: { agentId: "from-project" }, path: "/p/.pi/mistral-native.json", warning: undefined };
	const result = verifySetResult({ user, project }, "agentId", "project");
	assert.equal(result.ok, true);
	assert.match(result.message, /\(project scope\)/);
	assert.doesNotMatch(result.message, /overrides/);
});

test("verify: project-scope did-not-take is reported against the project re-read", () => {
	const user = { value: { agentId: "from-user" }, path: "/u/mistral-native.json", warning: undefined };
	const project = { value: undefined, path: undefined, warning: undefined };
	const result = verifySetResult({ user, project }, "agentId", "project");
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
	assert.match(card, /\(web_search do not run in chat completions — use the web_search tool for web search; see https:\/\/mawoh\.github\.io\/pi-mistral-native\/reference\/tools\/\)/);
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
	// Completion offers the key (values carry the full argument text).
	const items = mistralArgumentCompletions("set knowledge.");
	assert.ok(items.some((item) => item.value === "set knowledge.searchModel"), "key must be offered");
});

test("status card: the three retry rows show effective defaults with default provenance", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const user = { value: undefined, path: undefined, warning: undefined };
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, env);
	assert.match(card, /Retry attempts: 3  \[default\]/);
	assert.match(card, /Retry base delay: 1000 ms  \[default\]/);
	assert.match(card, /Retry max delay: 30000 ms  \[default\]/);
});
test("status card: a user-file retry section shows with file provenance; project shadows", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const user = {
		value: { retry: { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60000 } },
		path: "/u/mistral-native.json",
		warning: undefined,
	};
	const project = { value: undefined, path: undefined, warning: undefined };
	const card = buildStatusCard({ user, project }, undefined, true, env);
	assert.match(card, /Retry attempts: 5  \[user file \/u\/mistral-native\.json\]/);
	assert.match(card, /Retry base delay: 2000  \[user file \/u\/mistral-native\.json\]/);
	assert.match(card, /Retry max delay: 60000  \[user file \/u\/mistral-native\.json\]/);
	// A project value shadows per key.
	const projectScoped = {
		value: { retry: { maxAttempts: 1, baseDelayMs: undefined, maxDelayMs: undefined } },
		path: "/p/mistral-native.json",
		warning: undefined,
	};
	const shadowCard = buildStatusCard({ user, project: projectScoped }, undefined, true, env);
	assert.match(shadowCard, /Retry attempts: 1  \[project file \/p\/mistral-native\.json\]/);
	assert.match(shadowCard, /Retry base delay: 2000  \[user file \/u\/mistral-native\.json\]/);
});

test("set: each retry key writes in both scopes; invalid values are refused; merge is atomic", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	// A pre-existing file with another key: the write must preserve it.
	fs.files.set(target, JSON.stringify({ agentId: "keep-me" }));
	setUserConfigKey("retry.maxAttempts", "5", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	setUserConfigKey("retry.baseDelayMs", "500", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	setUserConfigKey("retry.maxDelayMs", "20000", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const written = JSON.parse(fs.files.get(target)!) as {
		agentId: string;
		retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
	};
	assert.equal(written.agentId, "keep-me", "the merge preserves existing keys");
	assert.deepEqual(written.retry, { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 20000 });
	// Project scope writes the project path.
	const cwd = "/project-root";
	setProjectConfigKey(cwd, "retry.maxAttempts", "2", {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const projectFile = JSON.parse(fs.files.get(projectConfigPath(cwd))!) as { retry: { maxAttempts: number } };
	assert.equal(projectFile.retry.maxAttempts, 2);
	// Invalid values are refused and nothing is written.
	const before = fs.files.get(target)!;
	for (const bad of ["0", "-1", "1.5", "abc", "", " 3x"]) {
		assert.throws(
			() => setUserConfigKey("retry.maxAttempts", bad, env, {
				readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
			}),
			/must be a positive integer/,
			`value ${JSON.stringify(bad)} must be refused`,
		);
	}
	assert.equal(fs.files.get(target)!, before, "refused writes leave the file unchanged");
	// Whitespace around a valid integer is trimmed and accepted.
	setUserConfigKey("retry.maxAttempts", " 4 ", env, {
		readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
	});
	const trimmed = JSON.parse(fs.files.get(target)!) as { retry: { maxAttempts: number } };
	assert.equal(trimmed.retry.maxAttempts, 4);
});

test("set: a retry.maxDelayMs below the file's baseDelayMs is refused by the merged validation", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ retry: { baseDelayMs: 5000, maxAttempts: undefined, maxDelayMs: undefined } }));
	assert.throws(
		() => setUserConfigKey("retry.maxDelayMs", "3000", env, {
			readFile: memoryRead(fs), writeFile: memoryWrite(fs), fileExists: memoryExists(fs),
		}),
		/must be greater than or equal to retry\.baseDelayMs/,
	);
	// The file is untouched.
	const after = JSON.parse(fs.files.get(target)!) as { retry: { baseDelayMs: number; maxDelayMs?: number } };
	assert.equal(after.retry.baseDelayMs, 5000);
	assert.equal(after.retry.maxDelayMs, undefined);
});

test("completion: the retry keys are offered at the key position; the value position offers nothing", () => {
	const items = mistralArgumentCompletions("set retry.");
	assert.deepEqual(
		items.map((item) => item.value),
		["set retry.baseDelayMs", "set retry.maxAttempts", "set retry.maxDelayMs"],
	);
	// Integer keys offer no value completions.
	assert.deepEqual(mistralArgumentCompletions("set retry.maxAttempts "), []);
	assert.deepEqual(mistralArgumentCompletions("set retry.maxAttempts 3"), []);
	// The project-scope key position lists them too.
	const projectItems = mistralArgumentCompletions("set --project retry.");
	assert.ok(projectItems.some((item) => item.value === "set --project retry.maxAttempts"));
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
	assert.doesNotMatch(card, /web_search/);
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
		const outcome = setUserConfigKey("endpoint.region", "eu", env);
		assert.equal(outcome.target, target);
		assert.equal(outcome.wrote, true);
		const written = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
		assert.deepEqual(written, { endpoint: { region: "eu" } });
		const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
		assert.deepEqual(leftovers, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- tab completion (pure function) ---------------------------------------

test("completion: empty prefix offers the subcommands", () => {
	const items = mistralArgumentCompletions("");
	assert.deepEqual(items.map((item) => item.value).sort(), ["set", "test"]);
	assert.match(items.find((item) => item.value === "set")!.description ?? "", /--project/);
});

test("completion: 'se' prefix offers only set", () => {
	const items = mistralArgumentCompletions("se");
	assert.deepEqual(items.map((item) => item.value), ["set"]);
});

test("completion: 'set ' offers all settable keys plus --project, full-argument values", () => {
	const items = mistralArgumentCompletions("set ");
	const expectedKeys = Object.keys({
		"agentId": 0,
		"connectorTools.autoLoad": 0,
		"connectorTools.enabled": 0,
		"connectors": 0,
		"endpoint.baseUrl": 0,
		"endpoint.region": 0,
		"knowledge.searchModel": 0,
		"knowledge.streaming": 0,
		"models.fallThrough": 0,
		"ocr.defaultModel": 0,
		"rag.defaultLibraryId": 0,
		"rag.streaming": 0,
		"retry.baseDelayMs": 0,
		"retry.maxAttempts": 0,
		"retry.maxDelayMs": 0,
		"serverTools": 0,
	}).sort();
	assert.deepEqual(
		items.map((item) => item.value).sort(),
		[...expectedKeys.map((key) => `set ${key}`), "set --project"].sort(),
	);
	const flag = items.find((item) => item.value === "set --project")!;
	assert.equal(flag.label, "--project");
	assert.match(flag.description ?? "", /project trust/);
});

test("completion: 'set --p' offers only the --project flag", () => {
	const items = mistralArgumentCompletions("set --p");
	assert.deepEqual(items.map((item) => item.value), ["set --project"]);
	assert.equal(items[0]!.label, "--project");
});

test("completion: 'set --project ' offers keys with project-argument values and no flag", () => {
	const items = mistralArgumentCompletions("set --project ");
	assert.ok(items.length >= 13);
	assert.ok(items.some((item) => item.value === "set --project serverTools"));
	assert.ok(!items.some((item) => item.value === "set --project"), "flag already consumed");
	for (const item of items) assert.ok(item.value.startsWith("set --project "));
});

test("completion: 'set endpoint.' offers the dotted endpoint keys", () => {
	const items = mistralArgumentCompletions("set endpoint.");
	assert.deepEqual(items.map((item) => item.value), ["set endpoint.baseUrl", "set endpoint.region"]);
});

test("completion: 'set serverTool' offers the full-argument key value", () => {
	const items = mistralArgumentCompletions("set serverTool");
	assert.deepEqual(items.map((item) => item.value), ["set serverTools"]);
	assert.equal(items[0]!.label, "serverTools");
});

test("completion: models.rateCard is never offered", () => {
	const items = mistralArgumentCompletions("set ");
	assert.ok(!items.some((item) => item.value === "set models.rateCard"));
	assert.ok(!items.some((item) => item.value === "models.rateCard"));
});

test("completion: boolean key value position offers true/false", () => {
	const items = mistralArgumentCompletions("set rag.streaming ");
	assert.deepEqual(items.map((item) => item.value), ["set rag.streaming true", "set rag.streaming false"]);
	assert.deepEqual(items.map((item) => item.label), ["true", "false"]);
});

test("completion: boolean key value position filters by typed value", () => {
	const items = mistralArgumentCompletions("set rag.streaming t");
	assert.deepEqual(items.map((item) => item.value), ["set rag.streaming true"]);
});

test("completion: region key value position offers global/eu/us", () => {
	const items = mistralArgumentCompletions("set endpoint.region ");
	assert.deepEqual(items.map((item) => item.value), [
		"set endpoint.region global",
		"set endpoint.region eu",
		"set endpoint.region us",
	]);
});

test("completion: string key value position offers nothing", () => {
	assert.deepEqual(mistralArgumentCompletions("set agentId "), []);
});

test("completion: unknown key value position offers nothing", () => {
	assert.deepEqual(mistralArgumentCompletions("set bogus "), []);
});

test("completion: beyond-value tokens offer nothing", () => {
	assert.deepEqual(mistralArgumentCompletions("set agentId foo bar"), []);
	assert.deepEqual(mistralArgumentCompletions("set serverTools +web_search extra"), []);
});

test("completion: serverTools value position offers the known + tokens (undeped: static)", () => {
	const items = mistralArgumentCompletions("set serverTools ");
	assert.deepEqual(items.map((item) => item.value), [
		"set serverTools +web_search",
		"set serverTools +web_search_premium",
		"set serverTools +image_generation",
		"set serverTools +code_interpreter",
	]);
});

test("completion: connectors value position offers no + hints without deps (static only)", () => {
	assert.deepEqual(mistralArgumentCompletions("set connectors "), []);
	assert.deepEqual(mistralArgumentCompletions("set connectorTools.autoLoad "), []);
});

test("completion: '+w' prefix filters the full +token", () => {
	const items = mistralArgumentCompletions("set serverTools +w");
	assert.deepEqual(items.map((item) => item.value), [
		"set serverTools +web_search",
		"set serverTools +web_search_premium",
	]);
});

test("completion: with deps, user-scope - hints come from the user file", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ serverTools: ["web_search"] }));
	const items = mistralArgumentCompletions("set serverTools ", { env, readFile: memoryRead(fs) });
	const values = items.map((item) => item.value);
	assert.ok(values.includes("set serverTools -web_search"), "must offer -web_search");
	// Known tools stay first; current entries join the + candidates.
	assert.ok(values.includes("set serverTools +web_search"));
	assert.ok(values.indexOf("set serverTools +code_interpreter") < values.indexOf("set serverTools -web_search"));
});

test("completion: with deps, connectors + and - hints come from the user file", () => {
	const fs = emptyFs();
	const env = memoryEnv(fs, HOME);
	const target = setUserConfigTargetPath(env, memoryExists(fs));
	fs.files.set(target, JSON.stringify({ connectors: ["notion"] }));
	const items = mistralArgumentCompletions("set connectors ", { env, readFile: memoryRead(fs) });
	assert.deepEqual(items.map((item) => item.value), ["set connectors +notion", "set connectors -notion"]);
});

test("completion: --project line reads the project file for - hints when trusted", () => {
	const fs = emptyFs();
	const cwd = "/proj";
	fs.files.set(projectConfigPath(cwd), JSON.stringify({ serverTools: ["web_search"] }));
	const items = mistralArgumentCompletions("set --project serverTools ", {
		cwd,
		projectTrusted: true,
		readFile: memoryRead(fs),
	});
	const values = items.map((item) => item.value);
	assert.ok(values.includes("set --project serverTools -web_search"));
	assert.ok(values.every((value) => value.startsWith("set --project serverTools")));
});

test("completion: untrusted project line never reads the project file", () => {
	const fs = emptyFs();
	const cwd = "/proj";
	fs.files.set(projectConfigPath(cwd), JSON.stringify({ serverTools: ["web_search"] }));
	let reads = 0;
	const readFile = (path: string): string => {
		reads += 1;
		if (path === projectConfigPath(cwd)) throw new Error("project file must not be read without trust");
		return memoryRead(fs)(path);
	};
	const items = mistralArgumentCompletions("set --project serverTools ", {
		cwd,
		projectTrusted: false,
		readFile,
	});
	// Static known tools only; no dynamic - hints, no project read.
	assert.deepEqual(items.map((item) => item.value), [
		"set --project serverTools +web_search",
		"set --project serverTools +web_search_premium",
		"set --project serverTools +image_generation",
		"set --project serverTools +code_interpreter",
	]);
	assert.ok(reads === 0, `project readFile must never be called, got ${reads} reads`);
});

test("completion: every offered value starts with the typed prefix's token model", () => {
	// pi's best-match highlight contract: item.value must start with the
	// stored prefix (the full argument text) for the editor to highlight it.
	for (const prefix of ["set ", "set serverTool", "set --project ", "set serverTools +w"]) {
		const items = mistralArgumentCompletions(prefix);
		for (const item of items) {
			assert.ok(
				item.value.startsWith(prefix.trim()) || prefix.trim().length === 0,
				`item ${JSON.stringify(item.value)} must start with the typed text of ${JSON.stringify(prefix)}`,
			);
		}
	}
});

// --- real-provider completion regressions (pi-tui coupling) ----------------

/**
 * The REAL CombinedAutocompleteProvider over the extension's completion,
 * wrapped the way pi's addAutocompleteProvider chain wraps it. basePath is a
 * temp dir so the BASE provider's file completion has something to find (the
 * wrapper must beat it on forced Tab, not win by an empty directory).
 */
function buildWrappedProvider(basePath: string) {
	const base = new CombinedAutocompleteProvider(
		[{ name: "mistral", getArgumentCompletions: (prefix: string) => mistralArgumentCompletions(prefix) }],
		basePath,
		null,
	);
	return {
		base,
		wrapped: mistralAutocompleteProviderWrapper(base, () => ({ cwd: basePath, projectTrusted: false })),
	};
}

/** A temp basePath holding one file, so base file completion has candidates. */
function tempBasePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "mistral-completion-regression-"));
	writeFileSync(join(dir, "a-file.txt"), "x");
	return dir;
}

const noForce = { force: false, signal: new AbortController().signal };
const forced = { force: true, signal: new AbortController().signal };

test("regression (apply bug): applying a key item over 'set ' keeps the set token", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral set ";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, noForce);
		assert.ok(suggestions && suggestions.items.length > 0, "key items must be offered");
		assert.equal(suggestions!.prefix, "set ");
		const applied = wrapped.applyCompletion([line], 0, line.length, suggestions!.items[0]!, suggestions!.prefix);
		assert.match(applied.lines[0]!, /^\/mistral set \S+$/);
		assert.notEqual(applied.lines[0], "/mistral agentId");
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("regression (apply bug): applying over 'set serverTool' completes to set serverTools", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral set serverTool";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, noForce);
		assert.ok(suggestions, "key items must be offered");
		assert.equal(suggestions!.prefix, "set serverTool");
		const applied = wrapped.applyCompletion([line], 0, line.length, suggestions!.items[0]!, suggestions!.prefix);
		assert.equal(applied.lines[0], "/mistral set serverTools");
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("regression (apply bug): every item value starts with the stored prefix", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		for (const line of ["/mistral set ", "/mistral set serverTool", "/mistral set serverTools ", "/mistral set --project "]) {
			const suggestions = await wrapped.getSuggestions([line], 0, line.length, noForce);
			assert.ok(suggestions, `items expected for ${JSON.stringify(line)}`);
			for (const item of suggestions!.items) {
				assert.ok(
					item.value.startsWith(suggestions!.prefix),
					`item ${JSON.stringify(item.value)} must start with the stored prefix ${JSON.stringify(suggestions!.prefix)}`,
				);
			}
		}
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("regression (Tab bug): forced Tab at 'set ' returns key items, not files", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral set ";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, forced);
		assert.ok(suggestions && suggestions.items.length > 0, "forced request must reach the extension");
		for (const item of suggestions!.items) {
			assert.ok(!item.value.includes(".txt"), `no file items expected, got ${JSON.stringify(item.value)}`);
		}
		assert.ok(suggestions!.items.some((item) => item.value === "set serverTools"));
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("regression (Tab bug): the BASE provider alone answers forced Tab with file items", async () => {
	// Pins the mechanism: without the wrapper, pi-tui's forced request skips
	// getArgumentCompletions entirely and lands in path completion.
	const basePath = tempBasePath();
	try {
		const { base } = buildWrappedProvider(basePath);
		const line = "/mistral set ";
		const suggestions = await base.getSuggestions([line], 0, line.length, forced);
		assert.ok(suggestions && suggestions.items.length > 0, "file completion must have candidates");
		assert.ok(suggestions!.items.some((item) => item.value.includes(".txt")), "expected a file item");
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("regression (Tab bug): forced Tab at 'set serverTool' auto-applies the single item", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral set serverTool";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, forced);
		assert.ok(suggestions, "forced request must reach the extension");
		assert.equal(suggestions!.items.length, 1, "exactly one key matches the prefix");
		assert.equal(suggestions!.items[0]!.value, "set serverTools");
		// editor.js: forced + explicit Tab + single item => auto-apply.
		const applied = wrapped.applyCompletion([line], 0, line.length, suggestions!.items[0]!, suggestions!.prefix);
		assert.equal(applied.lines[0], "/mistral set serverTools");
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("regression (Tab bug): forced Tab at 'set serverTools ' offers + hints", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral set serverTools ";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, forced);
		assert.ok(suggestions && suggestions.items.length > 0, "value hints must be offered on forced Tab");
		const values = suggestions!.items.map((item) => item.value);
		assert.ok(values.includes("set serverTools +web_search"));
		assert.ok(values.every((value) => value.startsWith("set serverTools")));
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("regression (Tab bug): forced Tab at 'set --project ' offers the keys", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral set --project ";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, forced);
		assert.ok(suggestions && suggestions.items.length >= 13, "key items must be offered");
		assert.ok(suggestions!.items.some((item) => item.value === "set --project serverTools"));
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("wrapper: command-name position delegates to the base provider", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral se";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, noForce);
		assert.ok(suggestions, "command-name completion must still work");
		assert.deepEqual(suggestions!.items.map((item) => item.value), ["set"]);
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("wrapper: plain text delegates to the base provider", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "hello wor";
		const wrappedSuggestions = await wrapped.getSuggestions([line], 0, line.length, noForce);
		const baseSuggestions = await buildWrappedProvider(basePath).base.getSuggestions([line], 0, line.length, noForce);
		assert.deepEqual(wrappedSuggestions, baseSuggestions);
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("wrapper: no mistral items yields null (no empty list)", async () => {
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral set bogus ";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, noForce);
		assert.equal(suggestions, null);
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});

test("wrapper: list-key value positions offer + hints (membership shape, hermetic cwd)", async () => {
	// The wrapper reads the real user chain for dynamic hints, so exact
	// machine-dependent lists are not asserted here — only shape and the
	// static known-tool hints (exact − hint coverage lives in the pure
	// function tests with seams).
	const basePath = tempBasePath();
	try {
		const { wrapped } = buildWrappedProvider(basePath);
		const line = "/mistral set serverTools ";
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, noForce);
		assert.ok(suggestions, "value hints must be offered");
		const values = suggestions!.items.map((item) => item.value);
		assert.ok(values.includes("set serverTools +web_search"));
		assert.ok(values.includes("set serverTools +code_interpreter"));
		assert.ok(values.every((value) => value.startsWith("set serverTools ")));
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
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
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-status-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		await handleMistralCommand("", ctx, { env });
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /Mistral configuration/);
		assert.match(notifications[0]!.message, /Auth: configured \(stored credential\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("handler: set with no key -> usage error", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("set", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.type, "error");
	assert.match(notifications[0]!.message, /Usage: \/mistral set \[--project\] <key> <value>/);
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

test("handler: set refusal (bad value) errors without writing", async () => {
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

test("handler: set --project writes <cwd>/.pi/mistral-native.json in a trusted project", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-project-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		await handleMistralCommand("set --project serverTools web_search", ctx, { env });
		const target = projectConfigPath(dir);
		const written = JSON.parse(readFileSync(target, "utf8")) as { serverTools: string[] };
		assert.deepEqual(written.serverTools, ["web_search"]);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /\(project scope\)/);
		assert.match(notifications[0]!.message, new RegExp(`written to: ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		// The user chain stays untouched: --project writes the project file only.
		assert.equal(existsSync(`${dir}/mistral-native.json`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("handler: set --project in an untrusted project is refused without any file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-untrusted-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		ctx.isProjectTrusted = () => false;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		await handleMistralCommand("set --project serverTools web_search", ctx, { env });
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.type, "error");
		assert.match(notifications[0]!.message, /not trusted/);
		assert.equal(existsSync(projectConfigPath(dir)), false, "no project file may be created");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("handler: set --project with no key -> usage", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("set --project", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.type, "error");
	assert.match(notifications[0]!.message, /Usage: \/mistral set \[--project\] <key> <value>/);
});

test("handler: set --project with a list key and no value clears the project list (writes [])", async () => {
	// Real fs in a trusted temp project: the bare project-scope clear
	// writes [] to projectConfigPath(cwd).
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-project-clear-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		const target = projectConfigPath(dir);
		await handleMistralCommand("set --project serverTools", ctx, { env });
		const written = JSON.parse(readFileSync(target, "utf8")) as { serverTools: string[] };
		assert.deepEqual(written.serverTools, []);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /Saved: serverTools = \(empty list\) \(project scope\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("handler: partial-skip mutation composes verify, note and target lines", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-compose-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		const target = `${dir}/mistral-native.json`;
		writeFileSync(target, JSON.stringify({ serverTools: ["web_search"] }));
		await handleMistralCommand("set serverTools +web_search,+code_interpreter", ctx, { env });
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.type, "info");
		const message = notifications[0]!.message;
		// One notification carries all three parts: the Saved line, the
		// skipped-entries note and the written-to line.
		assert.match(message, /Saved: serverTools = web_search, code_interpreter \(user scope\)/);
		assert.match(message, /skipped web_search \(already in the list\)/);
		assert.match(message, new RegExp(`written to: ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("handler: set --project with a non-list key and no value -> missing value", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("set --project agentId", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.type, "error");
	assert.match(notifications[0]!.message, /missing value for "agentId"/);
});

test("handler: a --project after the key is a flag-position error", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("set serverTools --project", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.type, "error");
	assert.match(notifications[0]!.message, /--project flag goes before the key/);
});

test("handler: a second --project becomes the key and errors as unknown", async () => {
	const { ctx, notifications } = makeCtx();
	await handleMistralCommand("set --project --project agentId x", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.type, "error");
	assert.match(notifications[0]!.message, /unknown or unsupported key: "--project"/);
});

test("handler: project write with a user value present notes the override", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-override-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		// A user-scope value exists; the project write must note that it
		// overrides it in this project.
		setUserConfigKey("agentId", "user-agent", env);
		await handleMistralCommand("set --project agentId project-agent", ctx, { env });
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /Saved: agentId = project-agent \(project scope\)/);
		assert.match(notifications[0]!.message, /overrides the user-scope value user-agent/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("handler: no-op mutation notifies the note only, without writing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mistral-commands-noop-"));
	try {
		const { ctx, notifications } = makeCtx();
		ctx.cwd = dir;
		const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CONFIG_HOME: "" };
		const target = `${dir}/mistral-native.json`;
		writeFileSync(target, JSON.stringify({ serverTools: ["web_search"] }));
		const before = readFileSync(target, "utf8");
		await handleMistralCommand("set serverTools +web_search", ctx, { env });
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.type, "info");
		assert.match(notifications[0]!.message, /nothing added/);
		assert.doesNotMatch(notifications[0]!.message, /Saved:/);
		assert.equal(readFileSync(target, "utf8"), before);
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

// --- registration (session_start wiring, wrapper-once guard) ----------------

test("registration: session_start wires the autocomplete wrapper once per ui context", async () => {
	const commands: Array<{ name: string; options: Record<string, unknown> }> = [];
	const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => void> = [];
	const providers: Array<(current: unknown) => unknown> = [];
	const pi = {
		registerCommand: (name: string, options: Record<string, unknown>) => {
			commands.push({ name, options });
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
			if (event === "session_start") sessionStartHandlers.push(handler);
		},
	} as never;
	registerMistralCommands(pi);
	assert.equal(commands.length, 1);
	assert.equal(commands[0]!.name, "mistral");
	assert.equal(sessionStartHandlers.length, 1, "one session_start handler");
	const makeCtx = (cwd: string, trusted: boolean) => ({
		cwd,
		isProjectTrusted: () => trusted,
		ui: { addAutocompleteProvider: (factory: (current: unknown) => unknown) => { providers.push(factory); } },
	}) as never;
	// Same ui context: pi re-fires session_start within a session (e.g.
	// /reload) — re-registering would stack duplicate wrappers, so the SAME
	// context registers exactly once.
	const ctxA = makeCtx("/a", true);
	sessionStartHandlers[0]!(undefined, ctxA);
	sessionStartHandlers[0]!(undefined, ctxA);
	sessionStartHandlers[0]!(undefined, ctxA);
	assert.equal(providers.length, 1, "same ui context registers once");
	// A FRESH ui context (pi clears its wrapper list on session replacement
	// — /new, /resume, /fork — and re-fires session_start with a new ui
	// context): the wrapper MUST register again or Tab completion dies.
	sessionStartHandlers[0]!(undefined, makeCtx("/b", false));
	assert.equal(providers.length, 2, "a fresh ui context registers again");
	// The latest factory produces a working wrapper over the real provider.
	const basePath = tempBasePath();
	try {
		const base = new CombinedAutocompleteProvider(
			[{ name: "mistral", getArgumentCompletions: (prefix: string) => mistralArgumentCompletions(prefix) }],
			basePath,
			null,
		);
		const wrapped = providers[providers.length - 1]!(base) as ReturnType<typeof mistralAutocompleteProviderWrapper>;
		const line = "/mistral set serverTool";
		const signal = new AbortController().signal;
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, { force: true, signal });
		assert.ok(suggestions !== null);
		assert.equal(suggestions!.items[0]!.value, "set serverTools");
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});
