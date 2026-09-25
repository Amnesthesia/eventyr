// One door for every model call: accounting, a shared per-provider limiter,
// 429-aware backoff, a hard run budget, the response cache and the replay
// harness. A module singleton on purpose — caps that cannot see each other
// add up (the account once hit "429 You exceeded your spend-based rate limit"
// mid-run with six modules each holding their own cap).
//
// The limit that bites is spend *per minute*, so smoothing bursts matters more
// than reducing totals: hence one process-wide limiter here rather than a
// number in every stage.

import { backoffDelay, sleep } from "@dothingslol/utils/time";
import { GoogleGenAI } from "@google/genai";
import { runGeminiBatch, toLLMUsage } from "./batch.ts";
import { cacheKey, readCached, writeCached } from "./cache.ts";
import {
	BatchError,
	BudgetExhaustedError,
	LLMUnavailableError,
} from "./errors.ts";
import { parseJsonArray } from "./json.ts";
import { estimateUsd } from "./pricing.ts";
import { geminiGenerate, replayRequestOf } from "./providers/gemini.ts";
import { Replay, replayLine, replayUsage } from "./replay.ts";
import type {
	AskOptions,
	LLMConfig,
	LLMProvider,
	LLMResponse,
	ProviderName,
	StageUsage,
} from "./types.ts";

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 5_000;
const DEFAULT_PROVIDER: LLMProvider = {
	provider: "gemini",
	model: "gemini-3.1-flash-lite",
};

export type AskParams = LLMProvider & AskOptions;

const KEY_ENV: Record<ProviderName, string> = {
	gemini: "GOOGLE_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
};

// --- state ----------------------------------------------------------------

class Limiter {
	private inFlight = 0;
	private readonly waiters: (() => void)[] = [];
	constructor(readonly ceiling: number) {}
	acquire(): Promise<void> {
		if (this.inFlight < this.ceiling) {
			this.inFlight++;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.inFlight--;
	}
}

interface State {
	config: LLMConfig;
	limiters: Partial<Record<ProviderName, Limiter>>;
	/** Gemini calls made (attempts included), against maxCalls. */
	totalCalls: number;
	usage: Map<string, StageUsage>;
	replay: Replay | null;
	gemini: GoogleGenAI | null;
}

function fresh(): State {
	return {
		config: {},
		limiters: {},
		totalCalls: 0,
		usage: new Map(),
		replay: null,
		gemini: null,
	};
}

let state = fresh();

/** Called once, from the pipeline's CLI bootstrap. */
export function configureLLM(config: LLMConfig): void {
	state = {
		...fresh(),
		config,
		usage: state.usage,
		totalCalls: state.totalCalls,
	};
	if (config.replay) state.replay = new Replay(config.replay);
}

/** Tests only: forget configuration, counters and clients. */
export function resetLLM(): void {
	state = fresh();
}

function ceilingFor(provider: ProviderName): number {
	const configured = state.config.concurrency?.[provider];
	if (configured !== undefined) return configured;
	// Deliberately low: the binding constraint is spend per minute, and a
	// burst is what trips it. Override with GEMINI_CONCURRENCY.
	return Number(process.env.GEMINI_CONCURRENCY ?? 4);
}

function limiter(provider: ProviderName): Limiter {
	let l = state.limiters[provider];
	if (!l) {
		l = new Limiter(ceilingFor(provider));
		state.limiters[provider] = l;
	}
	return l;
}

/** Hard ceiling on Gemini calls per run. Exceeding it stops the run cleanly
 * rather than erroring source by source — every long-running script is
 * resumable, so a bounded stop is a pause. */
function maxCalls(): number {
	return (
		state.config.maxCalls ??
		(Number(process.env.GEMINI_MAX_CALLS ?? 0) || Number.POSITIVE_INFINITY)
	);
}

function keyFor(provider: ProviderName): string {
	const key = state.config.keys?.[provider] ?? process.env[KEY_ENV[provider]];
	if (!key) throw new LLMUnavailableError(provider);
	return key;
}

function geminiClient(): GoogleGenAI {
	if (!state.gemini)
		state.gemini = new GoogleGenAI({ apiKey: keyFor("gemini") });
	return state.gemini;
}

// --- usage ----------------------------------------------------------------

function emptyUsage(): StageUsage {
	return {
		calls: 0,
		promptTokens: 0,
		outputTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
		thoughtTokens: 0,
		grounded: 0,
		searchQueries: 0,
		failures: 0,
		retries: 0,
		estimatedUsd: 0,
	};
}

/** Adds one call's numbers to a stage. Any provider may call this. */
export function recordUsage(stage: string, patch: Partial<StageUsage>): void {
	const current = state.usage.get(stage) ?? emptyUsage();
	for (const [k, v] of Object.entries(patch)) {
		current[k as keyof StageUsage] += v as number;
	}
	state.usage.set(stage, current);
	state.config.usage?.record(stage, patch);
}

/** Per-stage totals for this process, for the exit report and the run record. */
export function usageTotals(): Record<string, StageUsage> {
	return Object.fromEntries(
		[...state.usage].map(([stage, u]) => [stage, { ...u }]),
	);
}

/**
 * The 1.7 step-1 seam for the SDK call sites still outside llm: logs the
 * request line and, in replay mode, answers with the canned SDK response
 * (JSON, in that SDK's own shape) instead of calling `live`. Removed once the
 * transports move here (1.7 step 3).
 */
export async function replayCall<T>(
	provider: ProviderName,
	line: string,
	stage: string,
	live: () => Promise<T>,
): Promise<T> {
	const replay = state.replay;
	if (!replay) return live();
	replay.begin(line, provider);
	try {
		if (replay.mode === "replay")
			return JSON.parse(await replay.answer(line, stage)) as T;
		return await live();
	} finally {
		replay.end();
	}
}

// --- retry ----------------------------------------------------------------

/** Pulls a retry delay out of a 429/503 error, honouring Retry-After when the
 * API supplies one and falling back to jittered exponential backoff. */
export function retryDelayMs(err: unknown, attempt: number): number | null {
	const message = err instanceof Error ? err.message : String(err);
	const transient =
		/\b429\b|\b503\b|rate limit|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|high demand/i.test(
			message,
		);
	if (!transient) return null;
	const retryAfter = /retry(?:-|\s)?after["':\s]+(\d+)/i.exec(message);
	if (retryAfter) return Number(retryAfter[1]) * 1000;
	return backoffDelay(attempt, BASE_BACKOFF_MS);
}

// --- one call -------------------------------------------------------------

function resolve(opts?: AskParams): {
	provider: LLMProvider;
	stage: string;
	opts: AskOptions;
} {
	const { provider, model, ...rest } = opts ?? { ...DEFAULT_PROVIDER };
	return {
		provider: { provider, model } as LLMProvider,
		stage: rest.stage ?? "default",
		opts: rest,
	};
}

async function askOne(
	prompt: string,
	params?: AskParams,
): Promise<LLMResponse> {
	const { provider, stage, opts } = resolve(params);
	if (provider.provider !== "gemini") {
		throw new Error(`${provider.provider}: provider transport arrives in 1.7`);
	}
	const { model } = provider;
	const startedAt = performance.now();
	const done = (
		text: string,
		usage: Partial<StageUsage>,
		attempts: number,
		finishReason: string | null,
		fromCache: boolean,
	): LLMResponse => ({
		text,
		provider: "gemini",
		model,
		stage,
		usage: toLLMUsage(usage),
		attempts,
		durationMs: Math.round(performance.now() - startedAt),
		finishReason,
		fromCache,
		viaBatch: false,
	});

	const store = opts.cache ? state.config.cacheStore : undefined;
	const key = opts.cache && store ? cacheKey(opts.cache.version, prompt) : null;
	if (store && key && opts.cache) {
		const hit = await readCached(store, key, opts.cache.version);
		if (hit !== null) return done(hit, {}, 0, null, true);
	}

	if (state.totalCalls >= maxCalls())
		throw new BudgetExhaustedError(maxCalls());
	const replay = state.replay;
	const request = replayRequestOf(stage, model, prompt, opts);
	const line = replay ? replayLine(request) : "";
	if (replay?.mode !== "replay") keyFor("gemini");

	const l = limiter("gemini");
	await l.acquire();
	try {
		let response: LLMResponse;
		if (replay?.mode === "replay") {
			replay.begin(line, "gemini");
			try {
				state.totalCalls++;
				const text = await replay.answer(line, stage);
				const call: Partial<StageUsage> = {
					calls: 1,
					grounded: opts.search ? 1 : 0,
					...replayUsage(request, text),
				};
				call.estimatedUsd = estimateUsd(model, call);
				recordUsage(stage, call);
				response = done(text, call, 1, null, false);
			} catch (err) {
				recordUsage(stage, { failures: 1 });
				throw err;
			} finally {
				replay.end();
			}
		} else {
			response = await generateWithRetry(
				prompt,
				model,
				stage,
				opts,
				line,
				done,
			);
		}
		if (store && key && opts.cache) {
			await writeCached(store, key, opts.cache.version, prompt, response.text);
		}
		return response;
	} finally {
		l.release();
	}
}

async function generateWithRetry(
	prompt: string,
	model: string,
	stage: string,
	opts: AskOptions,
	line: string,
	done: (
		text: string,
		usage: Partial<StageUsage>,
		attempts: number,
		finishReason: string | null,
		fromCache: boolean,
	) => LLMResponse,
): Promise<LLMResponse> {
	const replay = state.replay;
	let lastErr: unknown;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			state.totalCalls++;
			replay?.begin(line, "gemini");
			const result = await geminiGenerate(geminiClient(), model, prompt, opts);
			replay?.end();
			const call: Partial<StageUsage> = { calls: 1, ...result.usage };
			call.estimatedUsd = estimateUsd(model, call);
			recordUsage(stage, call);
			return done(result.text, call, attempt + 1, result.finishReason, false);
		} catch (err) {
			replay?.end();
			lastErr = err;
			const delay = retryDelayMs(err, attempt);
			if (delay === null || attempt === MAX_RETRIES) break;
			recordUsage(stage, { retries: 1 });
			console.error(
				`  ⏳ [${stage}] rate limited — waiting ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
			);
			await sleep(delay);
		}
	}
	recordUsage(stage, { failures: 1 });
	throw lastErr;
}

// --- public API -----------------------------------------------------------

/**
 * Detailed form: the same calls, metadata returned. The array form is N
 * independent prompts with the same options, run concurrently under the
 * provider's limiter (D14) — or through the provider's batch API with
 * `batch`, at half price.
 */
export function askDetailed(
	prompt: string,
	opts?: AskParams,
): Promise<LLMResponse>;
export function askDetailed(
	prompts: string[],
	opts?: AskParams,
): Promise<PromiseSettledResult<LLMResponse>[]>;
export function askDetailed(
	input: string | string[],
	opts?: AskParams,
): Promise<LLMResponse | PromiseSettledResult<LLMResponse>[]> {
	if (typeof input === "string") return askOne(input, opts);
	if (opts?.batch) return askBatch(input, opts);
	return Promise.allSettled(input.map((p) => askOne(p, opts)));
}

async function askBatch(
	prompts: string[],
	params: AskParams,
): Promise<PromiseSettledResult<LLMResponse>[]> {
	const { provider, stage, opts } = resolve(params);
	if (provider.provider !== "gemini") {
		throw new Error(`${provider.provider}: batch transport arrives in 1.7`);
	}
	const batch = typeof opts.batch === "object" ? opts.batch : {};
	return runGeminiBatch(prompts, provider.model, stage, opts, batch, {
		client: geminiClient().batches,
		store: state.config.batchStore ?? null,
		fallback: (indices) =>
			Promise.allSettled(
				indices.map((i) => askOne(prompts[i], { ...params, batch: undefined })),
			),
		record: recordUsage,
	});
}

/** Simple form: text in, text out. The array form keeps order and rejects
 * with BatchError (per-index outcomes) if any prompt failed. */
export function ask(prompt: string, opts?: AskParams): Promise<string>;
export function ask(prompts: string[], opts?: AskParams): Promise<string[]>;
export async function ask(
	input: string | string[],
	opts?: AskParams,
): Promise<string | string[]> {
	if (typeof input === "string") return (await askOne(input, opts)).text;
	const outcomes = await askDetailed(input, opts);
	const failed = outcomes.filter((o) => o.status === "rejected");
	if (failed.length > 0) {
		throw new BatchError(
			`${failed.length} of ${input.length} prompts failed: ${(failed[0].reason as Error)?.message ?? failed[0].reason}`,
			outcomes,
		);
	}
	return outcomes.map(
		(o) => (o as PromiseFulfilledResult<LLMResponse>).value.text,
	);
}

export interface AskJsonOptions<T> {
	/** Validates the parsed array; a failure throws. */
	schema?: { parse(value: unknown): T };
	/** Retry once when a non-empty prompt gets an empty answer (default
	 * true). Only where the old call site retried — otherwise pass false so the
	 * number of requests stays identical. */
	retryEmpty?: boolean;
	/** Names the call in the parse-failure log. */
	label?: string;
}

/**
 * JSON mode + truncation-tolerant array parse (parseJsonArray) + optional
 * schema. An empty answer to a non-empty prompt is not an answer: retried once
 * unless `retryEmpty: false`.
 */
export async function askJson<T = unknown[]>(
	prompt: string,
	opts: AskParams & AskJsonOptions<T>,
): Promise<T> {
	const { schema, retryEmpty = true, label, ...rest } = opts;
	const params = { ...rest, json: true } as AskParams;
	let parsed = parseJsonArray<unknown>(
		(await askOne(prompt, params)).text,
		label,
	);
	if (parsed.length === 0 && retryEmpty && prompt.trim()) {
		parsed = parseJsonArray<unknown>(
			(await askOne(prompt, params)).text,
			label,
		);
	}
	return schema ? schema.parse(parsed) : (parsed as unknown as T);
}
