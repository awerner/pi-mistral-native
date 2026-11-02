/**
 * pi tools for Mistral's knowledge APIs: files, libraries, documents and
 * library RAG queries. Wire formats verified against
 * vendor/mistral-openapi.yaml.
 *
 * Each tool resolves its Mistral API key lazily per execute call via a
 * client factory, so keys from the provider registry (or the environment)
 * are picked up without ever being logged. Signed URLs are returned to the
 * model/caller but MUST NOT end up in `details`, which pi persists in
 * transcripts and logs.
 *
 * ADR 0006 — Knowledge API tools.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { Type } from "typebox";
import {
	defineTool,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import { getEffectiveRagStreaming } from "../mistral/config.js";
import type { MistralClient, QueryContentChunk } from "./mistral-client.js";
import { createMistralClient } from "./mistral-client.js";

/** Default model for RAG queries (matches the project's default model). */
export const DEFAULT_QUERY_MODEL = "mistral-large-4";

/** Dependencies of {@link createKnowledgeTools}: a lazy per-call client factory. */
export interface KnowledgeToolsDeps {
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

/** One assembled RAG result fragment: mapped chunks plus derived text parts. */
interface RagAssembled {
	chunks: Record<string, unknown>[];
	citations: { name: string | null; url: string }[];
	textParts: string[];
}

/**
 * Map wire ContentChunks into the tool's {text|document_url} chunk shape
 * (shared by the one-shot and streaming paths so their results are
 * identical): a plain string content is a single text chunk; `text` chunks
 * map to text; `document_url` chunks map to citations. Other chunk types
 * (think, image_url, …) carry no retrieval payload and are ignored, exactly
 * as in the one-shot implementation.
 *
 * ADR 0006 — Knowledge API tools.
 */
function assembleRagContent(content: string | readonly QueryContentChunk[]): RagAssembled {
	const rawChunks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
	const chunks: Record<string, unknown>[] = [];
	const citations: { name: string | null; url: string }[] = [];
	const textParts: string[] = [];
	for (const chunk of rawChunks) {
		if (chunk.type === "document_url") {
			chunks.push({
				type: "document_url",
				documentUrl: chunk.document_url,
				...(chunk.document_name !== undefined && chunk.document_name !== null
					? { documentName: chunk.document_name }
					: {}),
			});
			citations.push({ name: chunk.document_name ?? null, url: chunk.document_url });
		} else if (chunk.type === "text") {
			chunks.push({ type: "text", text: chunk.text });
			textParts.push(chunk.text);
		}
	}
	return { chunks, citations, textParts };
}

/**
 * Extract a mid-stream failure message from one RAG SSE chunk: an `error`
 * object inside a 200 event (Mistral-compatible gateways) or a
 * finish_reason "error" per the vendored CompletionResponseStreamChoice
 * (vendor/mistral-openapi.yaml). Returns undefined when the chunk carries
 * no failure. The message is server-supplied content only — never headers,
 * never the API key.
 */
function extractRagStreamError(chunk: { error?: unknown; choices?: { finish_reason?: string | null }[] }): string | undefined {
	if (chunk.error !== null && chunk.error !== undefined) {
		if (typeof chunk.error === "string" && chunk.error.length > 0) {
			return chunk.error;
		}
		if (typeof chunk.error === "object") {
			const record = chunk.error as Record<string, unknown>;
			for (const key of ["message", "detail"]) {
				const value = record[key];
				if (typeof value === "string" && value.length > 0) {
					return value.length > 300 ? `${value.slice(0, 300)}…` : value;
				}
			}
		}
		return "Mistral API reported an in-stream error";
	}
	const finishReason = chunk.choices?.[0]?.finish_reason;
	if (finishReason === "error") {
		return "Mistral API ended the RAG stream with finish_reason error";
	}
	return undefined;
}

/** Renders an assembled RAG result: joined text plus a citations block. */
function ragResult(assembled: RagAssembled, model: string, libraryIds: string[]): AgentToolResult<any> {
	const citationLines = assembled.citations.map(
		(citation) => `- ${citation.name ?? "document"}: ${citation.url}`,
	);
	const textOut = [
		assembled.textParts.length > 0 ? assembled.textParts.join("\n") : "(no retrieved text)",
		citationLines.length > 0 ? `\nCitations:\n${citationLines.join("\n")}` : "",
	]
		.filter((part) => part.length > 0)
		.join("\n");
	return ok(
		textOut,
		{ chunks: assembled.chunks },
		{ model, libraryIds, chunks: assembled.chunks.length },
	);
}

/**
 * Parse the streaming RAG usage block (loose Mistral UsageInfo subset) into
 * pi's tool-result Usage. Mirrors the one-shot behavior of leaving
 * cost/currency unset (pi's session accounting computes totals; the token
 * counts are what matter here).
 */
function parseRagUsage(raw: Record<string, unknown>): NonNullable<AgentToolResult<any>["usage"]> {
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	const details = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
	const input = num(raw.prompt_tokens);
	const output = num(raw.completion_tokens);
	const cacheRead = num(details.cached_tokens);
	const cacheWrite = num(details.cache_write_tokens);
	return {
		input: Math.max(0, input - cacheRead - cacheWrite),
		output,
		cacheRead,
		cacheWrite,
		totalTokens: Math.max(0, input - cacheRead - cacheWrite) + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Reads a local file into the bytes + metadata needed for an upload. */
async function readLocalFile(path: string, fileNameOverride?: string) {
	const content = new Uint8Array(await readFile(path));
	const fileName = fileNameOverride ?? basename(path);
	return { content, fileName };
}

/**
 * Builds the nine knowledge tools. `getClient` is called once per execute
 * call so each request uses the currently resolved API key and signal.
 */
export function createKnowledgeTools(deps: KnowledgeToolsDeps): AnyToolDefinition[] {
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

	const mistralFileUpload = defineTool({
		name: "mistral_file_upload",
		label: "Mistral file upload",
		description:
			"Upload a local file to Mistral's files API (OCR, batch, fine-tune or agentic safety). " +
			"The file is stored on Mistral's servers; with an expiry it is deleted automatically afterwards. " +
			"visibility=\"user\" keeps the file private to the uploader; visibility=\"workspace\" shares it with the whole workspace.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute or working-directory-relative path of the local file to upload" }),
			// Optional + execute fallback: pi's validation never applies JSON-Schema
			// defaults, so a required-with-default property would fail when omitted.
			purpose: Type.Optional(
				StringEnum(["ocr", "batch", "fine-tune", "agentic_safety"] as const, {
					description: "Intended purpose of the uploaded file (defaults to ocr)",
					default: "ocr",
				}),
			),
			expiryHours: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 168, description: "Optional expiry in hours (1..168); the file is deleted afterwards" }),
			),
			// The API defaults visibility to "workspace" (shared with everyone in the
			// workspace); we default to "user" so uploads stay private unless shared.
			visibility: Type.Optional(
				StringEnum(["user", "workspace"] as const, {
					description: "Who can see the file: user = only the uploader, workspace = shared with the workspace (defaults to user)",
					default: "user",
				}),
			),
			fileName: Type.Optional(Type.String({ description: "Override for the stored file name; defaults to the input path's basename" })),
		}),
		outputSchema: Type.Object({
			id: Type.String(),
			filename: Type.String(),
			// The spec's own /v1/files example returns bytes: null.
			bytes: Type.Union([Type.Integer(), Type.Null()]),
			purpose: Type.String(),
			createdAt: Type.Integer(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_file_upload", async (client) => {
				const { content, fileName } = await readLocalFile(params.path, params.fileName);
				const file = await client.uploadFile({
					fileName,
					content,
					mimeType: "application/octet-stream",
					purpose: params.purpose ?? "ocr",
					expiryHours: params.expiryHours,
					visibility: params.visibility ?? "user",
					signal,
				});
				return ok(
					`Uploaded ${file.filename} (${file.bytes ?? "unknown size"} bytes, purpose ${file.purpose}) as file ${file.id}`,
					{ id: file.id, filename: file.filename, bytes: file.bytes, purpose: file.purpose, createdAt: file.created_at },
					{ path: params.path, fileId: file.id },
				);
			});
		},
	});

	const mistralLibraryCreate = defineTool({
		name: "mistral_library_create",
		label: "Mistral library create",
		description: "Create a new Mistral document library for RAG indexing and retrieval.",
		parameters: Type.Object({
			name: Type.String({ description: "Name of the library" }),
			description: Type.Optional(Type.String({ description: "Optional description of the library" })),
		}),
		outputSchema: Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: true }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_library_create", async (client) => {
				const library = await client.createLibrary({
					name: params.name,
					description: params.description,
					signal,
				});
				return ok(
					`Created library "${library.name}" (${library.id})`,
					library as unknown as Record<string, unknown>,
					{ libraryId: library.id, name: library.name },
				);
			});
		},
	});

	const mistralLibraryList = defineTool({
		name: "mistral_library_list",
		label: "Mistral library list",
		description: "List Mistral document libraries, optionally filtered by a case-insensitive name search.",
		parameters: Type.Object({
			search: Type.Optional(Type.String({ description: "Case-insensitive search on the library name" })),
			pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Page size (1..100)" })),
			pageToken: Type.Optional(Type.String({ description: "Continuation token from a previous result's nextPageToken" })),
		}),
		outputSchema: Type.Object({
			libraries: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: true })),
			nextPageToken: Type.Union([Type.String(), Type.Null()]),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_library_list", async (client) => {
				const page = await client.listLibraries({
					search: params.search,
					pageSize: params.pageSize,
					pageToken: params.pageToken,
					signal,
				});
				const summary =
					page.data.length > 0
						? page.data.map((library) => `- ${library.name} (${library.id}, ${library.nb_documents} documents)`).join("\n")
						: "No libraries found";
				const nextPage = page.next_page_token ? `\nMore pages available (nextPageToken: ${page.next_page_token})` : "";
				return ok(
					`${page.data.length} library/libraries:\n${summary}${nextPage}`,
					{ libraries: page.data as unknown as Record<string, unknown>[], nextPageToken: page.next_page_token },
					{ count: page.data.length },
				);
			});
		},
	});

	const mistralDocumentUpload = defineTool({
		name: "mistral_document_upload",
		label: "Mistral document upload",
		description:
			"Upload a local file as a document into a Mistral library for RAG indexing. " +
			"Processing starts asynchronously; check with mistral_document_status. " +
			"Uploading is a billable operation. If a document with the same content already exists, the existing document is returned.",
		parameters: Type.Object({
			libraryId: Type.String({ description: "Id of the target library" }),
			path: Type.String({ description: "Absolute or working-directory-relative path of the local file to upload" }),
			fileName: Type.Optional(Type.String({ description: "Override for the stored document name; defaults to the input path's basename" })),
		}),
		outputSchema: Type.Object({ id: Type.String(), process_status: Type.String() }, { additionalProperties: true }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_document_upload", async (client) => {
				const { content, fileName } = await readLocalFile(params.path, params.fileName);
				const document = await client.uploadDocument({
					libraryId: params.libraryId,
					fileName,
					content,
					mimeType: "application/octet-stream",
					signal,
				});
				return ok(
					`Uploaded document "${document.name}" (${document.id}) to library ${params.libraryId}; process status: ${document.process_status}`,
					document as unknown as Record<string, unknown>,
					{ libraryId: params.libraryId, documentId: document.id, processStatus: document.process_status },
				);
			});
		},
	});

	const mistralDocumentList = defineTool({
		name: "mistral_document_list",
		label: "Mistral document list",
		description: "List the documents of a Mistral library, optionally filtered by a search string, with pagination.",
		parameters: Type.Object({
			libraryId: Type.String({ description: "Id of the library" }),
			search: Type.Optional(Type.String({ description: "Optional search string on document names" })),
			page: Type.Optional(Type.Integer({ minimum: 0, description: "Page number (0-based)" })),
			pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Page size (1..100)" })),
		}),
		outputSchema: Type.Object({
			documents: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: true })),
			pagination: Type.Object({
				totalItems: Type.Integer(),
				totalPages: Type.Integer(),
				currentPage: Type.Integer(),
				pageSize: Type.Integer(),
				hasMore: Type.Boolean(),
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_document_list", async (client) => {
				const result = await client.listDocuments({
					libraryId: params.libraryId,
					search: params.search,
					page: params.page,
					pageSize: params.pageSize,
					signal,
				});
				const summary =
					result.data.length > 0
						? result.data.map((document) => `- ${document.name} (${document.id}, ${document.process_status})`).join("\n")
						: "No documents found";
				return ok(
					`${result.data.length} document(s):\n${summary}`,
					{
						documents: result.data as unknown as Record<string, unknown>[],
						pagination: {
							totalItems: result.pagination.total_items,
							totalPages: result.pagination.total_pages,
							currentPage: result.pagination.current_page,
							pageSize: result.pagination.page_size,
							hasMore: result.pagination.has_more,
						},
					},
					{ libraryId: params.libraryId, count: result.data.length },
				);
			});
		},
	});

	const mistralDocumentStatus = defineTool({
		name: "mistral_document_status",
		label: "Mistral document status",
		description:
			"Check the processing status of a library document. Processing is asynchronous; poll until process_status is \"done\" (or \"error\").",
		parameters: Type.Object({
			libraryId: Type.String({ description: "Id of the library the document belongs to" }),
			documentId: Type.String({ description: "Id of the document" }),
		}),
		outputSchema: Type.Object({
			documentId: Type.String(),
			processStatus: Type.String(),
			processingStatus: Type.String(),
		}, { additionalProperties: true }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_document_status", async (client) => {
				const status = await client.getDocumentStatus({
					libraryId: params.libraryId,
					documentId: params.documentId,
					signal,
				});
				// Enrich with document metadata (name, size) when available; the
				// status response itself carries only id + status fields.
				let name: string | undefined;
				let size: number | undefined;
				try {
					const document = await client.getDocument({
						libraryId: params.libraryId,
						documentId: params.documentId,
						signal,
					});
					name = document.name;
					size = typeof document.size === "number" ? document.size : undefined;
				} catch {
					// Metadata is optional enrichment; return the status regardless.
				}
				const structured: Record<string, unknown> = {
					documentId: status.document_id,
					processStatus: status.process_status,
					processingStatus: status.processing_status,
				};
				if (name !== undefined) {
					structured.name = name;
				}
				if (size !== undefined) {
					structured.size = size;
				}
				return ok(
					`Document ${params.documentId}${name ? ` ("${name}")` : ""}: process_status=${status.process_status}`,
					structured,
					{ libraryId: params.libraryId, documentId: params.documentId },
				);
			});
		},
	});

	const mistralDocumentSignedUrl = defineTool({
		name: "mistral_document_signed_url",
		label: "Mistral document signed URL",
		description:
			"Get a short-lived signed download URL for a library document (the original file or the extracted text). " +
			"The URL expires after 30 minutes.",
		parameters: Type.Object({
			libraryId: Type.String({ description: "Id of the library the document belongs to" }),
			documentId: Type.String({ description: "Id of the document" }),
			// Optional + execute fallback: pi's validation never applies JSON-Schema
			// defaults, so a required-with-default property would fail when omitted.
			kind: Type.Optional(
				StringEnum(["document", "extracted-text"] as const, {
					description: "Which artifact to fetch: the original document or the extracted text (defaults to document)",
					default: "document",
				}),
			),
		}),
		outputSchema: Type.Object({
			url: Type.String(),
			kind: Type.String(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_document_signed_url", async (client) => {
				const kind = params.kind ?? "document";
				const url = await client.getDocumentSignedUrl({
					libraryId: params.libraryId,
					documentId: params.documentId,
					kind,
					signal,
				});
				// Never put the signed URL into `details`: details is persisted in
				// transcripts and logs, and the URL grants download access for its
				// lifetime. It is returned to the caller only via `content`
				// (model-facing) and `structuredContent` (programmatic callers).
				return ok(
					`Signed URL (valid 30 minutes, kind: ${kind}):\n${url}`,
					{ url, kind },
					{ kind, libraryId: params.libraryId, documentId: params.documentId },
				);
			});
		},
	});

	const mistralDocumentReprocess = defineTool({
		name: "mistral_document_reprocess",
		label: "Mistral document reprocess",
		description:
			"Queue a library document for reprocessing. Warning: reprocessing is billed again. " +
			"Use this only when processing failed or the document content must be re-indexed.",
		parameters: Type.Object({
			libraryId: Type.String({ description: "Id of the library the document belongs to" }),
			documentId: Type.String({ description: "Id of the document to reprocess" }),
		}),
		outputSchema: Type.Object({
			reprocessed: Type.Boolean(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return run(ctx, signal, "mistral_document_reprocess", async (client) => {
				await client.reprocessDocument({
					libraryId: params.libraryId,
					documentId: params.documentId,
					signal,
				});
				return ok(
					`Reprocessing queued for document ${params.documentId} (billed again as processing)`,
					{ reprocessed: true },
					{ libraryId: params.libraryId, documentId: params.documentId },
				);
			});
		},
	});

	const mistralDocumentQuery = defineTool({
		name: "mistral_document_query",
		label: "Mistral document query (RAG)",
		description:
			"Run a RAG query against one or more Mistral document libraries: retrieves relevant text chunks " +
			"plus citations (signed document URLs) for the matched passages.",
		parameters: Type.Object({
			libraryIds: Type.Array(Type.String(), {
				minItems: 1,
				description: "Ids of the libraries to search (at least one)",
			}),
			query: Type.String({ description: "The user question to answer from the libraries' documents" }),
			model: Type.Optional(
				Type.String({ description: "Chat model used for the query", default: DEFAULT_QUERY_MODEL }),
			),
			maxTokens: Type.Optional(Type.Integer({ description: "Optional maximum number of output tokens" })),
		}),
		outputSchema: Type.Object({
			chunks: Type.Array(
				Type.Union([
					Type.Object({ type: Type.Literal("text"), text: Type.String() }),
					Type.Object({
						type: Type.Literal("document_url"),
						documentUrl: Type.String(),
						documentName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
					}),
				]),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return run(ctx, signal, "mistral_document_query", async (client) => {
				const model = params.model ?? DEFAULT_QUERY_MODEL;
				/*
				 * Config toggle: streaming is the default; `rag.streaming: false`
				 * (or the broader `knowledge.streaming`, or
				 * MISTRAL_RAG_STREAMING=0/false/off/no) forces the one-shot
				 * request.
				 *
				 * ADR 0015 — Streaming RAG document query.
				 */
				const streaming = getEffectiveRagStreaming();
				if (!streaming) {
					const response = await client.queryLibrary({
						model,
						libraryIds: params.libraryIds,
						query: params.query,
						maxTokens: params.maxTokens,
						signal,
					});
					const choice = response.choices?.[0];
					const content = choice?.message?.content ?? null;
					if (content === null || (Array.isArray(content) && content.length === 0)) {
						return ok(
							"The library query returned no content.",
							{ chunks: [] },
							{ model, libraryIds: params.libraryIds },
						);
					}
					const assembled = assembleRagContent(content);
					return ragResult(assembled, model, params.libraryIds);
				}
				/*
				 * Streaming path: same request mapping (the document_library tool
				 * declaration included) over the SSE endpoint. pi tools return one
				 * result message to the model — there is no progressive
				 * model-facing surface — so the stream is consumed internally and
				 * the complete chunks + citations mapping of the one-shot path
				 * applies at stream end. What the stream buys inside a tool:
				 * abort takes effect mid-transfer, in-stream failures are
				 * surfaced loudly instead of masquerading as empty retrievals, and
				 * the onUpdate preview channel surfaces partial text to the
				 * session UI while the answer generates.
				 *
				 * ADR 0015 — Streaming RAG document query.
				 */
				const assembled: RagAssembled = { chunks: [], citations: [], textParts: [] };
				let deliveredContent = false;
				let usage: AgentToolResult<any>["usage"];
				for await (const chunk of client.queryLibraryStream({
					model,
					libraryIds: params.libraryIds,
					query: params.query,
					maxTokens: params.maxTokens,
					signal,
				})) {
					if (chunk.usage !== undefined) {
						usage = parseRagUsage(chunk.usage);
					}
					// Mid-stream failure (Mistral-compatible APIs may deliver an
					// `error` object inside a 200 SSE event, or a finish_reason
					// "error" per the vendored CompletionResponseStreamChoice):
					// fail loudly — never report an API failure as an empty
					// retrieval.
					const streamError = extractRagStreamError(chunk);
					if (streamError !== undefined) {
						throw new Error(streamError);
					}
					const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
					const delta = choice?.delta;
					const content = delta?.content ?? null;
					if (content === null) continue;
					deliveredContent = true;
					const piece = assembleRagContent(content);
					assembled.chunks.push(...piece.chunks);
					assembled.citations.push(...piece.citations);
					assembled.textParts.push(...piece.textParts);
					// Preview update (session UI only): a plain AgentToolResult; pi
					// renders it as a pending tool preview and ignores post-settle
					// callbacks itself (AgentToolUpdateCallback contract).
					onUpdate?.({
						content: [{ type: "text", text: assembled.textParts.join("\n") || "Retrieving from libraries…" }],
							details: undefined,
					});
				}
				// pi's per-tool-call abort signal fired mid-stream: the call was
					// cancelled by the user/session, not by the API — report it as an
					// error result rather than a partial answer. (When the abort
					// rejects an in-flight body read, the transport AbortError takes
					// the generic run() failure path instead — also an error result,
					// never a partial answer.)
				if (signal?.aborted) {
					return fail("mistral_document_query aborted during the RAG stream", {
						model,
						libraryIds: params.libraryIds,
						aborted: true,
						chunks: assembled.chunks.length,
					});
				}
				// Stream completed with no mapped chunks and no error: same two
				// empty cases as the one-shot path, rendered identically —
				// content that carried only ignored chunk types maps to an empty
				// RagAssembled (chunks 0, textParts 0), which renders "(no
				// retrieved text)" through ragResult; a content-less stream
				// renders the no-content note.
				if (assembled.chunks.length === 0 && !deliveredContent) {
					const emptyResult = ok(
						"The library query returned no content.",
						{ chunks: [] },
						{ model, libraryIds: params.libraryIds },
					);
					return usage !== undefined ? { ...emptyResult, usage } : emptyResult;
				}
				const base = ragResult(assembled, model, params.libraryIds);
				// Usage from the stream's terminal chunk (stream_options.include_
				// usage) is carried on the tool result: pi accounts tool usage in
				// session stats separately from main LLM context usage.
				return usage !== undefined ? { ...base, usage } : base;
			});
		},
	});

	return [
		mistralFileUpload,
		mistralLibraryCreate,
		mistralLibraryList,
		mistralDocumentUpload,
		mistralDocumentList,
		mistralDocumentStatus,
		mistralDocumentSignedUrl,
		mistralDocumentReprocess,
		mistralDocumentQuery,
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
 * Registers the knowledge tools with pi, wiring a lazy client factory that
 * resolves the API key per execute call. Tools pass pi's per-call abort
 * signal through to each client request individually.
 */
export function registerKnowledgeTools(pi: ExtensionAPI): void {
	const getClient = async (ctx: ExtensionToolContext | undefined, _signal?: AbortSignal) => {
		const apiKey = await resolveApiKey(ctx);
		return createMistralClient({ apiKey });
	};
	const tools = createKnowledgeTools({ getClient });
	for (const tool of tools) {
		pi.registerTool(tool);
	}
}
