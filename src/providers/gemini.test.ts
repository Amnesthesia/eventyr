import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { estimateUsd, persistUsage } from "./gemini.ts";

function usage(overrides: Partial<Record<string, number>> = {}) {
	return {
		calls: 1,
		promptTokens: 1000,
		outputTokens: 100,
		cachedTokens: 0,
		cacheWriteTokens: 0,
		thoughtTokens: 0,
		grounded: 0,
		searchQueries: 0,
		failures: 0,
		retries: 0,
		estimatedUsd: 0,
		...overrides,
	};
}

test("persistUsage writes a fresh file with the given stages", () => {
	const dir = mkdtempSync(join(tmpdir(), "eventyr-usage-"));
	const path = join(dir, "2026-09-07.json");
	persistUsage(path, new Map([["search/anthropic", usage()]]));
	const written = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(written.stages["search/anthropic"].calls, 1);
	rmSync(dir, { recursive: true, force: true });
});

test("persistUsage adds to an existing stage rather than overwriting it", () => {
	// Five scripts run per city-week (collect, curate, rank, geocode is
	// Gemini-free) and each calls reportGeminiUsage independently, so the file
	// has to accumulate across processes, not replace.
	const dir = mkdtempSync(join(tmpdir(), "eventyr-usage-"));
	const path = join(dir, "2026-09-07.json");
	persistUsage(
		path,
		new Map([["rank", usage({ calls: 2, promptTokens: 500 })]]),
	);
	persistUsage(
		path,
		new Map([["rank", usage({ calls: 3, promptTokens: 700 })]]),
	);
	const written = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(written.stages.rank.calls, 5);
	assert.equal(written.stages.rank.promptTokens, 1200);
	rmSync(dir, { recursive: true, force: true });
});

test("persistUsage keeps stages from a different script untouched", () => {
	const dir = mkdtempSync(join(tmpdir(), "eventyr-usage-"));
	const path = join(dir, "2026-09-07.json");
	persistUsage(path, new Map([["search/google", usage()]]));
	persistUsage(path, new Map([["rank", usage()]]));
	const written = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(written.stages["search/google"].calls, 1);
	assert.equal(written.stages.rank.calls, 1);
	rmSync(dir, { recursive: true, force: true });
});

test("persistUsage recovers from an unreadable existing file rather than failing the run", () => {
	const dir = mkdtempSync(join(tmpdir(), "eventyr-usage-"));
	const path = join(dir, "2026-09-07.json");
	writeFileSync(path, "not json");
	persistUsage(path, new Map([["rank", usage()]]));
	const written = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(written.stages.rank.calls, 1);
	rmSync(dir, { recursive: true, force: true });
});

test("estimateUsd prices uncached and cached tokens differently", () => {
	const cheap = estimateUsd("claude-sonnet-5", {
		promptTokens: 1_000_000,
		cachedTokens: 1_000_000,
		outputTokens: 0,
	});
	const full = estimateUsd("claude-sonnet-5", {
		promptTokens: 1_000_000,
		cachedTokens: 0,
		outputTokens: 0,
	});
	assert.ok(cheap < full, "a fully cached call must cost less than a cold one");
});

test("estimateUsd bills search queries as a flat per-query fee", () => {
	const withSearch = estimateUsd("claude-sonnet-5", { searchQueries: 3 });
	const without = estimateUsd("claude-sonnet-5", { searchQueries: 0 });
	assert.ok(withSearch > without);
});

test("estimateUsd returns 0 for an unpriced model rather than throwing", () => {
	assert.equal(estimateUsd("some-future-model", { promptTokens: 1000 }), 0);
});
