/**
 * String-enum schema helper for tool parameters.
 *
 * Emitting `{ type: "string", enum: [...] }` matters: pi validates tool
 * arguments against the JSON Schema, and the flat enum form works across
 * all providers (some reject anyOf/const patterns). Branding the value
 * with typebox's `Type.Unsafe` matters for the same reason: the coding
 * agent derives an execute handler's `params` type from the schema via
 * typebox's `Static`, which reads only typebox brands — a plain
 * JSON-Schema object (what `StringEnum` from `@earendil-works/pi-ai`
 * returns since 1.5.0) leaves the field typed `unknown` in dev trees.
 * The wire output is identical either way; only the static type differs.
 */

import { Type } from "typebox";

/** Options accepted by {@link stringEnum}: schema annotations only. */
export interface StringEnumOptions {
	/** What the field means; shown to the model alongside the tool. */
	readonly description?: string;
	/**
	 * Default value annotation. pi's validation never inserts it — every
	 * tool must still apply its own fallback in `execute`.
	 */
	readonly default?: string;
}

/**
 * A typebox schema for a closed set of strings: `{ type: "string", enum: [...] }`
 * with the static type `T[number]`, so `params.<field>` is the literal union.
 */
export function stringEnum<const T extends readonly string[]>(values: T, options: StringEnumOptions = {}) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options.description && { description: options.description }),
		...(options.default && { default: options.default }),
	});
}
