import assert from "node:assert/strict";
import { test } from "node:test";
import { isDuplicateEvent } from "../common.ts";
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
		// Same instant, now emitted in the one consistent Brisbane-offset form
		// rather than sometimes a UTC Z string (09:00Z == 19:00+10:00).
		"2026-06-14T19:00:00+10:00",
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

test("an open-ended run still on gets today as its start", () => {
	// Policy change, made deliberately. This used to assert start === null on
	// the "prefer null over a guess" rule, but a null start reads as undated
	// downstream and the event is dropped — five real exhibitions were lost
	// that way. "Until 3 August" is not an unknown start: it says the run is on
	// NOW and closes then, which is the same inference ON_NOW already makes for
	// "ongoing" and "open daily".
	const { startISO, endISO } = parseDateRange("until 3 August 2026", REF);
	assert.equal(startISO, "2026-06-01T00:00:00+10:00"); // REF's own date
	assert.equal(endISO, "2026-08-03T00:00:00+10:00");
});

test("an open-ended run that already closed keeps a null start", () => {
	// The guess is only justified while the run is actually on. A past end is
	// an archive listing, and inventing a start for it would resurrect it.
	assert.equal(parseDateRange("until 1 January 2020", REF).startISO, null);
});

test("range with day+month on both sides", () => {
	const { startISO, endISO } = parseDateRange("21 Jul 2026 - 26 Jul 2026", REF);
	assert.equal(startISO, "2026-07-21T00:00:00+10:00");
	assert.equal(endISO, "2026-07-26T00:00:00+10:00");
});

test("a day that does not exist in its month is refused, not approximated", () => {
	// These used to come back as well-formed-looking ISO strings
	// ("2026-02-31T00:00:00+10:00") which passed downstream string date
	// comparisons and then failed to parse in production.
	assert.equal(parseSingleDateTime("31/02/2026", REF), null);
	assert.equal(parseSingleDateTime("45 September 2026", REF), null);
	assert.equal(parseSingleDateTime("Feb 30, 2026", REF), null);
	// a real leap day still parses
	assert.equal(
		parseSingleDateTime("29 February 2028", REF),
		"2028-02-29T00:00:00+10:00",
	);
});

test("a time range resolves to the start time, not the end", () => {
	assert.equal(
		parseSingleDateTime("Tue 21 Jul 2026, 6-10pm", REF),
		"2026-07-21T18:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("21 Jul 2026, 6:30-10pm", REF),
		"2026-07-21T18:30:00+10:00",
	);
	// an explicit meridiem on each side is respected
	assert.equal(
		parseSingleDateTime("21 Jul 2026, 11am-1pm", REF),
		"2026-07-21T11:00:00+10:00",
	);
	// start hour greater than end hour means the start is am
	assert.equal(
		parseSingleDateTime("21 Jul 2026, 11-1pm", REF),
		"2026-07-21T11:00:00+10:00",
	);
});

test("an undated event never matches a dated one", () => {
	// A stray heading extracted as an event used to swallow every event whose
	// title it prefixed, on any date.
	assert.equal(
		isDuplicateEvent(
			{ title: "live music", date: "" },
			{ title: "live music at the triffid", date: "2026-09-03" },
		),
		false,
	);
	assert.equal(
		isDuplicateEvent(
			{ title: "live music", date: "2026-09-03" },
			{ title: "live music at the triffid", date: "2026-09-03" },
		),
		true,
	);
});

test("relative phrasing from real gig guides resolves against the reference date", () => {
	// REF is 1 June 2026 (a Monday). These are the phrases that carried the
	// in-window events and used to be dropped as "no date": musick's guide
	// alone lost 65 of 76 candidates this way.
	assert.equal(
		parseSingleDateTime("Tonight", REF),
		"2026-06-01T00:00:00+10:00",
	);
	assert.equal(parseSingleDateTime("Today", REF), "2026-06-01T00:00:00+10:00");
	assert.equal(
		parseSingleDateTime("Tomorrow", REF),
		"2026-06-02T00:00:00+10:00",
	);
	// "on now" means it is running today
	assert.equal(parseSingleDateTime("ON NOW", REF), "2026-06-01T00:00:00+10:00");
	assert.equal(
		parseSingleDateTime("Ongoing", REF),
		"2026-06-01T00:00:00+10:00",
	);
	// weekday-relative, and weekday + day with no month (musick's format)
	assert.equal(
		parseSingleDateTime("This Saturday", REF),
		"2026-06-06T00:00:00+10:00",
	);
	assert.equal(parseSingleDateTime("Wed 3", REF)?.slice(0, 10), "2026-06-03");
});

test("recurrence and vague periods stay null rather than becoming a date", () => {
	// chrono resolves several of these to a concrete day; publishing that would
	// put a wrong date on the site, so they are refused before it sees them.
	for (const raw of [
		"every Tuesday",
		"Every Tues",
		"weekly",
		"monthly",
		"various dates",
		"multiple dates",
		"Spring 2026",
		"date TBC",
	]) {
		assert.equal(
			parseSingleDateTime(raw, REF),
			null,
			`${raw} should not parse`,
		);
	}
});

test("a month-first date with a weekday keeps its real date and time", () => {
	// The defect this fixes: en.GB is day-first and will not read "Sep 16", so
	// it matched only the weekday and resolved "Wed, Sep 16 7:00 PM" to the NEXT
	// Wednesday — 9 Sep — with the time discarded. Creative Mornings publishes
	// every listing in this shape, so all four of its events were on wrong days.
	const ref = new Date("2026-09-03T09:00:00+10:00");
	assert.equal(
		parseSingleDateTime("Wed, Sep 16 7:00 PM", ref),
		"2026-09-16T19:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Tue, Sep 08 2:00 PM", ref),
		"2026-09-08T14:00:00+10:00",
	);
	// Same date without the weekday, and with a comma — both had to work too.
	assert.equal(
		parseSingleDateTime("Sep 16 7:00 PM", ref),
		"2026-09-16T19:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Wed, Sep 16, 7:00 PM", ref),
		"2026-09-16T19:00:00+10:00",
	);
});

test("numeric dates stay day-first", () => {
	// The whole reason en.GB is the primary locale. The month-first retry is
	// gated on a month NAME precisely so this cannot regress: 03/04 is 3 April
	// in Australia, and the US locale would read it as 4 March.
	const ref = new Date("2026-01-01T09:00:00+10:00");
	assert.equal(
		parseSingleDateTime("03/04/2026", ref),
		"2026-04-03T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("12/01/2026", ref),
		"2026-01-12T00:00:00+10:00",
	);
});

test("a weekday is not trusted when the text states a calendar date", () => {
	// "Prefer null over a guess": if both locales fail on a string that plainly
	// names a month and a day, the weekday must not be used to invent one.
	const ref = new Date("2026-09-03T09:00:00+10:00");
	assert.equal(parseSingleDateTime("Wed, Sep 45 7:00 PM", ref), null);
	// A weekday with no calendar date in sight is still fine.
	assert.equal(
		parseSingleDateTime("This Saturday", ref),
		"2026-09-05T00:00:00+10:00",
	);
	// "Wed 2" is covered by the weekday-and-day test below, which reads the 2
	// as the day of the month rather than discarding it.
});

test("a weekday followed by a day-of-month reads the number as the day", () => {
	// The commonest shape in the corpus, and chrono cannot read it: it ignored
	// the number ("Wed 2" became the NEXT Wednesday) or took it for a time
	// ("Thu 10" became today at 10:00). Both are the wrong day. 32 candidates
	// carried nothing but this.
	const ref = new Date("2026-09-03T09:00:00+10:00"); // Thursday 3 Sep 2026
	assert.equal(parseSingleDateTime("Thu 3", ref), "2026-09-03T00:00:00+10:00");
	assert.equal(parseSingleDateTime("Thu 10", ref), "2026-09-10T00:00:00+10:00");
	// A day already gone this month means next month's.
	assert.equal(parseSingleDateTime("Wed 2", ref), "2026-10-02T00:00:00+10:00");
	// A trailing time still applies to that day.
	assert.equal(
		parseSingleDateTime("Sat 12 7:30pm", ref),
		"2026-09-12T19:30:00+10:00",
	);
	// Every weekday abbreviation has to work, not just the ones with four
	// letters — "thurs?" used to require "thur" and lost every "Thu".
	for (const [text, want] of [
		["Mon 7", "2026-09-07"],
		["Tue 8", "2026-09-08"],
		["Wed 9", "2026-09-09"],
		["Thu 3", "2026-09-03"],
		["Fri 4", "2026-09-04"],
		["Sat 5", "2026-09-05"],
		["Sun 6", "2026-09-06"],
	] as const) {
		assert.equal(parseSingleDateTime(text, ref)?.slice(0, 10), want, text);
	}
});

test("an open-ended run that is still on starts today", () => {
	// "Until 6 Sep" is on NOW and closes then, so a null start read as undated
	// and dropped the event — five real exhibitions lost.
	const ref = new Date("2026-09-03T09:00:00+10:00");
	assert.deepEqual(parseDateRange("Until 6 Sep 2026", ref), {
		startISO: "2026-09-03T00:00:00+10:00",
		endISO: "2026-09-06T00:00:00+10:00",
	});
	// An end already past is an archive listing, so it stays start-less.
	assert.equal(parseDateRange("Until 1 Jan 2020", ref).startISO, null);
});
