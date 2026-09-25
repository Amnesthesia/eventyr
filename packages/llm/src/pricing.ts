import type { StageUsage } from "./types.ts";

export interface Price {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens (thinking tokens bill as output). */
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** USD per search query. Gemini grounding is free inside its monthly
	 * quota (5,000 prompts), so it is 0 here. */
	perSearch?: number;
	/**
	 * Provider-native batch rates (D14). ai.google.dev/gemini-api/docs/pricing
	 * lists a per-model "Batch" row at exactly half the standard row (checked
	 * 2026-09-25), so these are half of *this table's* standard rows: the
	 * estimate is for ranking stages against each other, and a batch row on a
	 * different scale from its standard row would make that comparison lie.
	 */
	batch?: { input: number; output: number };
}

/**
 * USD per million tokens, plus per-search fees, for every model the pipeline
 * calls. The model unions in types.ts are derived from these keys, so an
 * unpriced model cannot be selected. ponytail: hand-maintained list; when a
 * model is missing the estimate is 0 and the row still shows its tokens, so
 * nothing is hidden — just unpriced.
 */
export const PRICES = {
	"gemini-3.1-flash-lite": {
		input: 0.1,
		output: 0.4,
		cacheRead: 0.025,
		batch: { input: 0.05, output: 0.2 },
	},
	"gemini-3.5-flash": {
		input: 0.3,
		output: 2.5,
		cacheRead: 0.075,
		batch: { input: 0.15, output: 1.25 },
	},
	"claude-sonnet-5": {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5,
		perSearch: 0.01,
	},
	"claude-haiku-4-5": {
		input: 1,
		output: 5,
		cacheRead: 0.1,
		cacheWrite: 1.25,
		perSearch: 0.01,
	},
	"gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, perSearch: 0.01 },
	"sonar-pro": { input: 3, output: 15, perSearch: 0.008 },
} as const satisfies Record<string, Price>;

export type PricedModel = keyof typeof PRICES;

/** Rough spend for one call or one stage. `batch` prices it at the provider's
 * batch rate when the model has one. */
export function estimateUsd(
	model: string,
	u: Partial<StageUsage>,
	batch = false,
): number {
	const p = (PRICES as Record<string, Price | undefined>)[model];
	if (!p) return 0;
	const rate = batch && p.batch ? { ...p, ...p.batch } : p;
	const uncached = (u.promptTokens ?? 0) - (u.cachedTokens ?? 0);
	return (
		(Math.max(0, uncached) * rate.input +
			(u.cachedTokens ?? 0) * (rate.cacheRead ?? rate.input) +
			(u.cacheWriteTokens ?? 0) * (rate.cacheWrite ?? rate.input) +
			((u.outputTokens ?? 0) + (u.thoughtTokens ?? 0)) * rate.output) /
			1_000_000 +
		(u.searchQueries ?? 0) * (rate.perSearch ?? 0)
	);
}
