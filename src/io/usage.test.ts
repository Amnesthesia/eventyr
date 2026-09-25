import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { persistUsage } from "./usage.ts";

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
	persistUsage(path, { "search/anthropic": usage() });
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
	persistUsage(path, { rank: usage({ calls: 2, promptTokens: 500 }) });
	persistUsage(path, { rank: usage({ calls: 3, promptTokens: 700 }) });
	const written = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(written.stages.rank.calls, 5);
	assert.equal(written.stages.rank.promptTokens, 1200);
	rmSync(dir, { recursive: true, force: true });
});

test("persistUsage keeps stages from a different script untouched", () => {
	const dir = mkdtempSync(join(tmpdir(), "eventyr-usage-"));
	const path = join(dir, "2026-09-07.json");
	persistUsage(path, { "search/google": usage() });
	persistUsage(path, { rank: usage() });
	const written = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(written.stages["search/google"].calls, 1);
	assert.equal(written.stages.rank.calls, 1);
	rmSync(dir, { recursive: true, force: true });
});

test("persistUsage recovers from an unreadable existing file rather than failing the run", () => {
	const dir = mkdtempSync(join(tmpdir(), "eventyr-usage-"));
	const path = join(dir, "2026-09-07.json");
	writeFileSync(path, "not json");
	persistUsage(path, { rank: usage() });
	const written = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(written.stages.rank.calls, 1);
	rmSync(dir, { recursive: true, force: true });
});
