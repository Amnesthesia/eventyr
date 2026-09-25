// One door for every Gemini call in the pipeline: accounting, a shared rate
// limiter, 429-aware backoff, and a hard run budget.
//
// This exists because the account hit `429 You exceeded your spend-based rate
// limit` mid-run and there was no way to see where the spend had gone. Every
// module had its own concurrency cap, and caps that cannot see each other do
// not bound anything: probe running six hosts, each extracting three pages,
// alongside four discovery batches, is thirteen concurrent calls no single
// constant predicts.
//
// The limit is spend *per minute*, so smoothing bursts matters more than
// reducing the total. Hence one process-wide limiter here rather than tuning
// numbers in six files.
//
// The accounting half is provider-agnostic: the other search providers
// (Anthropic, OpenAI, Perplexity) call recordUsage() with their own SDK's
// numbers so the usage file covers the whole run, not just Gemini.

import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	estimateUsd,
	type StageUsage as GeminiUsage,
	recordUsage,
} from "@dothingslol/llm";
import { backoffDelay, sleep } from "@dothingslol/utils/time";
import type { GoogleGenAI } from "@google/genai";

// Accounting lives in @dothingslol/llm from 1.6 step 4 on; the search
// providers and the not-yet-migrated call sites record through these
// re-exports so one table covers the whole run during the migration.
export {
	estimateUsd,
	PRICES,
	recordUsage,
	type StageUsage as GeminiUsage,
} from "@dothingslol/llm";
export {
	installUsageReporting,
	persistUsage,
	reportGeminiUsage,
	usagePath,
} from "../io/usage.ts";

/**
 * Concurrent Gemini calls across the whole process. Deliberately low: the
 * binding constraint is spend per minute, and a burst is what trips it.
 * Override with GEMINI_CONCURRENCY.
 */
const CONCURRENCY = Number(process.env.GEMINI_CONCURRENCY ?? 4);
/** Hard ceiling on calls per run. Exceeding it stops the run cleanly rather
 * than erroring source by source — every long-running script is resumable, so
 * a bounded stop is a pause. */
const MAX_CALLS =
	Number(process.env.GEMINI_MAX_CALLS ?? 0) || Number.POSITIVE_INFINITY;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 5_000;

export class BudgetExhaustedError extends Error {
	constructor(limit: number) {
		super(
			`Gemini call budget exhausted (${limit} calls). Progress is saved — rerun the same command to continue, or raise GEMINI_MAX_CALLS.`,
		);
		this.name = "BudgetExhaustedError";
	}
}

let inFlight = 0;
let totalCalls = 0;
const waiters: (() => void)[] = [];

function acquire(): Promise<void> {
	if (inFlight < CONCURRENCY) {
		inFlight++;
		return Promise.resolve();
	}
	return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
	const next = waiters.shift();
	if (next) next();
	else inFlight--;
}

/** Pulls a retry delay out of a 429/503 error, honouring Retry-After when the
 * API supplies one and falling back to jittered exponential backoff. */
function retryDelayMs(err: unknown, attempt: number): number | null {
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

// ponytail: record/replay seam for the 1.6 LLM parity harness
// (scripts/llm-parity.mjs). Replaced by @dothingslol/llm's replay mode in
// 1.6 step 3; the line format below is the contract the goldens are stored in.
//   EVENTYR_LLM_REPLAY=record  → append one sorted-key JSON line per call to
//                                $EVENTYR_LLM_REPLAY_DIR/requests.jsonl, then call.
//   EVENTYR_LLM_REPLAY=replay  → same line, but answer from
//                                $EVENTYR_LLM_REPLAY_DIR/responses/<sha256(line)>.txt
//                                after EVENTYR_LLM_REPLAY_LATENCY_MS (200); no network.
// Usage in replay is derived from the text lengths so the cost report is
// deterministic. requests.meta.json records peak in-flight calls and the
// first-call → last-call wall-clock (PLAN §9 concurrency check).
const REPLAY_MODE = process.env.EVENTYR_LLM_REPLAY as
	| "record"
	| "replay"
	| undefined;
const REPLAY_DIR = process.env.EVENTYR_LLM_REPLAY_DIR ?? "";
const REPLAY_LATENCY_MS = Number(
	process.env.EVENTYR_LLM_REPLAY_LATENCY_MS ?? 200,
);
const replayMeta = {
	calls: 0,
	inFlight: 0,
	peakInFlight: { gemini: 0 },
	startedAt: 0,
	wallClockMs: 0,
};

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
		);
	}
	return value;
}

function replayLine(opts: GeminiCallOptions): string {
	return JSON.stringify(
		sortKeys({
			stage: opts.stage,
			model: opts.model,
			contents: opts.contents,
			systemInstruction: opts.systemInstruction,
			maxOutputTokens: opts.maxOutputTokens,
			temperature: opts.temperature,
			search: opts.search,
			extraConfig: opts.extraConfig,
		}),
	);
}

function replayBegin(line: string): void {
	if (!REPLAY_DIR)
		throw new Error("EVENTYR_LLM_REPLAY needs EVENTYR_LLM_REPLAY_DIR");
	mkdirSync(REPLAY_DIR, { recursive: true });
	appendFileSync(join(REPLAY_DIR, "requests.jsonl"), `${line}\n`, "utf-8");
	if (replayMeta.calls === 0) replayMeta.startedAt = performance.now();
	replayMeta.calls++;
	replayMeta.inFlight++;
	replayMeta.peakInFlight.gemini = Math.max(
		replayMeta.peakInFlight.gemini,
		replayMeta.inFlight,
	);
}

function replayEnd(): void {
	replayMeta.inFlight--;
	replayMeta.wallClockMs = Math.round(performance.now() - replayMeta.startedAt);
	const { inFlight: _, startedAt: __, ...meta } = replayMeta;
	writeFileSync(
		join(REPLAY_DIR, "requests.meta.json"),
		JSON.stringify(meta, null, 2),
		"utf-8",
	);
}

async function replayAnswer(
	line: string,
	opts: GeminiCallOptions,
): Promise<string> {
	const hash = createHash("sha256").update(line).digest("hex");
	const path = join(REPLAY_DIR, "responses", `${hash}.txt`);
	await sleep(REPLAY_LATENCY_MS);
	if (!existsSync(path)) {
		// Leave the request behind so the fixture can be authored by hand.
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path.slice(0, -4)}.missing.json`, `${line}\n`, "utf-8");
		throw new Error(`replay fixture missing: ${path} (stage ${opts.stage})`);
	}
	return readFileSync(path, "utf-8");
}

/** Deterministic stand-in for usageMetadata on a replayed call. */
function replayUsage(
	opts: GeminiCallOptions,
	text: string,
): Partial<GeminiUsage> {
	return {
		promptTokens: Math.ceil(
			(opts.contents.length + (opts.systemInstruction?.length ?? 0)) / 4,
		),
		outputTokens: Math.ceil(text.length / 4),
		thoughtTokens: 0,
		cachedTokens: 0,
		searchQueries: opts.search ? 1 : 0,
	};
}

export interface GeminiCallOptions {
	/** Name this call's stage, e.g. "probe/extract". Groups the accounting. */
	stage: string;
	model: string;
	contents: string;
	systemInstruction?: string;
	maxOutputTokens?: number;
	temperature?: number;
	/** Google Search grounding. Counted separately — it is the expensive kind. */
	search?: boolean;
	/** Anything else the call needs (responseMimeType, thinkingConfig …). */
	extraConfig?: Record<string, unknown>;
}

/**
 * Makes one Gemini call under the shared limiter, retrying transient rate-limit
 * and availability errors. Returns the response text, or throws.
 */
export async function geminiText(
	ai: GoogleGenAI,
	opts: GeminiCallOptions,
): Promise<string> {
	if (totalCalls >= MAX_CALLS) throw new BudgetExhaustedError(MAX_CALLS);

	await acquire();
	try {
		if (REPLAY_MODE === "replay") {
			const line = replayLine(opts);
			replayBegin(line);
			try {
				totalCalls++;
				const text = await replayAnswer(line, opts);
				const call = {
					calls: 1,
					grounded: opts.search ? 1 : 0,
					...replayUsage(opts, text),
				};
				recordUsage(opts.stage, {
					...call,
					estimatedUsd: estimateUsd(opts.model, call),
				});
				return text;
			} catch (err) {
				recordUsage(opts.stage, { failures: 1 });
				throw err;
			} finally {
				replayEnd();
			}
		}
		let lastErr: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				totalCalls++;
				if (REPLAY_MODE === "record") replayBegin(replayLine(opts));
				const response = await ai.models.generateContent({
					model: opts.model,
					contents: opts.contents,
					config: {
						...(opts.systemInstruction
							? { systemInstruction: opts.systemInstruction }
							: {}),
						...(opts.search ? { tools: [{ googleSearch: {} }] } : {}),
						...(opts.maxOutputTokens
							? { maxOutputTokens: opts.maxOutputTokens }
							: {}),
						...(opts.temperature !== undefined
							? { temperature: opts.temperature }
							: {}),
						...(opts.extraConfig ?? {}),
					},
				});
				if (REPLAY_MODE === "record") replayEnd();
				const meta = response.usageMetadata;
				const call: Partial<GeminiUsage> = {
					calls: 1,
					promptTokens: meta?.promptTokenCount ?? 0,
					outputTokens: meta?.candidatesTokenCount ?? 0,
					thoughtTokens: meta?.thoughtsTokenCount ?? 0,
					cachedTokens: meta?.cachedContentTokenCount ?? 0,
					grounded: opts.search ? 1 : 0,
					// Grounding is billed per search query executed, not per call —
					// one prompt can fan out into several.
					searchQueries: opts.search
						? (response.candidates?.[0]?.groundingMetadata?.webSearchQueries
								?.length ?? 0)
						: 0,
				};
				call.estimatedUsd = estimateUsd(opts.model, call);
				recordUsage(opts.stage, call);
				return response.text ?? "";
			} catch (err) {
				if (REPLAY_MODE === "record") replayEnd();
				lastErr = err;
				const delay = retryDelayMs(err, attempt);
				if (delay === null || attempt === MAX_RETRIES) break;
				recordUsage(opts.stage, { retries: 1 });
				console.error(
					`  ⏳ [${opts.stage}] rate limited — waiting ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
				);
				await sleep(delay);
			}
		}
		recordUsage(opts.stage, { failures: 1 });
		throw lastErr;
	} finally {
		release();
	}
}
