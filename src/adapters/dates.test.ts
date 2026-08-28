import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDateRange, parseSingleDateTime } from "./dates.ts";

const REF = new Date("2026-06-01T00:00:00+10:00");

test("ISO date-only string is treated as Brisbane local midnight", () => {
	assert.equal(
		parseSingleDateTime("2026-06-14", REF),
		"2026-06-14T00:00:00+10:00",
	);
});

test("ISO datetime with explicit offset is trusted as-is", () => {
	assert.equal(
		parseSingleDateTime("2026-06-14T09:00:00Z", REF),
		new Date("2026-06-14T09:00:00Z").toISOString(),
	);
});

test("ISO datetime without offset is treated as Brisbane local time", () => {
	assert.equal(
		parseSingleDateTime("2026-06-14T19:00:00", REF),
		"2026-06-14T19:00:00+10:00",
	);
});

test("day-month-year with time, day-first", () => {
	assert.equal(
		parseSingleDateTime("14 June 2026, 7:00 PM", REF),
		"2026-06-14T19:00:00+10:00",
	);
});

test("slash date is parsed day-first, not month-first", () => {
	// 03/04 must be 3 April, never 4 March.
	assert.equal(
		parseSingleDateTime("03/04/2026", REF),
		"2026-04-03T00:00:00+10:00",
	);
});

test("omitted year uses the reference year", () => {
	assert.equal(
		parseSingleDateTime("14 June", REF),
		"2026-06-14T00:00:00+10:00",
	);
});

test("omitted year rolls to next year when far in the past relative to reference", () => {
	// Reference is 1 June 2026; "3 January" with no year should resolve to 2027.
	assert.equal(
		parseSingleDateTime("3 January", REF),
		"2027-01-03T00:00:00+10:00",
	);
});

test("unparseable date returns null rather than guessing", () => {
	assert.equal(parseSingleDateTime("Spring 2026", REF), null);
	assert.equal(parseSingleDateTime("every Tuesday", REF), null);
	assert.equal(parseSingleDateTime("", REF), null);
});

test("date range within one string with shared month/year on the left", () => {
	const { startISO, endISO } = parseDateRange("5 – 19 September 2026", REF);
	assert.equal(startISO, "2026-09-05T00:00:00+10:00");
	assert.equal(endISO, "2026-09-19T00:00:00+10:00");
});

test("open-ended 'until' range leaves start null, never inferred", () => {
	const { startISO, endISO } = parseDateRange("until 3 August 2026", REF);
	assert.equal(startISO, null);
	assert.equal(endISO, "2026-08-03T00:00:00+10:00");
});

test("range with day+month on both sides", () => {
	const { startISO, endISO } = parseDateRange("21 Jul 2026 - 26 Jul 2026", REF);
	assert.equal(startISO, "2026-07-21T00:00:00+10:00");
	assert.equal(endISO, "2026-07-26T00:00:00+10:00");
});
