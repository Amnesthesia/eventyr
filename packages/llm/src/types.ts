import type { PricedModel } from "./pricing.ts";

// Derived from the price table (one source of truth): an unpriced model can't
// be selected.
export type GeminiModel = Extract<PricedModel, `gemini-${string}`>;
export type AnthropicModel = Extract<PricedModel, `claude-${string}`>;
export type OpenAIModel = Extract<PricedModel, `gpt-${string}`>;
export type PerplexityModel = Extract<PricedModel, `sonar${string}`>;

export type LLMProvider =
	| { provider: "gemini"; model: GeminiModel }
	| { provider: "anthropic"; model: AnthropicModel }
	| { provider: "openai"; model: OpenAIModel }
	| { provider: "perplexity"; model: PerplexityModel };
export type ProviderName = LLMProvider["provider"];

export interface BatchOptions {
	/** How long to wait for the batch job before giving up on it. */
	deadlineMs?: number;
	/** cancel-and-sync (default): cancel the job, keep what finished, run the
	 * rest as normal calls. reject: throw BatchError, leave the job running
	 * for a later collect. */
	onDeadline?: "cancel-and-sync" | "reject";
}

export interface AskOptions {
	/** Usage bucket ("rank", "probe/extract"); default "default". */
	stage?: string;
	/** Stable instructions → system prompt (cacheable prefix). */
	system?: string;
	/** gemini googleSearch · anthropic web_search · openai web_search · perplexity (always). */
	search?: boolean;
	/** Provider JSON mode. */
	json?: boolean;
	thinking?: "off" | "low" | "default";
	maxOutputTokens?: number;
	temperature?: number;
	/** Content-addressed response cache (store injected via configureLLM);
	 * was adapters/extractionCache. */
	cache?: { version: string };
	/** Verbatim, provider-specific (e.g. anthropic max_uses). Merged last. */
	providerOptions?: Record<string, unknown>;
	/** Array form only: provider-native batch (D14). */
	batch?: boolean | BatchOptions;
}

export interface LLMUsage {
	inputTokens: number;
	outputTokens: number;
	thoughtTokens: number;
	cachedInputTokens: number;
	totalTokens: number;
	searchQueries: number;
	estimatedCostUsd: number;
}

export interface LLMResponse {
	text: string;
	provider: ProviderName;
	model: string;
	stage: string;
	usage: LLMUsage;
	attempts: number;
	durationMs: number;
	finishReason: string | null;
	fromCache: boolean;
	viaBatch: boolean;
}

/**
 * Per-stage accounting, the shape the pipeline persists to
 * data/{city}/usage/*.json and prints at exit. The field names are that
 * file's format and are frozen. Every provider records into it; the search
 * providers (Anthropic, OpenAI, Perplexity) do so with their own SDK's numbers
 * until 1.7 moves them here.
 */
export interface StageUsage {
	calls: number;
	promptTokens: number;
	outputTokens: number;
	cachedTokens: number;
	/** Tokens written to a provider prompt cache (Anthropic bills these at 1.25×). */
	cacheWriteTokens: number;
	/** Reasoning/thinking tokens — billed as output, reported separately so a
	 * model that thinks by default shows up as such. */
	thoughtTokens: number;
	/** Calls that used a search tool. */
	grounded: number;
	/** Individual web searches executed — the unit search fees are billed in. */
	searchQueries: number;
	failures: number;
	retries: number;
	/** Rough spend from PRICES. An estimate for ranking stages against each
	 * other, not an invoice. */
	estimatedUsd: number;
}

/** Observes every usage record as it lands (the run record, D16). Totals are
 * kept inside llm regardless; see usageTotals(). */
export interface UsageSink {
	record(stage: string, patch: Partial<StageUsage>): void;
}

/** Content-addressed response store. Keys are opaque hashes; entries are
 * JSON-serialisable and validated by llm on read. */
export interface CacheStore {
	get(key: string): Promise<unknown | null>;
	set(key: string, entry: unknown): Promise<void>;
}

export interface StoredBatchJob {
	provider: ProviderName;
	model: string;
	stage: string;
	/** The provider's job resource name. */
	jobName: string;
	count: number;
	createdAt: string;
}

/** Persists batch job ids so a run killed mid-wait collects the job instead
 * of resubmitting it. Keyed by the request hash. */
export interface BatchStore {
	get(key: string): Promise<StoredBatchJob | null>;
	set(key: string, job: StoredBatchJob): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface ReplayConfig {
	dir: string;
	mode: "record" | "replay";
	/** Artificial latency per replayed answer (default 200 ms), so the
	 * concurrency profile is measurable. */
	latencyMs?: number;
}

export interface LLMConfig {
	/** Default: GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, PERPLEXITY_API_KEY. */
	keys?: Partial<Record<ProviderName, string>>;
	/** Concurrent calls per provider. Gemini default: GEMINI_CONCURRENCY ?? 4. */
	concurrency?: Partial<Record<ProviderName, number>>;
	/** Hard ceiling on Gemini calls per run; was GEMINI_MAX_CALLS. */
	maxCalls?: number;
	usage?: UsageSink;
	cacheStore?: CacheStore;
	batchStore?: BatchStore;
	replay?: ReplayConfig;
}
