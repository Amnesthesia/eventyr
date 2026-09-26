import type { LLMResponse, ProviderName } from "./types.ts";

export class BudgetExhaustedError extends Error {
	constructor(limit: number) {
		super(
			`Gemini call budget exhausted (${limit} calls). Progress is saved — rerun the same command to continue, or raise GEMINI_MAX_CALLS.`,
		);
		this.name = "BudgetExhaustedError";
	}
}

const KEY_ENV: Record<ProviderName, string> = {
	gemini: "GOOGLE_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
};

/** No key for the provider. Callers keep their own fallback (degrade, don't die). */
export class LLMUnavailableError extends Error {
	constructor(readonly provider: ProviderName) {
		super(`${provider}: no API key (set ${KEY_ENV[provider]})`);
		this.name = "LLMUnavailableError";
	}
}

/** One or more prompts of an array call failed; `outcomes` is per index. */
export class BatchError extends Error {
	constructor(
		message: string,
		readonly outcomes: PromiseSettledResult<LLMResponse>[],
	) {
		super(message);
		this.name = "BatchError";
	}
}

/** The provider's batch transport cannot carry this option. Never dropped
 * silently: the caller asked for it, so the request would be a lie without it. */
export class BatchNotSupportedError extends Error {
	constructor(
		readonly option: string,
		reason: string,
	) {
		super(`batch: ${option} is not supported — ${reason}`);
		this.name = "BatchNotSupportedError";
	}
}
