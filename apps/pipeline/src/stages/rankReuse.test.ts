import assert from "node:assert/strict";
import { test } from "node:test";
import { rankReuseKey } from "./rankReuse.ts";

function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		title: "Jazz Night",
		datetime_iso: "2026-09-09T19:00:00",
		location: "The Tivoli",
		category: "Concert / Music",
		description: "A night of jazz.",
		tags: ["jazz", "music"],
		...over,
	};
}

test("rankReuseKey is stable across identical events", () => {
	assert.equal(rankReuseKey("brisbane", ev()), rankReuseKey("brisbane", ev()));
});

test("rankReuseKey changes when identity changes", () => {
	const a = rankReuseKey("brisbane", ev());
	const b = rankReuseKey(
		"brisbane",
		ev({ datetime_iso: "2026-09-10T19:00:00" }),
	);
	assert.notEqual(a, b, "a different start time is a different event");
});

test("rankReuseKey changes when a field the prompt sees changes", () => {
	const a = rankReuseKey("brisbane", ev());
	const b = rankReuseKey("brisbane", ev({ description: "Something else." }));
	assert.notEqual(a, b, "a rewritten description invalidates the reused score");
});

test("rankReuseKey ignores description text beyond the prompt's truncation point", () => {
	const long = "x".repeat(400);
	const a = rankReuseKey("brisbane", ev({ description: `${long}A` }));
	const b = rankReuseKey("brisbane", ev({ description: `${long}B` }));
	assert.equal(
		a,
		b,
		"the prompt never sees past 300 chars, so neither should the key",
	);
});

test("rankReuseKey is scoped per city", () => {
	const a = rankReuseKey("brisbane", ev());
	const b = rankReuseKey("goldcoast", ev());
	assert.notEqual(a, b);
});
