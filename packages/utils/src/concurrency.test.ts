import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, chunkArray, mapWithConcurrency } from "./concurrency.ts";

test("chunk splits into consecutive groups, the last one short", () => {
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(chunk([], 3), []);
	assert.equal(chunkArray, chunk);
});

test("mapWithConcurrency keeps input order and never exceeds the limit", async () => {
	let inFlight = 0;
	let peak = 0;
	const out = await mapWithConcurrency([30, 10, 20, 5], 2, async (ms, i) => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise((r) => setTimeout(r, ms));
		inFlight--;
		return `${i}:${ms}`;
	});
	assert.deepEqual(out, ["0:30", "1:10", "2:20", "3:5"]);
	assert.equal(peak, 2);
});

test("mapWithConcurrency over nothing resolves to nothing", async () => {
	assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});
