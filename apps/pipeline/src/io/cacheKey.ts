/**
 * Cache key rules (D14): models share caches when safe.
 */

/**
 * The pre-refactor model for each stage. When the configured model matches,
 * the cache key must NOT include a model suffix (so existing caches stay hot).
 * When it differs, the key must include provider/model.
 * ponytail: remove this map and always append the model suffix after 2027-01-01,
 * or whenever the cache is flushed.
 */
export const LEGACY_MODELS: Record<
	string,
	{ provider: string; model: string }
> = {
	annotate: { provider: "gemini", model: "gemini-3.1-flash-lite" },
	rank: { provider: "gemini", model: "gemini-3.5-flash" },
	venues: { provider: "gemini", model: "gemini-3.5-flash" },
	extract: { provider: "gemini", model: "gemini-3.1-flash-lite" },
};

/** Returns the cache key for a stage, including model suffix when not using the legacy model. */
export function stageModelCacheKey(
	legacyKey: string,
	stage: string,
	configured: { provider: string; model: string },
): string {
	const legacy = LEGACY_MODELS[stage];
	if (
		legacy &&
		configured.provider === legacy.provider &&
		configured.model === legacy.model
	) {
		return legacyKey;
	}
	return `${legacyKey}:${configured.provider}/${configured.model}`;
}
