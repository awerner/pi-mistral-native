/**
 * Native API-key auth for the `mistral-native` provider.
 *
 * pi drives `/login` and `/logout` end-to-end: it runs our `login()` flow and
 * persists the returned credential in `~/.pi/agent/auth.json` itself, and
 * `/logout` deletes it. The guided login prompts for the API key (`secret`,
 * no echo) and then for the API region (`select`); a non-global region is
 * written to `endpoint.region` in the user-scope `mistral-native.json`
 * (extensions/mistral/config.ts — the region key the stream routes by).
 * The API key itself never touches our config file (only pi's auth.json
 * stores key material).
 *
 * `resolve()` implements the credential chain natively: stored credential
 * key, then the `MISTRAL_API_KEY` environment variable; `undefined` when both
 * are missing (unconfigured — pi's availability probes rely on that). The
 * side-effect-free `check()` reports the same sources without resolving the
 * key itself. pi itself resolves `!command` auth.json entries before the
 * credential reaches us.
 *
 * Everything pi forwards to us (`prompt`, `notify`, `signal`) is typed; pi
 * relays those prompts to RPC clients as-is, so remote sessions get the same
 * guided flow. The module performs no logging and never includes key
 * material in any error or notify message.
 *
 * ADR 0004 — API-key credential chain without Mistral OAuth
 * ADR 0012 — Selectable region endpoint with per-family routing
 */

import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "@earendil-works/pi-ai";

import { writeUserMistralRegion } from "./config.js";
import type { MistralRegion } from "./config.js";

/**
 * The env var of the chain's env fallback. Kept in sync
 * with `MISTRAL_API_KEY_ENV_VAR` in extensions/mistral.ts (pinned by tests);
 * defined locally because importing the extension entry would cycle
 * (mistral.ts imports this module).
 *
 * ADR 0004 — API-key credential chain without Mistral OAuth
 */
export const MISTRAL_API_KEY_ENV_VAR = "MISTRAL_API_KEY";

/** Narrow structural type over pi's `ProviderAuthInteraction` prompt surface. */
interface LoginInteraction {
	signal: AbortSignal;
	prompt(prompt: {
		type: "secret" | "select";
		message: string;
		placeholder?: string;
		options?: readonly { id: string; label: string; description?: string }[];
	}): Promise<string>;
	notify(event: { type: "progress"; message: string }): void;
}

/**
 * The region options of the guided login's `select` prompt. The
 * ids are `MistralRegion` values; the selection maps to `endpoint.region`.
 * "global" writes nothing — it is the no-config
 * default; the descriptions mirror the routing split (regional chat
 * + catalog, global knowledge/server-tool/agent surfaces, +10% surcharge).
 *
 * ADR 0012 — Selectable region endpoint with per-family routing
 */
export const MISTRAL_REGION_LOGIN_OPTIONS: readonly {
	id: MistralRegion;
	label: string;
	description: string;
}[] = [
	{
		id: "global",
		label: "Global — api.mistral.ai",
		description: "Default. Full feature set; all Mistral services available.",
	},
	{
		id: "eu",
		label: "EU — api.eu.mistral.ai",
		description:
			"EU data residency for chat and the model catalog. Knowledge APIs, server-side tools and agent mode stay on the global endpoint. +10% token surcharge.",
	},
	{
		id: "us",
		label: "US — api.us.mistral.ai",
		description:
			"US data residency for chat and the model catalog. Knowledge APIs, server-side tools and agent mode stay on the global endpoint. +10% token surcharge.",
	},
];

/** Injected region-write dependency: default is the real user-scope config write. */
export type RegionWriteFn = (region: MistralRegion, env?: Record<string, string | undefined>) => void;

/**
 * Injectable dependencies so tests can mock the file chain without touching
 * the real user config (`createMistralApiKeyAuth({ writeRegion })`).
 */
export interface MistralApiKeyAuthDeps {
	/** Region write (default: `writeUserMistralRegion` from config.ts). */
	writeRegion?: RegionWriteFn;
	/** Env bag for the region write's path resolution (default: process.env). */
	env?: Record<string, string | undefined>;
}

/** Ensure a region id is one of the select options' ids. */
function assertKnownRegion(region: string): asserts region is MistralRegion {
	if (region !== "global" && region !== "eu" && region !== "us") {
		throw new Error(`Unknown Mistral region "${region}"; must be one of: "global", "eu", "us"`);
	}
}

/**
 * Build the provider's `ApiKeyAuth`. Dependency-injectable for
 * tests; the default writer is the real user-scope config write.
 */
export function createMistralApiKeyAuth(deps: MistralApiKeyAuthDeps = {}): ApiKeyAuth {
	const writeRegion: RegionWriteFn = deps.writeRegion ?? writeUserMistralRegion;
	const env = deps.env;
	return {
		name: "Mistral API key",
		/**
		 * Guided login: secret prompt for the API key, then a select prompt
		 * for the region. pi persists the returned credential itself; a
		 * non-global region is written to the user-scope config (the region
		 * key the stream routes by). Key material never reaches the
		 * config write, any error message, or any notify message.
		 */
		login: async (interaction) => {
			const ui = interaction as unknown as LoginInteraction;
			ui.signal.throwIfAborted();
			const key = await ui.prompt({
				type: "secret",
				message: "Mistral API key (create one at https://console.mistral.ai/api-keys)",
				placeholder: "sk-…",
			});
			ui.signal.throwIfAborted();
			if (key.trim().length === 0) throw new Error("Mistral API key must not be empty");
			ui.signal.throwIfAborted();
			const region = await ui.prompt({
				type: "select",
				message: "Region",
				options: MISTRAL_REGION_LOGIN_OPTIONS,
			});
			ui.signal.throwIfAborted();
			assertKnownRegion(region);
			if (region !== "global") {
				writeRegion(region, env);
				ui.notify({
					type: "progress",
					message: `Saved region "${region}" to the user-scope mistral-native.json`,
				});
			}
			return { type: "api_key", key };
		},
		/**
		 * Side-effect-free availability probe (never resolves the key
		 * itself): stored credential, then the env var, else undefined.
		 * Key truthiness mirrors pi-ai's `envApiKeyAuth`: a credential whose
		 * `key` is undefined OR empty (hand-edited auth.json) carries no usable
		 * key material, so the probe falls through to the env var.
		 */
		check: async ({ ctx, credential }) => {
			if (credential?.key) return { type: "api_key", source: "stored credential" };
			if ((await ctx.env(MISTRAL_API_KEY_ENV_VAR)) !== undefined) {
				return { type: "api_key", source: MISTRAL_API_KEY_ENV_VAR };
			}
			return undefined;
		},
		/**
		 * The credential chain, native: stored credential key wins, then the
		 * `MISTRAL_API_KEY` env var; `undefined` when both are missing
		 * (unconfigured — must not throw; pi's availability probes rely on it).
		 * Mirrors pi-ai's canonical `envApiKeyAuth` (auth/helpers.js) on both
		 * edges: a stored credential whose `key` is undefined OR empty carries
		 * no usable key material, so the env fallback is consulted; and the
		 * stored credential's provider env (`credential.env`, e.g. a
		 * hand-authored MISTRAL_AGENT_ID) is propagated to the request's
		 * options.env — the env-var branch has no credential, so no env.
		 *
		 * ADR 0004 — API-key credential chain without Mistral OAuth
		 */
		resolve: async ({ ctx, credential }) => {
			if (credential?.key) {
				// exactOptionalPropertyTypes forbids `env: undefined` in the
				// literal, so the credential's provider env is spread in only when
				// present — semantically identical to envApiKeyAuth's
				// `env: credential.env`.
				return {
					auth: { apiKey: credential.key },
					...(credential.env ? { env: credential.env } : {}),
					source: "stored credential",
				};
			}
			const envKey = await ctx.env(MISTRAL_API_KEY_ENV_VAR);
			if (envKey !== undefined) {
				return { auth: { apiKey: envKey }, source: MISTRAL_API_KEY_ENV_VAR };
			}
			return undefined;
		},
	};
}

/** Structural re-exports for tests (pi's narrow AuthContext surface). */
export type { AuthContext, ApiKeyCredential };
