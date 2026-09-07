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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GoogleGenAI } from "@google/genai";
import { DATA_ROOT, getWeekRange, toISODate } from "../common.ts";

export interface GeminiUsage {
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

/**
 * USD per million tokens, plus per-search fees, for every model the pipeline
 * calls. ponytail: hand-maintained list; when a model is missing the estimate is
 * 0 and the row still shows its tokens, so nothing is hidden — just unpriced.
 */
export const PRICES: Record<
	string,
	{
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		/** USD per search query. Gemini grounding is free inside its monthly
		 * quota (5,000 prompts), so it is 0 here. */
		perSearch?: number;
	}
> = {
	"gemini-3.1-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.025 },
	"gemini-3.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
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
};

export function estimateUsd(model: string, u: Partial<GeminiUsage>): number {
	const p = PRICES[model];
	if (!p) return 0;
	const uncached = (u.promptTokens ?? 0) - (u.cachedTokens ?? 0);
	return (
		(Math.max(0, uncached) * p.input +
			(u.cachedTokens ?? 0) * (p.cacheRead ?? p.input) +
			(u.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input) +
			((u.outputTokens ?? 0) + (u.thoughtTokens ?? 0)) * p.output) /
			1_000_000 +
		(u.searchQueries ?? 0) * (p.perSearch ?? 0)
	);
}

function emptyUsage(): GeminiUsage {
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

/** Usage per named stage, so the summary says which stage spent the money. */
const usage = new Map<string, GeminiUsage>();

/** Adds one call's numbers to a stage. Any provider may call this. */
export function recordUsage(stage: string, patch: Partial<GeminiUsage>): void {
	const current = usage.get(stage) ?? emptyUsage();
	for (const [k, v] of Object.entries(patch)) {
		current[k as keyof GeminiUsage] += v as number;
	}
	usage.set(stage, current);
}

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

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
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
	const base = BASE_BACKOFF_MS * 2 ** attempt;
	return base + Math.floor(Math.random() * base * 0.3);
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
		let lastErr: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				totalCalls++;
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

/** Where a run's usage is persisted: one file per city-week, merged across the
 * five scripts that make up a run, committed alongside the data. */
export function usagePath(city: string, weekStart: string): string {
	return join(DATA_ROOT, city, "usage", `${weekStart}.json`);
}

/**
 * Merges this process's per-stage usage into the week's file. Additive per
 * stage, because collect/curate/rank each run as their own process and each
 * would otherwise overwrite the others.
 */
export function persistUsage(
	path: string,
	snapshot: Map<string, GeminiUsage>,
): void {
	let existing: Record<string, GeminiUsage> = {};
	if (existsSync(path)) {
		try {
			existing =
				(
					JSON.parse(readFileSync(path, "utf-8")) as {
						stages?: typeof existing;
					}
				).stages ?? {};
		} catch {
			// unreadable — start over rather than fail the run over accounting
		}
	}
	for (const [stage, u] of snapshot) {
		const merged = existing[stage] ?? emptyUsage();
		for (const k of Object.keys(u) as (keyof GeminiUsage)[]) merged[k] += u[k];
		existing[stage] = merged;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify(
			{ updated_at: new Date().toISOString(), stages: existing },
			null,
			2,
		),
		"utf-8",
	);
}

let reported = false;

/** Prints what the run actually spent, per stage, and merges it into the
 * week's usage file. The only way to know whether an optimisation worked.
 *
 * Idempotent: scripts call it explicitly before exiting AND it is wired to the
 * process exit hook, so without the guard the summary printed twice. */
export function reportGeminiUsage(): void {
	if (reported || usage.size === 0) return;
	reported = true;
	const rows = [...usage.entries()].sort(
		(a, b) => b[1].estimatedUsd - a[1].estimatedUsd,
	);
	const totals = emptyUsage();
	console.log("\nModel usage");
	console.log(
		`  ${"stage".padEnd(24)} ${"calls".padStart(6)} ${"in".padStart(10)} ${"out".padStart(8)} ${"think".padStart(7)} ${"cached".padStart(8)} ${"cachew".padStart(8)} ${"search".padStart(7)} ${"~usd".padStart(7)}`,
	);
	const line = (stage: string, u: GeminiUsage): string =>
		`  ${stage.slice(0, 24).padEnd(24)} ${String(u.calls).padStart(6)} ${u.promptTokens.toLocaleString().padStart(10)} ${u.outputTokens.toLocaleString().padStart(8)} ${u.thoughtTokens.toLocaleString().padStart(7)} ${u.cachedTokens.toLocaleString().padStart(8)} ${u.cacheWriteTokens.toLocaleString().padStart(8)} ${String(u.searchQueries).padStart(7)} ${u.estimatedUsd.toFixed(3).padStart(7)}`;
	for (const [stage, u] of rows) {
		for (const k of Object.keys(totals) as (keyof GeminiUsage)[]) {
			totals[k] += u[k];
		}
		console.log(line(stage, u));
	}
	console.log(line("TOTAL", totals));
	if (totals.retries > 0 || totals.failures > 0) {
		console.log(
			`  (${totals.retries} rate-limit retries, ${totals.failures} calls failed outright)`,
		);
	}
	const city = process.env.CITY;
	if (city) {
		const path = usagePath(city, toISODate(getWeekRange().monday));
		try {
			persistUsage(path, usage);
			console.log(`  → ${path}`);
		} catch (err) {
			console.error(
				`  ⚠ could not write usage file: ${(err as Error).message}`,
			);
		}
	}
}

/** Prints the usage summary when the process ends, however it ends — including
 * an unhandled throw or a Ctrl-C, which is exactly when you most want to know
 * what it had already spent. */
export function installUsageReporting(): void {
	process.on("exit", reportGeminiUsage);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			reportGeminiUsage();
			process.exit(130);
		});
	}
}
