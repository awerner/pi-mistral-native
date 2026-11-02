/**
 * Auth tests for the mistral-native provider.
 *
 * Mistral offers no public OAuth flow for API access, so the provider
 * registers API-key auth only. The provider is a full
 * native pi-ai `Provider` whose `ApiKeyAuth` owns the credential chain:
 * stored auth.json credential → `MISTRAL_API_KEY` environment variable —
 * plus the guided `/login` flow (secret prompt + region select).
 *
 * The suite has four layers, kept honest by design:
 *
 * 1. Registration-surface tests drive the real extension factory through a
 *    mock pi ExtensionAPI (`captureRegistration`) — what the extension
 *    actually registers (the native provider OBJECT, not a string config)
 *    is genuinely under test here.
 * 2. Native auth tests exercise our real `ApiKeyAuth` (login flow with a
 *    mocked interaction, resolve chain, availability check) and the real
 *    user-scope region write (`writeUserMistralRegion`) against temp-dir
 *    file chains.
 * 3. Integration tests exercise pi's REAL provider composer
 *    (`composeModelProvider` from the installed pi-coding-agent 1.4.0,
 *    reached via a runtime-resolved `file://` URL because the package
 *    exports map only exposes the entry point — see `loadComposer`) with
 *    our captured provider as the compose BASE: pi wraps our native
 *    ApiKeyAuth untouched, so precedence, source reporting and the guided
 *    login flow are pi's actual behavior over our actual code, not a
 *    replica. The URL is derived from `import.meta.resolve` at runtime, so
 *    the same compiled test file works identically from `test/` and
 *    `dist/test/`.
 * 4. Contract-pin tests (`AUTH_FALLBACK_CHAIN` + `resolveMockKey` below)
 *    pin the DOCUMENTED chain order and its documented edge cases — they
 *    deliberately do NOT claim to test pi's behavior; that is layer 3's
 *    job. They exist because AUTH_FALLBACK_CHAIN is exported for tests and
 *    documentation, so its documented semantics deserve their own lock.
 *
 * Plus cross-cutting guards: a cross-platform `!command` subprocess test
 * (Node/AbortController semantics pin), and static source guards over the
 * compiled extension (no OAuth implementation remnants, no logging sinks).
 *
 * ADR 0004 — API-key credential chain without Mistral OAuth
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";

import type { ApiKeyCredential, Provider } from "@earendil-works/pi-ai";
// pi's REAL provider composer — imported dynamically via an absolute
// `file://` URL resolved from the installed package's entry path (its
// package exports map hides the internal module, so the package-name import
// fails with ERR_PACKAGE_PATH_NOT_EXPORTED). Accepted coupling to
// pi-coding-agent 1.4.0 internals — deliberate, so the REAL auth chain (not
// a replica) is under test; the dynamic import keeps tsc's module resolution
// out of the way while the runtime `file://` URL resolves identically for
// `test/` and compiled `dist/test/` (both two levels under the worktree root).
async function loadComposer(): Promise<{
	composeModelProvider: (
		providerId: string,
		base: unknown,
		modelConfig: unknown,
		extension: unknown,
	) => { auth: { apiKey?: NonNullable<ProviderAuth> } } & Record<string, unknown>;
}> {
	// Resolve the installed package's entry URL (…/dist/index.js), then walk to
	// the internal composer module the exports map hides:
	// …/pi-coding-agent/dist/index.js → …/pi-coding-agent/dist/core/provider-composer.js
	const entry = import.meta.resolve!("@earendil-works/pi-coding-agent", import.meta.url);
	const url = new URL("core/provider-composer.js", new URL(entry));
	return (await import(url.href)) as never;
}

// Narrow structural types over the dynamically imported module:
type ProviderAuth = {
	name: string;
	login?: (interaction: unknown) => Promise<ApiKeyCredential>;
	check?: (input: { ctx: AuthContextStub; credential?: ApiKeyCredential; signal: AbortSignal }) => Promise<{
		type: string;
		source?: string;
	} | undefined>;
	resolve: (input: { ctx: AuthContextStub; credential?: ApiKeyCredential; signal: AbortSignal }) => Promise<{
		auth: { apiKey?: string };
		env?: Record<string, string>;
		source?: string;
	} | undefined>;
};
type AuthContextStub = {
	env: (name: string) => Promise<string | undefined>;
	fileExists: (file: string) => Promise<boolean>;
};

import {
	AUTH_FALLBACK_CHAIN,
	MISTRAL_API,
	MISTRAL_API_KEY_ENV_VAR,
	MISTRAL_BASE_URL,
	default as registerExtension,
} from "../extensions/mistral.js";
import {
	createMistralApiKeyAuth,
	MISTRAL_REGION_LOGIN_OPTIONS,
	type RegionWriteFn,
} from "../extensions/mistral/auth.js";
import { writeUserMistralRegion } from "../extensions/mistral/config.js";
import type { MistralRegion } from "../extensions/mistral/config.js";

/** The login interaction's region-write calls, recorded per test. */
type RecordedRegionWrite = (region: MistralRegion) => void;

const execFileAsync = promisify(execFile);

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_EXTENSIONS_DIR = path.join(TEST_DIR, "..", "extensions");

/** pi's `ApiKeyCredential` shape as stored in ~/.pi/agent/auth.json. */
type MockCredential = ApiKeyCredential;

/** Minimal pi `AuthContext` stub: env bag for `MISTRAL_API_KEY` resolution. */
function makeAuthCtx(env: Record<string, string>): {
	env: (name: string) => Promise<string | undefined>;
	fileExists: (file: string) => Promise<boolean>;
} {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

/** Unconfigured models context: no models.json overlays, no config entries. */
function noModelsConfig(): { getProvider: (id: string) => undefined } {
	return { getProvider: () => undefined };
}

/**
 * Emulates the DOCUMENTED resolution order of AUTH_FALLBACK_CHAIN (see layer
 * 4 in the header). This is a contract pin for the exported constant, NOT a
 * test of pi's behavior — pi's real chain is covered by the
 * `composeModelProvider` integration tests below. Mirrors pi-ai's own
 * `envApiKeyAuth.resolve` semantics, which our native resolve implements:
 * a non-empty stored credential key wins; a credential whose `key` is
 * undefined OR empty falls through to the env var (no usable key material).
 */
function resolveMockKey(
	credential: MockCredential | undefined,
	env: Record<string, string | undefined>,
): string | undefined {
	for (const source of AUTH_FALLBACK_CHAIN) {
		if (source === "auth-json" && credential?.key) {
			return credential.key;
		}
		if (source === "env" && env[MISTRAL_API_KEY_ENV_VAR] !== undefined) {
			return env[MISTRAL_API_KEY_ENV_VAR];
		}
	}
	return undefined;
}

/** The captured registration surface: which form, and what was registered. */
interface CapturedRegistration {
	/** "object" = native pi-ai Provider; "legacy" = string config. */
	form: "object" | "legacy";
	provider?: Provider;
	name?: string;
	config?: Record<string, unknown>;
}

/** Captures the pi.registerProvider call surface of the extension. */
function captureRegistration(): CapturedRegistration {
	let captured: CapturedRegistration | undefined;
	registerExtension({
		registerProvider(providerOrName: unknown, config?: unknown) {
			if (typeof providerOrName === "string") {
				captured = { form: "legacy", name: providerOrName, config: config as Record<string, unknown> };
			} else {
				captured = { form: "object", provider: providerOrName as Provider };
			}
		},
		on: () => undefined,
		registerTool: () => undefined,
		registerCommand: () => undefined,
	} as never);
	assert.ok(captured, "extension did not register a provider");
	return captured;
}

/** The captured native provider (asserts the object form first). */
function capturedProvider(): Provider {
	const captured = captureRegistration();
	assert.equal(captured.form, "object", "extension must register the native provider object");
	assert.ok(captured.provider, "captured native provider missing");
	return captured.provider;
}

/** pi's composed API-key auth over our captured native provider (compose base). */
async function composeCapturedApiKeyAuth(): Promise<ProviderAuth> {
	const { composeModelProvider } = await loadComposer();
	const provider = composeModelProvider(
		"mistral-native",
		capturedProvider(),
		noModelsConfig(),
		undefined,
	);
	const apiKey = provider.auth.apiKey as ProviderAuth | undefined;
	assert.ok(apiKey, "provider must expose api_key auth");
	return apiKey;
}

/** All compiled extension modules — the deployable surface pi loads. */
function readDistExtensionSources(): string[] {
	const dir = DIST_EXTENSIONS_DIR;
	// Recursive walk: extensions/mistral/*.js and extensions/tools/*.js are
	// part of the compiled surface pi loads, so the guards must cover them.
	const names = readdirSync(dir, { recursive: true })
		.map((entry) => String(entry))
		.filter((name) => name.endsWith(".js"));
	assert.ok(names.length > 0, "no compiled extension files found under dist/extensions");
	return names.map((name) => readFileSync(path.join(dir, name), "utf8"));
}

/** A temp user-scope config dir (PI_CODING_AGENT_DIR) with cleanup. */
function withTempAgentDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "mistral-auth-test-"));
	return (async () => {
		try {
			return await fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	})();
}

/**
 * A fully-pinned env bag for the region write's path resolution. The config
 * layer resolves each chain key with `env?.[name] ?? process.env[name]`: a
 * bag-present value wins over process.env — including the empty string,
 * which is the code's "unset" marker. Without the pin, a machine that
 * exports `XDG_CONFIG_HOME` system-wide (e.g. the Ubuntu 26.04 runner
 * image) would leak into the chain and a region-write test could write
 * "endpoint.region" into the REAL user config.
 */
function pinnedRegionEnv(overrides: Record<string, string>): Record<string, string | undefined> {
	return {
		PI_CODING_AGENT_DIR: "",
		XDG_CONFIG_HOME: "",
		HOME: tmpdir(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Registration surface: the native provider OBJECT.
// ---------------------------------------------------------------------------

test("provider registers as a native pi-ai Provider object with API-key auth, no OAuth", () => {
	const provider = capturedProvider();

	assert.equal(provider.id, "mistral-native");
	assert.equal(provider.name, "Mistral");
	assert.equal(provider.baseUrl, MISTRAL_BASE_URL);
	/*
	 * Native ApiKeyAuth present (the guided /login surface), no OAuth
	 * object: Mistral has no OAuth/device-code/refresh endpoints for the
	 * API, so the login surface must stay API-key only.
	 * ADR 0004 — API-key credential chain without Mistral OAuth
	 */
	assert.ok(provider.auth.apiKey, "provider must expose a native apiKey auth object");
	assert.ok(!("oauth" in provider.auth), "provider must not register an oauth object");
	assert.equal(typeof provider.auth.apiKey?.login, "function");
	assert.equal(typeof provider.auth.apiKey?.resolve, "function");
	assert.equal(typeof provider.auth.apiKey?.check, "function");
	const models = provider.getModels();
	assert.ok(
		models.some((model) => model.id === "mistral-large-4"),
		"provider catalog must contain mistral-large-4",
	);
	// BaseModel completeness: the native registration hands our models to
	// pi UNTOUCHED, so every catalog entry must carry provider and baseUrl —
	// an undefined model.provider would break request routing
	// (prepareRequest → getProvider(model.provider)).
	for (const model of models) {
		assert.equal(model.provider, "mistral-native", `model ${model.id} must carry the provider id`);
		assert.equal(model.baseUrl, MISTRAL_BASE_URL, `model ${model.id} must carry the base URL`);
		assert.equal(model.api, MISTRAL_API, `model ${model.id} must target the mistral-chat api`);
	}
});

test("documented fallback chain order is stored credential, then environment variable", () => {
	assert.deepEqual(AUTH_FALLBACK_CHAIN, ["auth-json", "env"]);
	assert.equal(MISTRAL_API_KEY_ENV_VAR, "MISTRAL_API_KEY");
});

// ---------------------------------------------------------------------------
// Native auth layer: our real ApiKeyAuth — login flow with a
// mocked interaction, resolve chain, availability check.
// ---------------------------------------------------------------------------

/** Records every prompt spec and notify event of a login interaction. */
function mockInteraction(answers: { secret: string; select: string }) {
	const promptCalls: Array<{ type: string; message: string; placeholder?: string; options?: unknown }> = [];
	const notifyCalls: Array<{ type: string; message: string }> = [];
	return {
		promptCalls,
		notifyCalls,
		interaction: {
			signal: new AbortController().signal,
			prompt: async (spec: {
				type: string;
				message: string;
				placeholder?: string;
				options?: unknown;
			}) => {
				promptCalls.push(spec);
				return spec.type === "secret" ? answers.secret : answers.select;
			},
			notify: (event: { type: string; message: string }) => {
				notifyCalls.push(event);
			},
		},
	};
}

test("native login: secret prompt first (console.mistral.ai guidance), then the region select", async () => {
	const writes: MistralRegion[] = [];
	const auth = createMistralApiKeyAuth({ writeRegion: (region) => writes.push(region) });
	const mock = mockInteraction({ secret: "test-key-123", select: "eu" });

	const credential = await auth.login?.(mock.interaction as never);

	assert.equal(mock.promptCalls.length, 2);
	const secret = mock.promptCalls[0]!;
	assert.equal(secret.type, "secret");
	assert.ok(
		secret.message.includes("console.mistral.ai"),
		"secret prompt must point at console.mistral.ai",
	);
	assert.equal(secret.placeholder, "sk-…");
	const select = mock.promptCalls[1]!;
	assert.equal(select.type, "select");
	assert.equal(select.message, "Region");
	const options = select.options as { id: string; label: string; description: string }[];
	assert.deepEqual(options.map((option) => option.id), ["global", "eu", "us"]);
	for (const option of options) {
		assert.ok(option.label.length > 0, `region option "${option.id}" needs a label`);
		assert.ok(option.description.length > 0, `region option "${option.id}" needs a description`);
	}
	// The region options are the exported constants (single source of truth).
	assert.deepEqual(options, [...MISTRAL_REGION_LOGIN_OPTIONS]);

	// The returned credential: pi persists it in auth.json itself.
	assert.deepEqual(credential, { type: "api_key", key: "test-key-123" });
	// A non-global region reaches the injected region writer.
	assert.deepEqual(writes, ["eu"]);
	// Progress notification after the region write, exact message, no key material.
	assert.deepEqual(mock.notifyCalls, [
		{ type: "progress", message: 'Saved region "eu" to the user-scope mistral-native.json' },
	]);
});

test("native login: region \"global\" writes nothing and returns the credential", async () => {
	const writes: MistralRegion[] = [];
	const auth = createMistralApiKeyAuth({ writeRegion: (region) => writes.push(region) });
	const mock = mockInteraction({ secret: "test-key-123", select: "global" });

	const credential = await auth.login?.(mock.interaction as never);

	assert.deepEqual(writes, [], "global is the no-config default — no region write");
	assert.deepEqual(mock.notifyCalls, [], "no region write → no progress notification");
	assert.deepEqual(credential, { type: "api_key", key: "test-key-123" });
});

test("native login: an empty API key rejects", async () => {
	const auth = createMistralApiKeyAuth({ writeRegion: () => assert.fail("must not write") });
	const mock = mockInteraction({ secret: "   ", select: "eu" });
	await assert.rejects(auth.login?.(mock.interaction as never) ?? Promise.reject(new Error("missing login")), /empty/);
});

test("native login: an unknown region id rejects without writing", async () => {
	const auth = createMistralApiKeyAuth({ writeRegion: () => assert.fail("must not write") });
	const mock = mockInteraction({ secret: "test-key-123", select: "ap-southeast" });
	await assert.rejects(auth.login?.(mock.interaction as never) ?? Promise.reject(new Error("missing login")), /region/);
});

test("native login: an aborted signal rejects before prompting", async () => {
	const auth = createMistralApiKeyAuth({ writeRegion: () => assert.fail("must not write") });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		auth.login?.({
			signal: controller.signal,
			prompt: async () => assert.fail("must not prompt after abort"),
			notify: () => assert.fail("must not notify after abort"),
		} as never) ?? Promise.reject(new Error("missing login")),
		/abort/i,
	);
});

test("native resolve: stored credential wins over the env var and propagates credential.env", async () => {
	const auth = createMistralApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const resolved = await auth.resolve({
		// Provider env on the credential (e.g. a hand-authored MISTRAL_AGENT_ID)
		// must reach the request's options.env: the resolve propagates
		// credential env alongside the resolved key.
		credential: { type: "api_key", key: "stored-fake-key", env: { MISTRAL_AGENT_ID: "agent-123" } },
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(resolved?.auth.apiKey, "stored-fake-key");
	assert.equal(resolved?.source, "stored credential");
	assert.deepEqual(resolved?.env, { MISTRAL_AGENT_ID: "agent-123" }, "credential.env must propagate to the resolved env");
});

test("native resolve: the env-var branch carries no credential env", async () => {
	const auth = createMistralApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const resolved = await auth.resolve({ ctx, signal: new AbortController().signal });
	assert.equal(resolved?.auth.apiKey, "env-fake-key");
	assert.equal(resolved?.env, undefined, "no credential → no credential env");
});

test("native resolve: env fallback when no credential is stored (env-only regression)", async () => {
	// The zero-configuration default must keep working byte-for-byte for
	// users who never run /login: resolve falls back to MISTRAL_API_KEY.
	const auth = createMistralApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const resolved = await auth.resolve({ ctx, signal: new AbortController().signal });
	assert.equal(resolved?.auth.apiKey, "env-fake-key");
	assert.equal(resolved?.source, "MISTRAL_API_KEY");
});

test("native resolve: both missing → undefined (unconfigured, never a throw)", async () => {
	// pi's availability probes call resolve(); undefined = unconfigured.
	// Throwing would break those probes, so this pins the non-throw contract.
	const auth = createMistralApiKeyAuth();
	const ctx = makeAuthCtx({});
	const resolved = await auth.resolve({ ctx, signal: new AbortController().signal });
	assert.equal(resolved, undefined);
});

test("native resolve: a credential with an undefined or empty key falls through to env", async () => {
	// Mirrors pi-ai's own envApiKeyAuth.resolve (truthiness): a stored
	// credential whose `key` is undefined OR empty (a hand-edited auth.json
	// entry "key": "") carries no usable key material, so the env fallback
	// applies. (`key` absent ≡ undefined at runtime; exactOptionalPropertyTypes
	// forbids spelling that explicitly, so the empty-string case is spelled
	// as `key: ""` instead.)
	const auth = createMistralApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const undefinedKey = await auth.resolve({
		credential: { type: "api_key" },
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(undefinedKey?.auth.apiKey, "env-fake-key");
	assert.equal(undefinedKey?.source, "MISTRAL_API_KEY");
	const emptyKey = await auth.resolve({
		credential: { type: "api_key", key: "" },
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(emptyKey?.auth.apiKey, "env-fake-key", "an empty-string key must not yield Bearer <empty>");
	assert.equal(emptyKey?.source, "MISTRAL_API_KEY");
});

test("native check: reports the sources without resolving the key", async () => {
	const auth = createMistralApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const storedCheck = await auth.check?.({
		ctx,
		credential: { type: "api_key", key: "stored-fake-key" },
		signal: new AbortController().signal,
	});
	assert.deepEqual(storedCheck, { type: "api_key", source: "stored credential" });
	const envCheck = await auth.check?.({ ctx, signal: new AbortController().signal });
	assert.deepEqual(envCheck, { type: "api_key", source: "MISTRAL_API_KEY" });
	const noneCheck = await auth.check?.({
		ctx: makeAuthCtx({}),
		signal: new AbortController().signal,
	});
	assert.equal(noneCheck, undefined);
});

test("native check: an empty-string credential key falls through to the env check", async () => {
	// Truthiness mirrors pi-ai's envApiKeyAuth: a hand-edited "key": ""
	// credential is not a usable key, so check() must not report it as
	// "stored credential" — it falls through to the env var probe.
	const auth = createMistralApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const emptyKeyCheck = await auth.check?.({
		ctx,
		credential: { type: "api_key", key: "" },
		signal: new AbortController().signal,
	});
	assert.deepEqual(emptyKeyCheck, { type: "api_key", source: MISTRAL_API_KEY_ENV_VAR });
});

// ---------------------------------------------------------------------------
// Region write layer: the real writeUserMistralRegion against
// temp-dir file chains — never the developer's real user config.
// ---------------------------------------------------------------------------

test("region write: merges endpoint.region into an existing user config, preserving content", async () => {
	await withTempAgentDir(async (dir) => {
		const target = path.join(dir, "mistral-native.json");
		writeFileSync(
			target,
			JSON.stringify({ endpoint: { baseUrl: "https://x.example" }, models: { fallThrough: true } }, null, "\t"),
		);
		const before = readFileSync(target, "utf8");

		writeUserMistralRegion("eu", pinnedRegionEnv({ PI_CODING_AGENT_DIR: dir }));

		const parsed = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
		const endpoint = parsed.endpoint as { region?: string; baseUrl?: string };
		assert.equal(endpoint.region, "eu");
		assert.equal(endpoint.baseUrl, "https://x.example", "existing baseUrl must survive the merge");
		assert.deepEqual(parsed.models, { fallThrough: true }, "unrelated sections must survive");
		assert.notEqual(readFileSync(target, "utf8"), before, "the file must actually be rewritten");
		// Credential boundary: no key material in the config file.
		assert.ok(!readFileSync(target, "utf8").includes("key"), "config file must never contain key material");
	});
});

test("region write: a nonexistent config path creates the file with only endpoint.region", async () => {
	await withTempAgentDir(async (dir) => {
		const target = path.join(dir, "mistral-native.json");
		assert.ok(!existsSync(target));

		writeUserMistralRegion("us", pinnedRegionEnv({ PI_CODING_AGENT_DIR: dir }));

		assert.ok(existsSync(target), "the region write must create the config file");
		const parsed = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
		assert.deepEqual(parsed, { endpoint: { region: "us" } });
		assert.ok(!readFileSync(target, "utf8").includes("key"), "config file must never contain key material");
	});
});

test("region write: an existing unparseable file is left untouched, with a descriptive error", async () => {
	await withTempAgentDir(async (dir) => {
		const target = path.join(dir, "mistral-native.json");
		writeFileSync(target, "{ not json");
		const before = readFileSync(target, "utf8");

		assert.throws(() => writeUserMistralRegion("eu", pinnedRegionEnv({ PI_CODING_AGENT_DIR: dir })), /not valid JSON/);
		assert.equal(readFileSync(target, "utf8"), before, "a failed merge must not clobber the file");
	});
});

test("region write: an existing endpoint object with unknown keys refuses to merge", async () => {
	await withTempAgentDir(async (dir) => {
		const target = path.join(dir, "mistral-native.json");
		const before = JSON.stringify({ endpoint: { region: "global", proxy: "x" } });
		writeFileSync(target, before);

		// Mirrors the loader's strict validation (endpoint keys ⊂ {region, baseUrl}).
		assert.throws(() => writeUserMistralRegion("eu", pinnedRegionEnv({ PI_CODING_AGENT_DIR: dir })), /endpoint\.proxy/);
		assert.equal(readFileSync(target, "utf8"), before, "a failed merge must not clobber the file");
	});
});

test("region write: login writes the region to the first existing user-config chain hop", async () => {
	await withTempAgentDir(async (dir) => {
		// PI_CODING_AGENT_DIR is NOT set in the bag: the chain head is the
		// agent-dir hop, the first EXISTING file is the temp-home XDG default
		// ($XDG_CONFIG_HOME unset → ~/.config/pi/…), and the write must land
		// there — the loader reads the first existing file, so the write must
		// land where it will be read. The pinned bag isolates the chain from
		// the developer's real PI_CODING_AGENT_DIR/XDG_CONFIG_HOME.
		const head = path.join(dir, "mistral-native.json");
		const home = mkdtempSync(join(tmpdir(), "mistral-auth-home-"));
		try {
			const xdg = path.join(home, ".config", "pi", "mistral-native.json");
			mkdirSync(path.dirname(xdg), { recursive: true });
			writeFileSync(xdg, JSON.stringify({ endpoint: { baseUrl: "https://xdg.example" } }));
			// No PI_CODING_AGENT_DIR: the XDG hop is the first existing file.
			writeUserMistralRegion("eu", pinnedRegionEnv({ HOME: home }));

			const parsedXdg = JSON.parse(readFileSync(xdg, "utf8")) as { endpoint: { region?: string; baseUrl?: string } };
			assert.equal(parsedXdg.endpoint.region, "eu");
			assert.equal(parsedXdg.endpoint.baseUrl, "https://xdg.example");
			assert.ok(!existsSync(head), "nothing may be written outside the first existing chain hop");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

test("/logout boundary: the config file is not party to the credential", async () => {
	await withTempAgentDir(async (dir) => {
		// Real login with the real region write (default deps), env isolated
		// to the temp agent dir (pinned bag: the write can never escape to the
		// developer's real chain) — the credential goes to pi's auth.json, the
		// region to the user-scope config. /logout has no extension hook (pi
		// deletes the auth.json entry itself), so the boundary to pin is: the
		// config file is not party to the credential — it holds the region and
		// no key material, so a logout (credential removal) has nothing to
		// change there.
		const auth = createMistralApiKeyAuth({ env: pinnedRegionEnv({ PI_CODING_AGENT_DIR: dir }) });
		const mock = mockInteraction({ secret: "test-key-123", select: "eu" });
		await auth.login?.(mock.interaction as never);

		const target = path.join(dir, "mistral-native.json");
		const afterLogin = readFileSync(target, "utf8");
		// The API key must never reach the config file (credential boundary).
		assert.ok(!afterLogin.includes("test-key-123"), "the API key must never be written to the config");
		// The region selection is the config file's only login artifact.
		const parsed = JSON.parse(afterLogin) as { endpoint: { region: string } };
		assert.equal(parsed.endpoint.region, "eu", "the region selection survives a logout by construction");
		// /logout is a pure credential-store operation: it removes the
		// auth.json entry and touches nothing else. The config file's content
		// is exactly what the login wrote — nothing in a logout could rewrite
		// it — and the bytes are pinned so a future region-write regression
		// (e.g. an accidental logout-triggered rewrite) fails loudly.
		assert.equal(readFileSync(target, "utf8"), afterLogin, "the config file must be unaffected by logout");
	});
});

// ---------------------------------------------------------------------------
// Integration layer: pi's REAL composed auth chain (pi-coding-agent 1.4.0)
// over our captured native provider as the compose base. These tests run the
// actual `composeApiKeyAuth` wrapping logic, so any drift between the
// extension's native auth and pi's composition fails here.
// ---------------------------------------------------------------------------

test("pi composer: stored credential wins over the environment variable", async () => {
	const apiKeyAuth = await composeCapturedApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const resolved = await apiKeyAuth.resolve({
		credential: { type: "api_key", key: "stored-fake-key" },
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(resolved?.auth.apiKey, "stored-fake-key");
	assert.equal(resolved?.source, "stored credential");
});

test("pi composer: a credential's provider env propagates through the composed resolve", async () => {
	// The composed wrapper spreads our native resolve's result, so the
	// stored credential's provider env (e.g. a hand-authored
	// MISTRAL_AGENT_ID) must survive pi's composition and reach the
	// request's options.env — pi's composition must propagate credential
	// env.
	const apiKeyAuth = await composeCapturedApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const resolved = await apiKeyAuth.resolve({
		credential: { type: "api_key", key: "stored-fake-key", env: { MISTRAL_AGENT_ID: "agent-123" } },
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(resolved?.auth.apiKey, "stored-fake-key");
	assert.deepEqual(resolved?.env, { MISTRAL_AGENT_ID: "agent-123" }, "credential.env must survive pi's composition");
});

test("pi composer: environment-variable fallback when no credential is stored", async () => {
	const apiKeyAuth = await composeCapturedApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const resolved = await apiKeyAuth.resolve({
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(resolved?.auth.apiKey, "env-fake-key");
	assert.equal(resolved?.source, "MISTRAL_API_KEY");
});

test("pi composer: unconfigured resolves undefined (our native resolve contract, no throw)", async () => {
	const apiKeyAuth = await composeCapturedApiKeyAuth();
	const ctx = makeAuthCtx({}); // MISTRAL_API_KEY unset, no credential
	// With the native auth, an unconfigured provider resolves
	// undefined instead of throwing pi's generic resolution error — pi's
	// availability probes rely on that.
	const resolved = await apiKeyAuth.resolve({ ctx, signal: new AbortController().signal });
	assert.equal(resolved, undefined);
});

test("pi composer: a stored credential with an undefined or empty key falls through to env (native semantics)", async () => {
	const apiKeyAuth = await composeCapturedApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	// Our native resolve mirrors pi-ai's envApiKeyAuth (truthiness): a
	// stored credential whose `key` is undefined OR empty carries no usable
	// key material, so the env fallback is consulted. (`key` absent ≡
	// undefined at runtime; exactOptionalPropertyTypes forbids spelling that
	// explicitly, so the empty-string case is spelled as `key: ""`.)
	const undefinedKey = await apiKeyAuth.resolve({
		credential: { type: "api_key" },
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(undefinedKey?.auth.apiKey, "env-fake-key");
	assert.equal(undefinedKey?.source, "MISTRAL_API_KEY");
	const emptyKey = await apiKeyAuth.resolve({
		credential: { type: "api_key", key: "" },
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(emptyKey?.auth.apiKey, "env-fake-key", "an empty-string key must not yield Bearer <empty>");
	assert.equal(emptyKey?.source, "MISTRAL_API_KEY");
});

test("pi composer: check() reports the same sources without resolving the key", async () => {
	const apiKeyAuth = await composeCapturedApiKeyAuth();
	const ctx = makeAuthCtx({ MISTRAL_API_KEY: "env-fake-key" });
	const storedCheck = await apiKeyAuth.check?.({
		ctx,
		credential: { type: "api_key", key: "stored-fake-key" },
		signal: new AbortController().signal,
	});
	assert.equal(storedCheck?.type, "api_key");
	assert.equal(storedCheck?.source, "stored credential");
	const envCheck = await apiKeyAuth.check?.({
		ctx,
		signal: new AbortController().signal,
	});
	assert.equal(envCheck?.type, "api_key");
	assert.equal(envCheck?.source, "MISTRAL_API_KEY");
});

test("pi composer: /login runs OUR guided flow through the composed auth (secret then region select)", async () => {
	const apiKeyAuth = await composeCapturedApiKeyAuth();
	assert.ok(apiKeyAuth.login, "the composed auth must expose the native login");
	const mock = mockInteraction({ secret: "prompted-fake-key", select: "global" });
	// The composed login must be our native guided login, passed through
	// untouched, not a generic secret prompt.
	const credential = await apiKeyAuth.login(mock.interaction as never);
	assert.equal(mock.promptCalls[0]?.type, "secret");
	assert.ok(
		String(mock.promptCalls[0]?.message).includes("console.mistral.ai"),
		"the composed login must run the extension's guided secret prompt",
	);
	assert.equal(mock.promptCalls[1]?.type, "select", "the composed login must run the region select");
	assert.deepEqual(credential, { type: "api_key", key: "prompted-fake-key" });
});

test("pi composer: base-only compose passes our provider through untouched (no models.json overlays)", async () => {
	const { composeModelProvider } = await loadComposer();
	const provider = composeModelProvider("mistral-native", capturedProvider(), noModelsConfig(), undefined) as {
		getModels: () => { id: string }[];
		baseUrl?: string;
		auth: Record<string, unknown>;
	};
	// No models.json config and no extension config: the composed provider is
	// our base — same models, same base URL, same auth surface.
	assert.ok(provider.getModels().some((model) => model.id === "mistral-large-4"));
	assert.equal(provider.baseUrl, MISTRAL_BASE_URL);
	assert.ok(provider.auth.apiKey, "composed provider must keep the native api_key auth");
	assert.ok(!("oauth" in provider.auth), "composed provider must not gain an oauth object");
});

// ---------------------------------------------------------------------------
/*
 * Contract-pin layer: the exported AUTH_FALLBACK_CHAIN and its documented
 * semantics. These pins do not exercise pi; they keep the exported constant
 * and docs honest (pi's actual behavior is covered above).
 * ADR 0004 — API-key credential chain without Mistral OAuth
 */
// ---------------------------------------------------------------------------

test("mock chain: stored auth.json credential preferred over env (documented contract)", () => {
	const stored = "stored-fake-key";
	const env = { MISTRAL_API_KEY: "env-fake-key" };

	assert.equal(resolveMockKey({ type: "api_key", key: stored }, env), stored);
	// After /logout (no stored credential) the env var is used.
	assert.equal(resolveMockKey(undefined, env), "env-fake-key");
	assert.equal(resolveMockKey(undefined, {}), undefined);
});

test("mock chain: a credential with an undefined or empty key falls through to env (native semantics, mirrored)", () => {
	// Our native resolve (mirroring pi-ai's envApiKeyAuth, truthiness)
	// consults the env fallback when a stored credential carries no usable
	// key material; asserted against the real composer in the integration
	// tests above. (`key` absent ≡ undefined at runtime;
	// exactOptionalPropertyTypes forbids writing that explicitly, so the
	// empty-string case is spelled as `key: ""` instead.)
	const resolved = resolveMockKey({ type: "api_key" }, {
		MISTRAL_API_KEY: "env-fake-key",
	});
	assert.equal(resolved, "env-fake-key");
	const emptyResolved = resolveMockKey({ type: "api_key", key: "" }, {
		MISTRAL_API_KEY: "env-fake-key",
	});
	assert.equal(emptyResolved, "env-fake-key", "an empty-string key is not a usable key");
});

test("!command credentials resolve via a cross-platform subprocess", async () => {
	// `!command` auth.json entries (secret-manager pattern) are executed by
	// pi itself at resolve time — the credential reaches our resolve already
	// resolved. Here we only pin the subprocess semantics pi builds on —
	// command stdout, trimmed — using a command that exists on every
	// supported platform (including win32), not `printf`.
	const out = await execFileAsync(process.execPath, [
		"-e",
		"process.stdout.write('command-fake-key')",
	]);
	assert.equal(out.stdout.trim(), "command-fake-key");
});

test("credential command subprocess honors the abort signal (Node semantics pin)", async () => {
	/*
	 * NOTE: this pins Node/AbortController subprocess semantics, NOT
	 * extension behavior — the extension performs no login network requests,
	 * so there is no login request to cancel. The residual cancellation
	 * surfaces are pi's request-time `!command` resolution, the login flow's
	 * abort signal (pinned above), and the request-time streamSimple abort
	 * path. Uses `timers/promises` (no `sleep` binary) so the suite runs on
	 * win32.
	 * ADR 0004 — API-key credential chain without Mistral OAuth
	 */
	const controller = new AbortController();
	const pending = sleep(30_000, undefined, { signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, /abort/i);
	assert.equal(controller.signal.aborted, true);
});

// ---------------------------------------------------------------------------
// Static guards over the compiled extension — the code pi actually loads.
// ---------------------------------------------------------------------------

test("compiled extension registers no OAuth implementation remnants", () => {
	// The word "OAuth" may legitimately appear in the extension's prose
	// comments, so this guard matches only implementation-only OAuth
	// markers that explanatory prose cannot contain: pi oauth-object
	// members (refreshToken, getApiKey), wire-level OAuth constants
	// (grant_type, client_id), and OAuth endpoint hosts/paths. The walk is
	// recursive over ALL compiled extension modules
	// (extensions/mistral/*.js, extensions/tools/*.js), so a future helper
	// module cannot evade it. The `getApiKey` marker excludes
	// `getApiKeyForProvider` — pi's model-registry accessor the
	// knowledge/connector tools legitimately use to READ the resolved
	// provider key; it is not pi's OAuth `oauth.getApiKey()` member (the
	// actual remnant this guard bans).
	const sources = readDistExtensionSources();
	for (const source of sources) {
		assert.ok(
			!/refreshToken|getApiKey(?!ForProvider)|grant_type|client_id|\/oauth\/|oauth\.mistral/i.test(source),
			"OAuth implementation remnants in compiled extension source",
		);
	}
	// The provider registers native auth rather than an
	// `apiKey: "$MISTRAL_API_KEY"` spec string: the env fallback is read
	// by name in the native resolve — the name must survive compilation.
	assert.ok(
		sources.some((source) => source.includes(MISTRAL_API_KEY_ENV_VAR)),
		"MISTRAL_API_KEY env fallback missing from the compiled extension",
	);
});

test("compiled extension contains no logging sinks (no key material can be printed)", () => {
	/*
	 * Static guard on the actual invariant: the extension must not write to
	 * any output stream, so no code path can print key material (or anything
	 * else). The extension performs no logging by design; this keeps it that
	 * way. The walk is recursive over ALL compiled extension modules, and the
	 * `console.` marker requires a following method CALL:
	 * `console.<method>(…)` catches every console method invocation while
	 * sparing the login prompt's legitimate "https://console.mistral.ai" URL
	 * string (no call syntax) — only a call expression is a sink.
	 * ADR 0004 — API-key credential chain without Mistral OAuth
	 */
	const sources = readDistExtensionSources();
	for (const source of sources) {
		assert.ok(
			!/console\.\w+\s*\(|process\.stdout|process\.stderr/.test(source),
			"logging sink in compiled extension source",
		);
	}
});
