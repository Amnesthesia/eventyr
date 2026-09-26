import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addDays,
	formatOffset,
	zonedDate,
	zonedOffsetMinutes,
	zonedTimeToInstant,
} from "./tz.ts";

const BNE = "Australia/Brisbane";
const SYD = "Australia/Sydney";
const at = (iso: string) => new Date(iso);

test("zonedOffsetMinutes: Brisbane is +10:00 all year", () => {
	for (const iso of [
		"2026-01-15T00:00:00Z",
		"2026-04-05T12:00:00Z",
		"2026-07-01T00:00:00Z",
		"2026-10-05T12:00:00Z",
		"2026-12-31T23:59:59Z",
	]) {
		assert.equal(zonedOffsetMinutes(BNE, at(iso)), 600, iso);
	}
});

test("zonedOffsetMinutes: Sydney is +10:00 before DST and +11:00 during it", () => {
	assert.equal(zonedOffsetMinutes(SYD, at("2026-10-03T00:00:00Z")), 600);
	assert.equal(zonedOffsetMinutes(SYD, at("2026-10-05T00:00:00Z")), 660);
});

test("zonedOffsetMinutes: Sydney changes offset exactly at the transitions", () => {
	// DST starts 2026-10-04 02:00 AEST = 2026-10-03T16:00Z, and ends
	// 2027-04-04 03:00 AEDT = 2027-04-03T16:00Z.
	assert.equal(zonedOffsetMinutes(SYD, at("2026-10-03T15:59:59Z")), 600);
	assert.equal(zonedOffsetMinutes(SYD, at("2026-10-03T16:00:00Z")), 660);
	assert.equal(zonedOffsetMinutes(SYD, at("2027-04-03T15:59:59Z")), 660);
	assert.equal(zonedOffsetMinutes(SYD, at("2027-04-03T16:00:00Z")), 600);
});

test("zonedDate: the calendar date either side of local midnight", () => {
	// Brisbane midnight is 14:00Z the day before.
	assert.equal(zonedDate(BNE, at("2026-09-20T13:59:59Z")), "2026-09-20");
	assert.equal(zonedDate(BNE, at("2026-09-20T14:00:00Z")), "2026-09-21");
	// Sydney in DST: midnight is 13:00Z the day before.
	assert.equal(zonedDate(SYD, at("2026-10-10T12:59:59Z")), "2026-10-10");
	assert.equal(zonedDate(SYD, at("2026-10-10T13:00:00Z")), "2026-10-11");
	// And back on standard time, 14:00Z again.
	assert.equal(zonedDate(SYD, at("2027-04-10T13:59:59Z")), "2027-04-10");
	assert.equal(zonedDate(SYD, at("2027-04-10T14:00:00Z")), "2027-04-11");
	assert.equal(
		zonedDate("America/Los_Angeles", at("2026-09-21T06:59:59Z")),
		"2026-09-20",
	);
});

test("zonedTimeToInstant: inverts the wall clock, DST included", () => {
	const wall = Date.UTC(2026, 9, 10, 19, 30);
	assert.equal(
		zonedTimeToInstant(BNE, wall)?.toISOString(),
		"2026-10-10T09:30:00.000Z",
	);
	assert.equal(
		zonedTimeToInstant(SYD, wall)?.toISOString(),
		"2026-10-10T08:30:00.000Z",
	);
});

test("zonedTimeToInstant: the skipped hour does not exist", () => {
	// 02:00–02:59 on 2026-10-04 never happens in Sydney.
	assert.equal(zonedTimeToInstant(SYD, Date.UTC(2026, 9, 4, 2, 30)), null);
	assert.equal(
		zonedTimeToInstant(SYD, Date.UTC(2026, 9, 4, 3, 0))?.toISOString(),
		"2026-10-03T16:00:00.000Z",
	);
});

test("zonedTimeToInstant: the repeated hour resolves to its first occurrence", () => {
	// 02:30 on 2027-04-04 happens at +11:00 and again at +10:00; the first is
	// 15:30Z.
	assert.equal(
		zonedTimeToInstant(SYD, Date.UTC(2027, 3, 4, 2, 30))?.toISOString(),
		"2027-04-03T15:30:00.000Z",
	);
});

test("formatOffset and addDays", () => {
	assert.equal(formatOffset(600), "+10:00");
	assert.equal(formatOffset(660), "+11:00");
	assert.equal(formatOffset(-420), "-07:00");
	assert.equal(formatOffset(330), "+05:30");
	assert.equal(addDays("2026-09-27", 7), "2026-10-04");
	assert.equal(addDays("2027-04-04", 7), "2027-04-11");
	assert.equal(addDays("2026-12-31", 1), "2027-01-01");
	assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});
