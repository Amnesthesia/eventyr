// @dothingslol/llm — ask() across providers (PLAN §2.4). Gemini only until 1.7.

export type { AskJsonOptions, AskParams } from "./client.ts";
export {
	ask,
	askDetailed,
	askJson,
	configureLLM,
	recordUsage,
	retryDelayMs,
	usageTotals,
} from "./client.ts";
export {
	BatchError,
	BatchNotSupportedError,
	BudgetExhaustedError,
	LLMUnavailableError,
} from "./errors.ts";
export { parseJsonArray } from "./json.ts";
export { estimateUsd, PRICES } from "./pricing.ts";
export type * from "./types.ts";

import { PRICES } from "./pricing.ts";
import type { LLMProvider } from "./types.ts";

/** Every selectable provider/model pair, from the price table. */
export const MODELS: readonly LLMProvider[] = (
	Object.keys(PRICES) as (keyof typeof PRICES)[]
).map((model) => {
	if (model.startsWith("gemini-")) return { provider: "gemini", model };
	if (model.startsWith("claude-")) return { provider: "anthropic", model };
	if (model.startsWith("gpt-")) return { provider: "openai", model };
	return { provider: "perplexity", model };
}) as LLMProvider[];
