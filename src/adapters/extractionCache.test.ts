import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RawCandidateFields } from "./types.ts";

// The cache writes under DATA_ROOT, so point that at a scratch dir before the
// module under test resolves it.
const scratch = mkdtempSync(join(tmpdir(), "eventyr-cache-"));
process.env.EVENTYR_DATA_ROOT = scratch;

const { withExtractionCache } = await import("./extractionCache.ts");

function fields(title: string): RawCandidateFields[] {
	return [
		{
			title,
			description: null,
			startRaw: "2026-09-09",
			endRaw: null,
			venueName: null,
			address: null,
			url: null,
			price: null,
			imageUrl: null,
			organiser: null,
			category: null,
			sourceEventId: null,
		},
	];
}

test("a repeated page is extracted once", async () => {
	let calls = 0;
	const extract = withExtractionCache(async () => {
		calls++;
		return fields("Gig");
	});
	const text = "a listing page with events ".repeat(20);

	const first = await extract(text, "Venue");
	const second = await extract(text, "Venue");

	assert.equal(calls, 1, "second call should come from the cache");
	assert.deepEqual(second, first);
	assert.deepEqual(extract.stats, { hits: 1, misses: 1 });
});

test("different page text is a separate entry", async () => {
	let calls = 0;
	const extract = withExtractionCache(async () => {
		calls++;
		return fields("Gig");
	});
	await extract("page one content here", "Venue");
	await extract("page two content here", "Venue");
	assert.equal(calls, 2);
	assert.equal(extract.stats.hits, 0);
});

test("an empty extraction is cached — 'no events' is a real answer", async () => {
	let calls = 0;
	const extract = withExtractionCache(async () => {
		calls++;
		return [];
	});
	await extract("an empty listing page", "Venue");
	await extract("an empty listing page", "Venue");
	assert.equal(calls, 1);
	assert.equal(extract.stats.hits, 1);
});

test("force bypasses the read but still populates the cache", async () => {
	let calls = 0;
	const make = (force: boolean) =>
		withExtractionCache(
			async () => {
				calls++;
				return fields("Gig");
			},
			{ force },
		);
	const text = "forced page content";

	await make(false)(text, "Venue"); // populate
	await make(true)(text, "Venue"); // force: re-extract
	assert.equal(calls, 2);
	// the forced run rewrote the entry, so a later normal run still hits
	const after = make(false);
	await after(text, "Venue");
	assert.equal(calls, 2);
	assert.equal(after.stats.hits, 1);
});

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
