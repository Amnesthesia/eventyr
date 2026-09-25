import assert from "node:assert/strict";
import { test } from "node:test";
import { getWeekRange, isValidTimeZone, toISODate } from "./common.ts";

// Local-time dates so the test does not depend on the host timezone.
const on = (y: number, m: number, d: number) => new Date(y, m - 1, d, 9, 30);

test("getWeekRange: Sunday belongs to the coming week, every other day to the current one", () => {
	// The digest runs Sunday morning for the week starting tomorrow; the cron
	// schedule depends on this branch.
	const sunday = getWeekRange(on(2026, 9, 13));
	assert.equal(toISODate(sunday.monday), "2026-09-14");
	assert.equal(toISODate(sunday.sunday), "2026-09-20");

	const monday = getWeekRange(on(2026, 9, 14));
	assert.equal(toISODate(monday.monday), "2026-09-14");

	const saturday = getWeekRange(on(2026, 9, 12));
	assert.equal(toISODate(saturday.monday), "2026-09-07");
	assert.equal(toISODate(saturday.sunday), "2026-09-13");
});

test("isValidTimeZone: IANA zones pass; offsets, abbreviations and junk do not", () => {
	assert.equal(isValidTimeZone("Australia/Sydney"), true);
	assert.equal(isValidTimeZone("Australia/Brisbane"), true);
	// A fixed offset is the no-DST assumption this check exists to keep out.
	assert.equal(isValidTimeZone("+10:00"), false);
	assert.equal(isValidTimeZone("AEST"), false);
	assert.equal(isValidTimeZone(""), false);
	assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
});
