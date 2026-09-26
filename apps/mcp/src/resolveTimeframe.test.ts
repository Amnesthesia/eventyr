import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExplicitDate, resolveTimeframe } from "./resolveTimeframe.ts";

const WEEK = ["2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]; // Thu..Sun, matching a week_end of Sunday

test("today resolves to the city's own current day", () => {
	assert.deepEqual(resolveTimeframe("today", "2026-09-17", WEEK, true), {
		kind: "day",
		date: "2026-09-17",
	});
});

test("tomorrow resolves to the next day", () => {
	assert.deepEqual(resolveTimeframe("tomorrow", "2026-09-17", WEEK, true), {
		kind: "day",
		date: "2026-09-18",
	});
});

test("tomorrow is unavailable once it falls past the published week", () => {
	const plan = resolveTimeframe("tomorrow", "2026-09-20", WEEK, true);
	assert.equal(plan.kind, "unavailable");
});

test("this_weekend returns both Saturday and Sunday mid-week", () => {
	assert.deepEqual(resolveTimeframe("this_weekend", "2026-09-17", WEEK, true), {
		kind: "days",
		dates: ["2026-09-19", "2026-09-20"],
	});
});

test("this_weekend on Sunday is just today", () => {
	assert.deepEqual(resolveTimeframe("this_weekend", "2026-09-20", WEEK, true), {
		kind: "days",
		dates: ["2026-09-20"],
	});
});

test("this_weekend is unavailable when neither day has published yet", () => {
	const plan = resolveTimeframe("this_weekend", "2026-09-14", [], true);
	assert.equal(plan.kind, "unavailable");
});

test("this_week resolves to the week file when one exists", () => {
	assert.deepEqual(resolveTimeframe("this_week", "2026-09-17", WEEK, true), {
		kind: "week",
	});
});

test("this_week is unavailable with no week file", () => {
	const plan = resolveTimeframe("this_week", "2026-09-17", WEEK, false);
	assert.equal(plan.kind, "unavailable");
});

test("next_week is always unavailable", () => {
	const plan = resolveTimeframe("next_week", "2026-09-17", WEEK, true);
	assert.equal(plan.kind, "unavailable");
});

test("resolveExplicitDate accepts a published day within range", () => {
	assert.deepEqual(resolveExplicitDate("2026-09-18", "2026-09-17", WEEK), {
		kind: "day",
		date: "2026-09-18",
	});
});

test("resolveExplicitDate rejects a malformed date without guessing", () => {
	const plan = resolveExplicitDate("March 15th", "2026-09-17", WEEK);
	assert.equal(plan.kind, "unavailable");
	assert.match(
		plan.kind === "unavailable" ? plan.reason : "",
		/not a valid date/,
	);
});

test("resolveExplicitDate rejects a date before today", () => {
	const plan = resolveExplicitDate("2026-09-01", "2026-09-17", WEEK);
	assert.equal(plan.kind, "unavailable");
	assert.match(plan.kind === "unavailable" ? plan.reason : "", /in the past/);
});

test("resolveExplicitDate rejects a date past the published week", () => {
	const plan = resolveExplicitDate("2026-09-25", "2026-09-17", WEEK);
	assert.equal(plan.kind, "unavailable");
	assert.match(
		plan.kind === "unavailable" ? plan.reason : "",
		/beyond the currently published week/,
	);
});
