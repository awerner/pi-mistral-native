/**
 * pi tools for Mistral's knowledge APIs: OCR, embeddings, moderations,
 * classifications. All four are registered from extensions/mistral.ts
 * under the `mistral-knowledge` namespace; wire formats follow
 * vendor/mistral-openapi.yaml.
 *
 * Not pi classifiers on purpose: moderations return server-fixed categories and
 * classifications score training-time targets; neither fits pi's
 * caller-defined-questions classifier contract.
 *
 * ADR 0005 — OCR, embeddings, moderations/classifications as pi tools
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";

import {
	mistralFetch,
	type ClassificationRequest,
	type ClassificationResponse,
	type EmbeddingRequest,
	type EmbeddingResponse,
	type ModerationResponse,
	type OcrRequest,
	type OcrResponse,
} from "./api.js";

/**
 * OCR model alias; mistral-ocr-2503-completion is deprecated/retired on Mistral's
 * model pages, the `-latest` alias stays current.
 */
export const DEFAULT_OCR_MODEL = "mistral-ocr-latest";
export const DEFAULT_EMBED_MODEL = "mistral-embed";
export const DEFAULT_MODERATION_MODEL = "mistral-moderation-latest";

/** Cap for model-facing markdown (keep context small; full text lives in structuredContent). */
const OCR_CONTENT_LIMIT = 50_000;

const toolAnnotations = { readOnlyHint: true, openWorldHint: false };

const knowledgeNamespace = {
	name: "mistral-knowledge",
	description: "Mistral knowledge APIs: OCR, embeddings, moderation, classification",
};

/**
 * Generic tool builder. It normalizes the pieces that are identical across the
 * four tools (namespace, annotations, outputSchema, result shape) while keeping
 * one typed `execute` per tool with schema-inferred params for pi's
 * registerTool.
 */
class ToolsBuilder<TParams extends TSchema, TDetails> {
	constructor(
		private readonly name: string,
		private readonly label: string,
		private readonly description: string,
		private readonly parameters: TParams,
		private readonly outputSchema: TSchema,
		private readonly run: (
			ctx: ExtensionToolContext,
			params: Static<TParams>,
			signal: AbortSignal | undefined,
		) => Promise<{ content: string; details: TDetails; structuredContent: JsonValue }>,
	) {}

	tool(): ToolDefinition<TParams, TDetails> {
		return {
			name: this.name,
			label: this.label,
			description: this.description,
			parameters: this.parameters,
			outputSchema: this.outputSchema,
			annotations: toolAnnotations,
			namespace: knowledgeNamespace,
			execute: async (
				_toolCallId: string,
				params: Static<TParams>,
				signal: AbortSignal | undefined,
				_onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<TDetails>> => {
				const { content, details, structuredContent } = await this.run(ctx, params, signal);
				return { content: [{ type: "text", text: content }], details, structuredContent };
			},
		};
	}
}

/**
 * Normalize `input` (string or string[]) to a non-empty string[]. Returns
 * undefined when the input is invalid (empty or contains empties).
 */
function normalizeInputs(input: string | string[]): string[] | undefined {
	const list = Array.isArray(input) ? input : [input];
	if (list.length === 0 || list.some((value) => value.trim().length === 0)) return undefined;
	return list;
}

// ---------------------------------------------------------------------------
// mistral_ocr — POST /v1/ocr
// ---------------------------------------------------------------------------

const OcrParams = Type.Object({
	image: Type.String({
		description:
			'Image or PDF source: a data URL ("data:image/png;base64,..."), an http(s) URL (image extensions like .png/.jpg are treated as images, everything else as a document), or plain base64 (treated as a base64 PNG)',
	}),
	model: Type.Optional(Type.String({ description: `OCR model id (default ${DEFAULT_OCR_MODEL})` })),
	pages: Type.Optional(
		Type.String({
			description: 'Pages to process, e.g. "0-5" or "0,2-4"; page numbers start from 0',
		}),
	),
	include_image_base64: Type.Optional(
		Type.Boolean({ description: "Also return extracted images as base64 in structuredContent" }),
	),
});

interface OcrStructuredPage {
	index: number;
	markdown: string;
	dimensions: { width?: number; height?: number; dpi?: number };
	imageCount: number;
	images: { id: string; image_base64?: string }[];
}

const OcrOutput = Type.Object({
	pages: Type.Array(
		Type.Object({
			index: Type.Number(),
			markdown: Type.String(),
			dimensions: Type.Object({
				width: Type.Optional(Type.Number()),
				height: Type.Optional(Type.Number()),
				dpi: Type.Optional(Type.Number()),
			}),
			imageCount: Type.Number(),
			images: Type.Array(
				Type.Object({ id: Type.String(), image_base64: Type.Optional(Type.String()) }),
			),
		}),
	),
	model: Type.String(),
	usage: Type.Object({
		pages_processed: Type.Optional(Type.Number()),
		doc_size_bytes: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	}),
});

function ocrTool() {
	return new ToolsBuilder<
		typeof OcrParams,
		{ model: string; pages: { index: number; markdownChars: number; imageCount: number }[] }
	>(
		"mistral_ocr",
		"Mistral OCR",
		"Run OCR on an image or PDF with Mistral and get markdown per page. Pass a data URL, an http(s) URL (image URLs by extension, other URLs as documents), or plain base64 image data.",
		OcrParams,
		OcrOutput,
		async (ctx, params, signal) => {
			const body: OcrRequest = { model: params.model ?? DEFAULT_OCR_MODEL, document: ocrDocument(params.image) };
			if (params.pages !== undefined) body.pages = params.pages;
			if (params.include_image_base64 !== undefined) body.include_image_base64 = params.include_image_base64;
			const response = await mistralFetch<OcrResponse>(ctx, "/ocr", body, signal);

			const rawPages = response.pages ?? [];
			const pages: OcrStructuredPage[] = rawPages.map((page) => ({
				index: page.index,
				markdown: page.markdown,
				dimensions: { ...(page.dimensions ?? {}) },
				imageCount: page.images?.length ?? 0,
				images: (page.images ?? []).map((image) => ({
					id: image.id,
					...(params.include_image_base64 && image.image_base64 ? { image_base64: image.image_base64 } : {}),
				})),
			}));

			let content = pages
				.map((page) => `--- Page ${page.index} ---\n${page.markdown}`)
				.join("\n\n");
			if (content.length > OCR_CONTENT_LIMIT) content = `${content.slice(0, OCR_CONTENT_LIMIT)}…[truncated]`;
			if (pages.length === 0) content = "No pages returned.";
			content = `OCR (${response.model ?? body.model}) — ${pages.length} page(s):\n\n${content}`;
			if (params.include_image_base64) {
				content +=
					"\n\nExtracted image base64 payloads are in structuredContent (images[].image_base64), not here.";
			}

			const structuredContent = {
				pages,
				model: response.model ?? body.model,
				usage: {
					...(response.usage_info?.pages_processed !== undefined
						? { pages_processed: response.usage_info.pages_processed }
						: {}),
					...(response.usage_info?.doc_size_bytes !== undefined
						? { doc_size_bytes: response.usage_info.doc_size_bytes }
						: {}),
				},
			};
			return {
				content,
				// Details persist in the transcript: page stats only, never base64 payloads.
				details: {
					model: response.model ?? body.model,
					pages: pages.map((page) => ({
						index: page.index,
						markdownChars: page.markdown.length,
						imageCount: page.imageCount,
					})),
				},
				structuredContent: structuredContent as unknown as JsonValue,
			};
		},
	).tool();
}

/** Image file extensions routed to ImageURLChunk for remote http(s) URLs. */
const REMOTE_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic", ".tiff"];

/** True when a remote URL's path ends with a known image extension (query/fragment ignored). */
function isRemoteImageUrl(url: string): boolean {
	try {
		const { pathname } = new URL(url);
		const lower = pathname.toLowerCase();
		return REMOTE_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
	} catch {
		// Not a parseable absolute URL: not routed as an image.
		return false;
	}
}

/**
 * True when a string looks like a filesystem path rather than base64 data:
 * absolute, ./, ../ or ~-relative, or ending in a common filename
 * extension. Genuine base64 payloads are URL-safe base64 characters and
 * padding only — they never match any of these shapes.
 */
function looksLikeLocalPath(image: string): boolean {
	if (image.startsWith("/") || image.startsWith("./") || image.startsWith("../")) return true;
	if (image.startsWith("~") && (image.length === 1 || image[1] === "/")) return true;
	if (/^[A-Za-z0-9+/_-]+=*$/.test(image)) return false;
	return /\.(png|jpe?g|gif|webp|avif|heic|tiff?|pdf|bmp|svg)$/i.test(image);
}

/**
 * Build the OCRRequest.document chunk: ImageURLChunk for image sources, and
 * DocumentURLChunk for remote URLs that are not images (PDFs etc.).
 * Local-path-shaped input fails fast with a remedy: sent as-is, the API
 * would wrap it into `data:image/png;base64,/tmp/x.png` and reject with an
 * opaque 422 pydantic error.
 */
function ocrDocument(image: string): OcrRequest["document"] {
	if (image.startsWith("http://") || image.startsWith("https://")) {
		return isRemoteImageUrl(image)
			? { type: "image_url", image_url: image }
			: { type: "document_url", document_url: image };
	}
	if (image.startsWith("data:")) return { type: "image_url", image_url: image };
	if (looksLikeLocalPath(image)) {
		throw new Error(
			`mistral_ocr: image looks like a local file path (${image}), but the OCR API ` +
				"cannot read local files. Read the file and pass its base64 content, or use a " +
				"data: URL or an http(s) URL instead.",
		);
	}
	// Plain base64: treat as base64 PNG data URL (ImageURLChunk shape from the spec).
	return { type: "image_url", image_url: `data:image/png;base64,${image}` };
}

// ---------------------------------------------------------------------------
// mistral_embed — POST /v1/embeddings
// ---------------------------------------------------------------------------

const EmbedParams = Type.Object({
	input: Type.Array(Type.String(), { minItems: 1, description: "Texts to embed" }),
	model: Type.Optional(Type.String({ description: `Embedding model id (default ${DEFAULT_EMBED_MODEL})` })),
});

const EmbedOutput = Type.Object({
	model: Type.String(),
	usage: Type.Object({
		prompt_tokens: Type.Optional(Type.Number()),
		completion_tokens: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
		total_tokens: Type.Optional(Type.Number()),
	}),
	embeddings: Type.Array(
		Type.Object({
			index: Type.Number(),
			dimension: Type.Number(),
			vector: Type.Array(Type.Number()),
		}),
	),
});

function embedTool() {
	return new ToolsBuilder<
		typeof EmbedParams,
		{
			model: string;
			count: number;
			dimension: number;
			usage: EmbeddingResponse["usage"];
			vectors: { index: number; dimension: number; preview: number[] }[];
		}
	>(
		"mistral_embed",
		"Mistral Embed",
		"Generate embeddings for texts with Mistral. Returns vectors in structuredContent for programmatic use.",
		EmbedParams,
		EmbedOutput,
		async (ctx, params, signal) => {
			const inputs = normalizeInputs(params.input);
			if (!inputs) throw new Error("mistral_embed: input must contain at least one non-empty string");
			const body: EmbeddingRequest = { model: params.model ?? DEFAULT_EMBED_MODEL, input: inputs };
			const response = await mistralFetch<EmbeddingResponse>(ctx, "/embeddings", body, signal);
			const data = response.data ?? [];
			const embeddings = data.map((item) => ({
				index: item.index,
				dimension: item.embedding.length,
				vector: item.embedding,
			}));
			const first = embeddings[0]?.dimension ?? 0;
			const content =
				`Mistral embeddings (${response.model ?? body.model}): ${embeddings.length} text(s), ` +
				`dimension ${first}, usage ${response.usage?.total_tokens ?? 0} tokens. ` +
				`Full vectors are in structuredContent.`;

			return {
				content,
				details: {
					model: response.model ?? body.model,
					count: embeddings.length,
					dimension: first,
					usage: response.usage ?? {},
					// Keep details (persisted in the transcript) small: previews only.
					vectors: embeddings.map((e) => ({ index: e.index, dimension: e.dimension, preview: e.vector.slice(0, 5) })),
				},
				structuredContent: {
					model: response.model ?? body.model,
					usage: { ...(response.usage ?? {}) },
					embeddings,
				} as unknown as JsonValue,
			};
		},
	).tool();
}

// ---------------------------------------------------------------------------
// mistral_moderate — POST /v1/moderations
// ---------------------------------------------------------------------------

const ModerateParams = Type.Object({
	input: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: "Text (or list of texts) to moderate",
	}),
	model: Type.Optional(
		Type.String({ description: `Moderation model id (default ${DEFAULT_MODERATION_MODEL})` }),
	),
});

const ModerateOutput = Type.Object({
	model: Type.String(),
	results: Type.Array(
		Type.Object({
			categories: Type.Record(Type.String(), Type.Boolean()),
			category_scores: Type.Record(Type.String(), Type.Number()),
		}),
	),
});

function moderateTool() {
	return new ToolsBuilder<typeof ModerateParams, { model: string; flagged: string[][] }>(
		"mistral_moderate",
		"Mistral Moderate",
		"Moderate text with Mistral: fixed categories with boolean flags and per-category scores.",
		ModerateParams,
		ModerateOutput,
		async (ctx, params, signal) => {
			const inputs = normalizeInputs(params.input);
			if (!inputs) throw new Error("mistral_moderate: input must contain at least one non-empty string");
			const body: ClassificationRequest = { model: params.model ?? DEFAULT_MODERATION_MODEL, input: inputs };
			const response = await mistralFetch<ModerationResponse>(ctx, "/moderations", body, signal);

			const results = (response.results ?? []).map((result) => ({
				categories: { ...(result.categories ?? {}) },
				category_scores: { ...(result.category_scores ?? {}) },
			}));
			const flagged = results.map((result) =>
				Object.entries(result.categories)
					.filter(([, value]) => value === true)
					.map(([name]) => name),
			);
			const content = results
				.map((result, i) => {
					const names = flagged[i] ?? [];
					return names.length > 0
						? `Input ${i}: flagged (${names.join(", ")})`
						: `Input ${i}: no categories flagged`;
				})
				.join("\n");

			return {
				content: `Mistral moderation (${response.model ?? body.model}):\n${content}`,
				details: { model: response.model ?? body.model, flagged },
				structuredContent: {
					model: response.model ?? body.model,
					results,
				} as unknown as JsonValue,
			};
		},
	).tool();
}

// ---------------------------------------------------------------------------
// mistral_classify — POST /v1/classifications
// ---------------------------------------------------------------------------

const ClassifyParams = Type.Object({
	model: Type.String({
		description: "Fine-tuned classifier model id (its training-time targets are scored)",
	}),
	input: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: "Text (or list of texts) to classify",
	}),
});

const ClassifyOutput = Type.Object({
	id: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	results: Type.Array(Type.Record(Type.String(), Type.Object({ scores: Type.Record(Type.String(), Type.Number()) }))),
});

function classifyTool() {
	return new ToolsBuilder<typeof ClassifyParams, { model: string }>(
		"mistral_classify",
		"Mistral Classify",
		"Classify text with a fine-tuned Mistral classifier model: scores each input against the model's training-time targets.",
		ClassifyParams,
		ClassifyOutput,
		async (ctx, params, signal) => {
			const inputs = normalizeInputs(params.input);
			if (!inputs) throw new Error("mistral_classify: input must contain at least one non-empty string");
			const body: ClassificationRequest = { model: params.model, input: inputs };
			const response = await mistralFetch<ClassificationResponse>(ctx, "/classifications", body, signal);

			const results = response.results ?? [];
			const content = results
				.map((result, i) => {
					const parts = Object.entries(result).map(([target, r]) => {
						const top = Object.entries(r.scores).sort((a, b) => b[1] - a[1])[0];
						return top ? `${target}/${top[0]}: ${top[1]}` : `${target}: no scores`;
					});
					return `Input ${i}: ${parts.join("; ")}`;
				})
				.join("\n");

			return {
				content: `Mistral classification (${response.model ?? params.model}):\n${content}`,
				details: { model: response.model ?? params.model },
				structuredContent: {
					...(response.id !== undefined ? { id: response.id } : {}),
					...(response.model !== undefined ? { model: response.model } : {}),
					results,
				} as unknown as JsonValue,
			};
		},
	).tool();
}

/** Register all four knowledge tools on `pi`. Called from extensions/mistral.ts. */
export function registerKnowledgeTools(pi: ExtensionAPI): void {
	pi.registerTool(ocrTool());
	pi.registerTool(embedTool());
	pi.registerTool(moderateTool());
	pi.registerTool(classifyTool());
}
