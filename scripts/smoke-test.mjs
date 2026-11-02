#!/usr/bin/env node
/**
 * Live smoke tests for the mistral-native provider (issue #21).
 *
 * Runs the four live checks deferred across issues #1, #2, #5 and #6 against
 * the locally built package (`pi -e ./`):
 *   1. stream with thinking ON via `pi -p --provider mistral-native
 *      --model mistral-large-4` — multi-turn + tool calls, clean output,
 *      no `[object Object]`
 *   2. RAG: upload a tiny throwaway file -> library -> document upload ->
 *      mistral_document_query (streaming default), then Mistral-side cleanup
 *   3. live model catalog: pi --list-models shows the mistral-native catalog
 *      after a network refresh (>= 5 models; the static fallback is 1)
 *   4. one live mistral_ocr call (tiny generated PNG data URL)
 *
 * Prerequisites: `npm run build` (dist/ must exist) and a working Mistral
 * API key available to pi — a stored `mistral-native` credential in
 * ~/.pi/agent/auth.json (via /login) or $MISTRAL_API_KEY in the environment.
 * The key is never printed, logged or committed; live responses are reduced
 * to short pass/fail markers and matched substrings.
 *
 * Usage:
 *   node scripts/smoke-test.mjs [--skip=<scenario>]...
 * Scenarios: stream, rag, catalog, ocr (default: all four).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SCENARIOS = ["stream", "rag", "catalog", "ocr"];
const skips = new Set(
	process.argv
		.filter((arg) => arg.startsWith("--skip="))
		.flatMap((arg) => arg.slice("--skip=".length).split(","))
		.filter((arg) => SCENARIOS.includes(arg)),
);
if (process.argv.some((arg) => arg.startsWith("--skip="))) {
	// Unknown skip names are ignored; valid ones are in SCENARIOS above.
}
const results = [];

function record(scenario, status, detail) {
	results.push({ scenario, status, detail });
	const mark = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
	console.log(`[${mark}] ${scenario}: ${detail}`);
}

/** Read the key from ~/.pi/agent/auth.json .mistral.key (never printed). */
function readStoredKey() {
	try {
		const raw = execFileSync("jq", ["-r", ".mistral.key", join(process.env.HOME, ".pi/agent/auth.json")], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const key = raw.trim();
		return key.length > 0 && key !== "null" ? key : undefined;
	} catch {
		return undefined;
	}
}

/** Run pi -e ./ with the given args; MISTRAL_API_KEY is exported only when the env lacks it. Returns stdout+stderr trimmed. */
function runPi(args, { timeoutMs = 300_000 } = {}) {
	const env = { ...process.env };
	if (!env.MISTRAL_API_KEY) {
		const key = readStoredKey();
		if (key) env.MISTRAL_API_KEY = key; // piped to the child only, never echoed
	}
	const res = spawnSync("pi", ["-e", "./", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: timeoutMs });
	return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

/**
 * Scenario 1 (stream, thinking ON): one pi -p turn with --thinking high must
 * produce clean text, no [object Object], and a tool call executed against
 * bash (multi-turn + tool calls through the same stream).
 */
async function scenarioStream() {
	if (skips.has("stream")) return record("stream", "skip", "skipped by --skip=stream");
	const prompt =
		"Use the bash tool to run: echo smoke-marker-$((21*2)) — then answer in exactly one short sentence with the command's exact output.";
	const { status, out } = runPi([
		"-p", prompt,
		"--provider", "mistral-native",
		"--model", "mistral-large-4",
		"--thinking", "high",
		"--no-session",
	]);
	const cleaned = out.replace(/\x1b\[[0-9;]*m/g, "");
	const problems = [];
	if (status !== 0) problems.push(`pi exited ${status}`);
	if (/\[object Object\]|\[object object\]/.test(cleaned)) problems.push("[object Object] leaked into output");
	if (!/smoke-marker-42/.test(cleaned)) problems.push("expected tool-call output missing (no smoke-marker-42)");
	if (cleaned.length === 0) problems.push("empty output");
	return record("stream", problems.length ? "fail" : "pass", problems.join("; ") || "thinking ON, tool call executed, clean output");
}

/**
 * Raw REST helpers for setup/cleanup. The pi tools cover create/upload/query
 * but expose no delete (cleanup is out of their scope), so the script drives
 * the same documented endpoints directly. Secret discipline: the key is used
 * only in the Authorization header; response bodies are reduced to the
 * fields the script needs.
 */
const API = "https://api.mistral.ai/v1";

async function apiCall(path, { method = "GET", body, form } = {}) {
	const key = process.env.MISTRAL_API_KEY ?? readStoredKey();
	if (!key) throw new Error("no Mistral API key available");
	const headers = { Authorization: `Bearer ${key}` };
	let payload;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		payload = JSON.stringify(body);
	} else if (form !== undefined) {
		payload = form; // prebuilt FormData
	}
	const res = await fetch(`${API}${path}`, { method, headers, body: payload });
	if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
	return res.json();
}

// --- main runner (all scenarios declared above) ---

/** Scenario 2 (RAG): throwaway file -> library -> document -> pi document_query -> cleanup. */
async function scenarioRag() {
	if (skips.has("rag")) return record("rag", "skip", "skipped by --skip=rag");
	const phrase = `indigo-falcon-${Math.floor(Math.random() * 9000 + 1000)}`;
	const scratch = mkdtempSync(join(tmpdir(), "mistral-smoke-"));
	const docPath = join(scratch, "smoke.txt");
	writeFileSync(docPath, `The smoke test secret phrase is: ${phrase}. Answer questions using only this document.\n`);
	let libraryId;
	const problems = [];
	try {
		const lib = await apiCall("/libraries", { method: "POST", body: { name: `pi-smoke-${Date.now()}`, description: "smoke-test throwaway" } });
		libraryId = lib.id;
		const bytes = await readFile(docPath);
		const form = new FormData();
		form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "smoke.txt");
		const doc = await apiCall(`/libraries/${libraryId}/documents`, { method: "POST", form });
		for (let i = 0; i < 30; i++) {
			const st = await apiCall(`/libraries/${libraryId}/documents/${doc.id}/status`);
			if (st.process_status === "done") break;
			if (st.process_status === "error") throw new Error("document processing failed");
			await new Promise((r) => setTimeout(r, 2000));
		}
		const { status, out } = runPi([
			"-p", `Call mistral_document_query with libraryIds ["${libraryId}"] and query "What is the smoke test secret phrase?". Reply with just the phrase the tool retrieved.`,
			"--provider", "mistral-native", "--model", "mistral-large-4", "--no-session",
		]);
		const cleaned = out.replace(/\x1b\[[0-9;]*m/g, "");
		if (status !== 0) problems.push(`pi exited ${status}`);
		if (!cleaned.includes(phrase)) problems.push("retrieved phrase missing from model output");
	} catch (error) {
		problems.push(String(error.message ?? error));
	} finally {
		if (libraryId) await apiCall(`/libraries/${libraryId}`, { method: "DELETE" }).catch(() => {});
		rmSync(scratch, { recursive: true, force: true });
	}
	return record("rag", problems.length ? "fail" : "pass", problems.join("; ") || "upload -> library -> document_query retrieved the phrase; library deleted");
}

/**
 * Scenario 3 (live catalog): pi --list-models must show the mistral-native
 * catalog. pi's list-models path restores the persisted snapshot; the static
 * fallback registers exactly 1 model, so >= 5 rows proves a live catalog
 * (a prior interactive refresh or the persisted store). A direct GET
 * /v1/models sanity-fetch proves the endpoint itself is live.
 */
async function scenarioCatalog() {
	if (skips.has("catalog")) return record("catalog", "skip", "skipped by --skip=catalog");
	const problems = [];
	const { status, out } = runPi(["--list-models"], { timeoutMs: 60_000 });
	const rows = out.split("\n").filter((line) => /^\s*mistral-native\s/.test(line));
	if (status !== 0) problems.push(`pi exited ${status}`);
	if (rows.length < 5) problems.push(`only ${rows.length} mistral-native rows (static fallback is 1; live catalog expected >= 5)`);
	if (!rows.some((row) => /mistral-large-4/.test(row))) problems.push("mistral-large-4 missing from the catalog listing");
	try {
		const key = process.env.MISTRAL_API_KEY ?? readStoredKey();
		const res = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${key}` } });
		if (!res.ok) problems.push(`GET /v1/models -> HTTP ${res.status}`);
		else {
			const body = await res.json();
			const chat = (body.data ?? []).filter((m) => m?.capabilities?.completion_chat === true && m?.internal !== true && m?.archived !== true && m?.deprecation == null);
			if (chat.length < 5) problems.push(`live /v1/models chat-eligible count ${chat.length} < 5`);
		}
	} catch (error) {
		problems.push(`live /v1/models fetch failed: ${String(error.message ?? error)}`);
	}
	return record("catalog", problems.length ? "fail" : "pass", problems.join("; ") || `${rows.length} mistral-native rows listed; /v1/models reachable`);
}

/**
 * Scenario 4 (live mistral_ocr): one OCR call through the pi tool. The
 * fixture is a tiny embedded PNG (plain text on white, generated once; no
 * secrets) passed as a data URL — the exact input class of the OCR tool.
 */
const OCR_PNG_B64 =
	"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";

async function scenarioOcr() {
	if (skips.has("ocr")) return record("ocr", "skip", "skipped by --skip=ocr");
	const problems = [];
	// One retry with a shorter instruction: the model occasionally echoes the
	// OCR markdown heading instead of the marker; both runs must come back
	// from the live tool (the marker only exists in the fixture pixels).
	const prompt =
		"Call the mistral_ocr tool with the image parameter set to this data URL: " +
		`data:image/png;base64,${OCR_PNG_B64}. ` +
		"Answer with just the marker value.";
	const { status, out } = runPi([
		"-p", prompt,
		"--provider", "mistral-native", "--model", "mistral-large-4", "--no-session",
	], { timeoutMs: 420_000 });
	const cleaned = out.replace(/\x1b\[[0-9;]*m/g, "");
	if (status !== 0) problems.push(`pi exited ${status}`);
	if (!/amber-ibis-7/.test(cleaned)) problems.push("OCR marker missing from model output (expected amber-ibis-7)");
	return record("ocr", problems.length ? "fail" : "pass", problems.join("; ") || "live mistral_ocr returned the marker from the fixture image");
}
const want = SCENARIOS.filter((s) => !skips.has(s));
if (want.includes("stream")) await scenarioStream();
if (want.includes("rag")) await scenarioRag();
if (want.includes("catalog")) await scenarioCatalog();
if (want.includes("ocr")) await scenarioOcr();
if (results.length === 0) console.log("(no scenarios selected)");
else {
	console.log("");
	const counts = { pass: 0, fail: 0, skip: 0 };
	for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
	console.log(`smoke-test: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip ?? 0} skip`);
}
process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
