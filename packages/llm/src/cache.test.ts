import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	ask,
	askDetailed,
	type CacheStore,
	configureLLM,
	usageTotals,
} from "./index.ts";
import { cacheKey, resetLLM } from "./testing.ts";

function memoryStore(): CacheStore & { entries: Map<string, unknown> } {
	const entries = new Map<string, unknown>();
	return {
		entries,
		get: async (key) => entries.get(key) ?? null,
		set: async (key, entry) => {
			entries.set(key, entry);
		},
	};
}

const GEMINI = {
	provider: "gemini",
	model: "gemini-3.1-flash-lite",
	stage: "t",
} as const;
let dir: string;
beforeEach(() => {
	resetLLM();
	dir = mkdtempSync(join(tmpdir(), "llm-cache-"));
	mkdirSync(join(dir, "responses"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetLLM();
});

test("V5: an entry written by adapters/extractionCache.ts is a hit", async () => {
	// The old cache: sha1("v3\n" + pageText) → { promptVersion, fields, … }.
	const pageText = "Programme\n\nOpen Mic Comedy\nWed 23 Sep 2026, 7:00pm";
	const oldKey = createHash("sha1").update(`v3\n${pageText}`).digest("hex");
	assert.equal(cacheKey("v3", pageText), oldKey);
	const store = memoryStore();
	store.entries.set(oldKey, {
		promptVersion: "v3",
		sourceName: "Fixture",
		textLength: pageText.length,
		extractedAt: "2026-09-01T00:00:00.000Z",
		fields: [{ title: "Open Mic Comedy", startRaw: "Wed 23 Sep 2026, 7:00pm" }],
	});
	configureLLM({
		cacheStore: store,
		replay: { dir, mode: "replay", latencyMs: 0 },
	});
	const r = await askDetailed(pageText, {
		...GEMINI,
		cache: { version: "v3" },
	});
	assert.equal(r.fromCache, true);
	assert.deepEqual(JSON.parse(r.text), [
		{ title: "Open Mic Comedy", startRaw: "Wed 23 Sep 2026, 7:00pm" },
	]);
	assert.equal(usageTotals().t, undefined, "a cache hit makes no call");
});

test("a different prompt version misses, and a fresh answer is written back", async () => {
	const store = memoryStore();
	configureLLM({
		cacheStore: store,
		replay: { dir, mode: "replay", latencyMs: 0 },
	});
	await assert.rejects(
		ask("page", { ...GEMINI, cache: { version: "v4" } }),
		/fixture missing/,
	);
	assert.equal(store.entries.size, 0, "a failed call is not cached");
});
