import assert from "node:assert/strict";
import { test } from "node:test";
import { toISODate } from "@dothingslol/core/shared";
import { isValidTimeZone } from "./config/city.js";
import { fmtDate, getWeekRange } from "./config/week.js";
import { isDuplicateEvent } from "./dedupe.js";

const BNE = "Australia/Brisbane";
const SYD = "Australia/Sydney";

test("getWeekRange: Sunday belongs to the coming week, every other day to the current one", () => {
	// The digest runs Sunday morning for the week starting tomorrow; the cron
	// schedule depends on this branch.
	const sunday = getWeekRange(new Date("2026-09-13T09:30:00+10:00"), BNE);
	assert.equal(toISODate(sunday.monday, BNE), "2026-09-14");
	assert.equal(toISODate(sunday.sunday, BNE), "2026-09-20");

	const monday = getWeekRange(new Date("2026-09-14T09:30:00+10:00"), BNE);
	assert.equal(toISODate(monday.monday, BNE), "2026-09-14");

	const saturday = getWeekRange(new Date("2026-09-12T09:30:00+10:00"), BNE);
	assert.equal(toISODate(saturday.monday, BNE), "2026-09-07");
	assert.equal(toISODate(saturday.sunday, BNE), "2026-09-13");
});

test("getWeekRange: the weekly cron instant is Sunday in the city, not on the UTC runner", () => {
	// weekly.yml fires at 20:00 UTC Saturday, which is Sunday 06:00 in Brisbane
	// and Sunday 07:00 in Sydney once DST starts.
	const cron = new Date("2026-10-10T20:00:00Z");
	for (const tz of [BNE, SYD]) {
		const { monday, sunday } = getWeekRange(cron, tz);
		assert.equal(toISODate(monday, tz), "2026-10-12", tz);
		assert.equal(toISODate(sunday, tz), "2026-10-18", tz);
	}
	// The week's bounds are that city's midnights.
	assert.equal(
		getWeekRange(cron, BNE).monday.toISOString(),
		"2026-10-11T14:00:00.000Z",
	);
	assert.equal(
		getWeekRange(cron, SYD).monday.toISOString(),
		"2026-10-11T13:00:00.000Z",
	);
});

test("fmtDate and toISODate read the date in the given zone", () => {
	// 13:30Z on 10 Oct is 23:30 in Brisbane but already 00:30 on 11 Oct in
	// Sydney (AEDT).
	const at = new Date("2026-10-10T13:30:00Z");
	assert.equal(toISODate(at, BNE), "2026-10-10");
	assert.equal(toISODate(at, SYD), "2026-10-11");
	assert.equal(fmtDate(at, BNE), "10 October 2026");
	assert.equal(fmtDate(at, SYD), "11 October 2026");
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
