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

import type { GoogleGenAI } from "@google/genai";

export interface GeminiUsage {
	calls: number;
	promptTokens: number;
	outputTokens: number;
	cachedTokens: number;
	grounded: number;
	failures: number;
	retries: number;
}

/** Usage per named stage, so the summary says which stage spent the money. */
const usage = new Map<string, GeminiUsage>();

function record(stage: string, patch: Partial<GeminiUsage>): void {
	const current = usage.get(stage) ?? {
		calls: 0,
		promptTokens: 0,
		outputTokens: 0,
		cachedTokens: 0,
		grounded: 0,
		failures: 0,
		retries: 0,
	};
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
				record(opts.stage, {
					calls: 1,
					promptTokens: meta?.promptTokenCount ?? 0,
					// thoughts are billed as output on thinking models
					outputTokens:
						(meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
					cachedTokens: meta?.cachedContentTokenCount ?? 0,
					grounded: opts.search ? 1 : 0,
				});
				return response.text ?? "";
			} catch (err) {
				lastErr = err;
				const delay = retryDelayMs(err, attempt);
				if (delay === null || attempt === MAX_RETRIES) break;
				record(opts.stage, { retries: 1 });
				console.error(
					`  ⏳ [${opts.stage}] rate limited — waiting ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
				);
				await sleep(delay);
			}
		}
		record(opts.stage, { failures: 1 });
		throw lastErr;
	} finally {
		release();
	}
}

let reported = false;

/** Prints what the run actually spent, per stage. Cheap to call, and the only
 * way to know whether an optimisation worked.
 *
 * Idempotent: scripts call it explicitly before exiting AND it is wired to the
 * process exit hook, so without the guard the summary printed twice. */
export function reportGeminiUsage(): void {
	if (reported || usage.size === 0) return;
	reported = true;
	const rows = [...usage.entries()].sort(
		(a, b) => b[1].promptTokens - a[1].promptTokens,
	);
	const totals: GeminiUsage = {
		calls: 0,
		promptTokens: 0,
		outputTokens: 0,
		cachedTokens: 0,
		grounded: 0,
		failures: 0,
		retries: 0,
	};
	console.log("\nGemini usage");
	console.log(
		`  ${"stage".padEnd(24)} ${"calls".padStart(6)} ${"in".padStart(10)} ${"out".padStart(8)} ${"cached".padStart(8)} ${"search".padStart(7)}`,
	);
	for (const [stage, u] of rows) {
		for (const k of Object.keys(totals) as (keyof GeminiUsage)[]) {
			totals[k] += u[k];
		}
		console.log(
			`  ${stage.slice(0, 24).padEnd(24)} ${String(u.calls).padStart(6)} ${u.promptTokens.toLocaleString().padStart(10)} ${u.outputTokens.toLocaleString().padStart(8)} ${u.cachedTokens.toLocaleString().padStart(8)} ${String(u.grounded).padStart(7)}`,
		);
	}
	console.log(
		`  ${"TOTAL".padEnd(24)} ${String(totals.calls).padStart(6)} ${totals.promptTokens.toLocaleString().padStart(10)} ${totals.outputTokens.toLocaleString().padStart(8)} ${totals.cachedTokens.toLocaleString().padStart(8)} ${String(totals.grounded).padStart(7)}`,
	);
	if (totals.retries > 0 || totals.failures > 0) {
		console.log(
			`  (${totals.retries} rate-limit retries, ${totals.failures} calls failed outright)`,
		);
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
