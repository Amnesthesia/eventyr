import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonArray } from "./json.ts";

test("parseJsonArray strips code fences and prose around the array", () => {
	assert.deepEqual(parseJsonArray('Sure:\n```json\n[{"i":1}]\n```'), [
		{ i: 1 },
	]);
});

test("parseJsonArray recovers the complete objects of a truncated array", () => {
	assert.deepEqual(parseJsonArray('[{"i":1},{"i":2},{"i":3,"t":"cut'), [
		{ i: 1 },
		{ i: 2 },
	]);
});

test("parseJsonArray returns [] when there is no array at all", () => {
	assert.deepEqual(parseJsonArray("no events"), []);
});
