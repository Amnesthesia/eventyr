/**
 * Loads and validates `config/pipeline.yml`.
 *
 * Rules:
 * - Parsed with js-yaml.
 * - Validated with zod. Model entries must be a key of @dothingslol/llm's MODELS;
 *   the loader fails with the offending key path if not.
 * - Env overrides (GEMINI_CONCURRENCY, GEMINI_MAX_CALLS, RENDER_RUN_BUDGET_MS,
 *   PROBE_CONCURRENT_HOSTS, PROBE_SOURCE_TIMEOUT_MS, ANTHROPIC_SEARCH_MODEL) apply after
 *   validation and take precedence over the YAML.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS } from "@dothingslol/llm";
import yaml from "js-yaml";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the config directory (apps/pipeline/config/). */
export const CONFIG_DIR = join(__dirname, "..", "..", "config");

// ---- Zod schema ----

const validModelNames = MODELS.map((m) => m.model) as [string, ...string[]];

const ModelEntry = z.object({
	provider: z.string(),
	model: z.enum(validModelNames),
});

const PipelineConfigSchema = z.object({
	models: z.object({
		search: z.object({
			google: ModelEntry,
			anthropic: ModelEntry,
			openai: ModelEntry,
			perplexity: ModelEntry,
		}),
		searchCurate: ModelEntry,
		extract: ModelEntry,
		annotate: ModelEntry,
		dedupe: ModelEntry,
		probe: ModelEntry,
		venues: ModelEntry,
		rank: ModelEntry,
		discover: ModelEntry,
	}),
	llm: z.object({
		concurrency: z.object({ gemini: z.number().int().positive() }),
		budget: z.object({ maxCalls: z.number().int().min(0) }),
		retries: z.object({
			max: z.number().int().min(0),
			baseBackoffMs: z.number().int().positive(),
		}),
		cache: z.object({ extractionMaxAgeDays: z.number().int().positive() }),
		prices: z.record(z.string(), z.unknown()).optional(),
	}),
	scrape: z.object({
		perHost: z.object({
			minIntervalMs: z.number().int().positive(),
			maxConcurrency: z.number().int().positive(),
		}),
		retries: z.object({
			max: z.number().int().min(0),
			baseBackoffMs: z.number().int().positive(),
		}),
		detailPages: z.object({
			concurrency: z.number().int().positive(),
			maxPerSource: z.number().int().positive(),
		}),
		render: z.object({
			concurrentHosts: z.number().int().positive(),
			pageTimeoutMs: z.number().int().positive(),
			runBudgetMs: z.number().int().positive(),
			settleMs: z.number().int().min(0),
		}),
		userAgent: z.string().min(1),
	}),
	stages: z.object({
		collectAdapters: z.object({ concurrency: z.number().int().positive() }),
		extract: z.object({
			maxOutputTokens: z.number().int().positive(),
			concurrency: z.number().int().positive(),
			maxBatchesPerPage: z.number().int().positive(),
		}),
		annotate: z.object({
			batchSize: z.number().int().positive(),
			concurrency: z.number().int().positive(),
		}),
		probe: z.object({
			maxCandidateFetches: z.number().int().positive(),
			maxKeptUrls: z.number().int().positive(),
			maxEvaluations: z.number().int().positive(),
			maxSitemapCandidates: z.number().int().positive(),
			urlBatchSize: z.number().int().positive(),
			urlBatchConcurrency: z.number().int().positive(),
			concurrentHosts: z.number().int().positive(),
			sourceTimeoutMs: z.number().int().positive(),
			gate: z.object({
				minTextLength: z.number().int().min(0),
				minDateHits: z.number().int().min(0),
			}),
			promote: z.object({
				minDated: z.number().int().min(0),
				minUpcoming: z.number().int().min(0),
				maxPastRatio: z.number().int().min(0),
			}),
		}),
		discover: z.object({ concurrency: z.number().int().positive() }),
		collect: z.object({
			anthropic: z.object({ maxWebSearches: z.number().int().positive() }),
			openai: z.object({ maxToolCalls: z.number().int().positive() }),
			sourceYield: z.object({
				hitWindowWeeks: z.number().int().positive(),
				graceDays: z.number().int().min(0),
				ledgerWeeks: z.number().int().positive(),
				minHistoryWeeks: z.number().int().positive(),
				unlistedReportMin: z.number().int().positive(),
			}),
		}),
		dedupe: z.object({
			pairBatchSize: z.number().int().positive(),
			concurrency: z.number().int().positive(),
			maxPairs: z.number().int().positive(),
			maybeMin: z.number().min(0).max(1),
		}),
		locality: z.object({
			concurrency: z.number().int().positive(),
			timeoutMs: z.number().int().positive(),
		}),
		venues: z.object({ batchSize: z.number().int().positive() }),
		rank: z.object({ batchSize: z.number().int().positive() }),
	}),
	publish: z.object({
		windowDaysAfterWeek: z.number().int().min(0),
		ai: z.object({
			weekSplitBytes: z.number().int().positive(),
			dayWarnBytes: z.number().int().positive(),
		}),
		icalExpandDays: z.number().int().positive(),
	}),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

let _cached: PipelineConfig | undefined;

/**
 * Loads `config/pipeline.yml`, validates it, applies env overrides, and caches the result.
 * Throws with a descriptive message if validation fails.
 */
export function loadPipelineConfig(
	path = join(CONFIG_DIR, "pipeline.yml"),
): PipelineConfig {
	if (_cached) return _cached;

	const raw = yaml.load(readFileSync(path, "utf-8"));
	const result = PipelineConfigSchema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`config/pipeline.yml validation failed:\n${issues}`);
	}

	const cfg = result.data;

	// Env overrides — workflows already set these; they take precedence over YAML.
	if (process.env.GEMINI_CONCURRENCY) {
		cfg.llm.concurrency.gemini = Number(process.env.GEMINI_CONCURRENCY);
	}
	if (process.env.GEMINI_MAX_CALLS) {
		cfg.llm.budget.maxCalls = Number(process.env.GEMINI_MAX_CALLS);
	}
	if (process.env.RENDER_RUN_BUDGET_MS) {
		cfg.scrape.render.runBudgetMs = Number(process.env.RENDER_RUN_BUDGET_MS);
	}
	if (process.env.PROBE_CONCURRENT_HOSTS) {
		cfg.stages.probe.concurrentHosts = Number(
			process.env.PROBE_CONCURRENT_HOSTS,
		);
	}
	if (process.env.PROBE_SOURCE_TIMEOUT_MS) {
		cfg.stages.probe.sourceTimeoutMs = Number(
			process.env.PROBE_SOURCE_TIMEOUT_MS,
		);
	}
	if (process.env.ANTHROPIC_SEARCH_MODEL) {
		// Validate the override model is known.
		const overrideModel = process.env.ANTHROPIC_SEARCH_MODEL;
		if (!validModelNames.includes(overrideModel)) {
			throw new Error(
				`ANTHROPIC_SEARCH_MODEL=${overrideModel} is not a recognised model. Known models: ${validModelNames.join(", ")}`,
			);
		}
		cfg.models.search.anthropic.model = overrideModel;
	}

	_cached = cfg;
	return cfg;
}

/** Reset the cached config (for tests). */
export function resetPipelineConfig(): void {
	_cached = undefined;
}

/**
 * Load INTERESTS verbatim from config/interests.md.
 * Byte-identical to the old INTERESTS constant.
 */
export function loadInterests(path = join(CONFIG_DIR, "interests.md")): string {
	return readFileSync(path, "utf-8");
}
