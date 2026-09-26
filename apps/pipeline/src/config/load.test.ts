import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MODELS } from "@dothingslol/llm";
import { stageModelCacheKey } from "../io/cacheKey.js";
import {
	CONFIG_DIR,
	loadInterests,
	loadPipelineConfig,
	resetPipelineConfig,
} from "./load.js";

// ── helpers ────────────────────────────────────────────────────────────────

function withEnv(
	overrides: Record<string, string | undefined>,
	fn: () => void,
): void {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(overrides)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

// ── interests.md ───────────────────────────────────────────────────────────

test("loadInterests returns byte-identical content to interests.md", () => {
	const fromFile = readFileSync(join(CONFIG_DIR, "interests.md"), "utf-8");
	const loaded = loadInterests();
	assert.equal(
		loaded,
		fromFile,
		"loadInterests must match interests.md byte-for-byte",
	);
});

// ── pipeline.yml ───────────────────────────────────────────────────────────

test("loadPipelineConfig returns valid config with correct defaults", () => {
	resetPipelineConfig();
	const cfg = loadPipelineConfig();

	// spot-check a few values that match the snapshot test
	assert.equal(cfg.models.annotate.model, "gemini-3.1-flash-lite");
	assert.equal(cfg.models.rank.model, "gemini-3.5-flash");
	assert.equal(cfg.models.venues.model, "gemini-3.5-flash");
	assert.equal(cfg.models.discover.model, "gemini-3.5-flash");
	assert.equal(cfg.models.search.anthropic.model, "claude-sonnet-5");
	assert.equal(cfg.llm.concurrency.gemini, 4);
	assert.equal(cfg.llm.budget.maxCalls, 0);
	assert.equal(cfg.llm.retries.max, 4);
	assert.equal(cfg.stages.rank.batchSize, 60);
	assert.equal(cfg.stages.venues.batchSize, 40);
	assert.equal(cfg.stages.dedupe.pairBatchSize, 30);
	assert.equal(cfg.publish.ai.weekSplitBytes, 200 * 1024);
	assert.equal(cfg.publish.ai.dayWarnBytes, 50 * 1024);
	assert.equal(cfg.stages.probe.gate.minTextLength, 1200);
	assert.equal(cfg.stages.probe.promote.minDated, 3);
	assert.equal(cfg.stages.probe.promote.minUpcoming, 1);
	assert.equal(cfg.stages.collect.sourceYield.hitWindowWeeks, 8);
	assert.equal(cfg.stages.collect.sourceYield.ledgerWeeks, 26);
});

test("GEMINI_CONCURRENCY env override is applied after YAML load", () => {
	resetPipelineConfig();
	withEnv({ GEMINI_CONCURRENCY: "8" }, () => {
		resetPipelineConfig();
		const cfg = loadPipelineConfig();
		assert.equal(cfg.llm.concurrency.gemini, 8);
	});
	resetPipelineConfig();
});

test("ANTHROPIC_SEARCH_MODEL env override replaces anthropic search model", () => {
	resetPipelineConfig();
	// Use a valid model for the override
	withEnv({ ANTHROPIC_SEARCH_MODEL: "claude-haiku-4-5" }, () => {
		resetPipelineConfig();
		const cfg = loadPipelineConfig();
		assert.equal(cfg.models.search.anthropic.model, "claude-haiku-4-5");
	});
	resetPipelineConfig();
});

test("loadPipelineConfig fails with clear message for invalid model", () => {
	resetPipelineConfig();
	// Write a temp config with an invalid model
	const tmpPath = join(CONFIG_DIR, "_test_bad_pipeline.yml");
	// Build a valid config and replace one model
	const validYaml = readFileSync(join(CONFIG_DIR, "pipeline.yml"), "utf-8");
	// Replace the first model entry with an invalid model name
	const badYaml = validYaml.replace(
		"model: gemini-3.5-flash",
		"model: nope-not-a-model",
	);
	writeFileSync(tmpPath, badYaml, "utf-8");
	try {
		resetPipelineConfig();
		assert.throws(
			() => loadPipelineConfig(tmpPath),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.ok(
					err.message.includes("validation failed"),
					`Expected 'validation failed' in: ${err.message}`,
				);
				return true;
			},
		);
	} finally {
		unlinkSync(tmpPath);
		resetPipelineConfig();
	}
});

test("all models in pipeline.yml are members of llm MODELS", () => {
	resetPipelineConfig();
	const cfg = loadPipelineConfig();
	const knownModels = new Set(MODELS.map((m) => m.model));

	const modelEntries: [string, string][] = [
		["models.search.google", cfg.models.search.google.model],
		["models.search.anthropic", cfg.models.search.anthropic.model],
		["models.search.openai", cfg.models.search.openai.model],
		["models.search.perplexity", cfg.models.search.perplexity.model],
		["models.searchCurate", cfg.models.searchCurate.model],
		["models.extract", cfg.models.extract.model],
		["models.annotate", cfg.models.annotate.model],
		["models.dedupe", cfg.models.dedupe.model],
		["models.probe", cfg.models.probe.model],
		["models.venues", cfg.models.venues.model],
		["models.rank", cfg.models.rank.model],
		["models.discover", cfg.models.discover.model],
	];

	for (const [key, model] of modelEntries) {
		assert.ok(
			knownModels.has(model as Parameters<typeof knownModels.has>[0]),
			`${key} model "${model}" is not in llm MODELS`,
		);
	}
});

// ── cache key model inclusion ───────────────────────────────────────────────

/**
 * The pre-refactor model for each stage. When the configured model matches,
 * the cache key must NOT include a model suffix (so existing caches stay hot).
 * When it differs, the key must include provider/model.
 */

/** Returns the cache key for a stage, including model suffix when not using the legacy model. */

test("stageModelCacheKey returns legacyKey when model matches pre-refactor model", () => {
	assert.equal(
		stageModelCacheKey("annotate:v4|event|2026-01-01|Brisbane", "annotate", {
			provider: "gemini",
			model: "gemini-3.1-flash-lite",
		}),
		"annotate:v4|event|2026-01-01|Brisbane",
	);
	assert.equal(
		stageModelCacheKey("rank:v4|event|score", "rank", {
			provider: "gemini",
			model: "gemini-3.5-flash",
		}),
		"rank:v4|event|score",
	);
});

test("stageModelCacheKey appends provider/model suffix when model differs from legacy", () => {
	assert.equal(
		stageModelCacheKey("rank:v4|event|score", "rank", {
			provider: "gemini",
			model: "gemini-3.1-flash-lite",
		}),
		"rank:v4|event|score:gemini/gemini-3.1-flash-lite",
	);
	assert.equal(
		stageModelCacheKey("annotate:v4|event|date|loc", "annotate", {
			provider: "gemini",
			model: "gemini-3.5-flash",
		}),
		"annotate:v4|event|date|loc:gemini/gemini-3.5-flash",
	);
});

test("stageModelCacheKey for an unknown stage always appends suffix", () => {
	// No legacy entry → any model produces a suffix
	assert.equal(
		stageModelCacheKey("dedupe:v1|pair", "dedupe", {
			provider: "gemini",
			model: "gemini-3.1-flash-lite",
		}),
		"dedupe:v1|pair:gemini/gemini-3.1-flash-lite",
	);
});
