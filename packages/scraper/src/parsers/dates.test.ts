import assert from "node:assert/strict";
import { test } from "node:test";
import {
	countDateHits,
	DST_GAP,
	parseDateRange,
	parseSingleDateTime,
} from "./dates.ts";

const REF = new Date("2026-06-01T00:00:00+10:00");
const BNE = "Australia/Brisbane";

test("ISO date-only string is treated as Brisbane local midnight", () => {
	assert.equal(
		parseSingleDateTime("2026-06-14", REF, BNE),
		"2026-06-14T00:00:00+10:00",
	);
});

test("ISO datetime with explicit offset is trusted as-is", () => {
	assert.equal(
		parseSingleDateTime("2026-06-14T09:00:00Z", REF, BNE),
		// Same instant, now emitted in the one consistent Brisbane-offset form
		// rather than sometimes a UTC Z string (09:00Z == 19:00+10:00).
		"2026-06-14T19:00:00+10:00",
	);
});

test("ISO datetime without offset is treated as Brisbane local time", () => {
	assert.equal(
		parseSingleDateTime("2026-06-14T19:00:00", REF, BNE),
		"2026-06-14T19:00:00+10:00",
	);
});

test("day-month-year with time, day-first", () => {
	assert.equal(
		parseSingleDateTime("14 June 2026, 7:00 PM", REF, BNE),
		"2026-06-14T19:00:00+10:00",
	);
});

test("slash date is parsed day-first, not month-first", () => {
	// 03/04 must be 3 April, never 4 March.
	assert.equal(
		parseSingleDateTime("03/04/2026", REF, BNE),
		"2026-04-03T00:00:00+10:00",
	);
});

test("omitted year uses the reference year", () => {
	assert.equal(
		parseSingleDateTime("14 June", REF, BNE),
		"2026-06-14T00:00:00+10:00",
	);
});

test("omitted year rolls to next year when far in the past relative to reference", () => {
	// Reference is 1 June 2026; "3 January" with no year should resolve to 2027.
	assert.equal(
		parseSingleDateTime("3 January", REF, BNE),
		"2027-01-03T00:00:00+10:00",
	);
});

test("unparseable date returns null rather than guessing", () => {
	assert.equal(parseSingleDateTime("Spring 2026", REF, BNE), null);
	assert.equal(parseSingleDateTime("every Tuesday", REF, BNE), null);
	assert.equal(parseSingleDateTime("", REF, BNE), null);
});

test("date range within one string with shared month/year on the left", () => {
	const { startISO, endISO } = parseDateRange(
		"5 – 19 September 2026",
		REF,
		BNE,
	);
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
	const { startISO, endISO } = parseDateRange("until 3 August 2026", REF, BNE);
	assert.equal(startISO, "2026-06-01T00:00:00+10:00"); // REF's own date
	assert.equal(endISO, "2026-08-03T00:00:00+10:00");
});

test("an open-ended run that already closed keeps a null start", () => {
	// The guess is only justified while the run is actually on. A past end is
	// an archive listing, and inventing a start for it would resurrect it.
	assert.equal(parseDateRange("until 1 January 2020", REF, BNE).startISO, null);
});

test("range with day+month on both sides", () => {
	const { startISO, endISO } = parseDateRange(
		"21 Jul 2026 - 26 Jul 2026",
		REF,
		BNE,
	);
	assert.equal(startISO, "2026-07-21T00:00:00+10:00");
	assert.equal(endISO, "2026-07-26T00:00:00+10:00");
});

test("a day that does not exist in its month is refused, not approximated", () => {
	// These used to come back as well-formed-looking ISO strings
	// ("2026-02-31T00:00:00+10:00") which passed downstream string date
	// comparisons and then failed to parse in production.
	assert.equal(parseSingleDateTime("31/02/2026", REF, BNE), null);
	assert.equal(parseSingleDateTime("45 September 2026", REF, BNE), null);
	assert.equal(parseSingleDateTime("Feb 30, 2026", REF, BNE), null);
	// a real leap day still parses
	assert.equal(
		parseSingleDateTime("29 February 2028", REF, BNE),
		"2028-02-29T00:00:00+10:00",
	);
});

test("a time range resolves to the start time, not the end", () => {
	assert.equal(
		parseSingleDateTime("Tue 21 Jul 2026, 6-10pm", REF, BNE),
		"2026-07-21T18:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("21 Jul 2026, 6:30-10pm", REF, BNE),
		"2026-07-21T18:30:00+10:00",
	);
	// an explicit meridiem on each side is respected
	assert.equal(
		parseSingleDateTime("21 Jul 2026, 11am-1pm", REF, BNE),
		"2026-07-21T11:00:00+10:00",
	);
	// start hour greater than end hour means the start is am
	assert.equal(
		parseSingleDateTime("21 Jul 2026, 11-1pm", REF, BNE),
		"2026-07-21T11:00:00+10:00",
	);
});

test("relative phrasing from real gig guides resolves against the reference date", () => {
	// REF is 1 June 2026 (a Monday). These are the phrases that carried the
	// in-window events and used to be dropped as "no date": musick's guide
	// alone lost 65 of 76 candidates this way.
	assert.equal(
		parseSingleDateTime("Tonight", REF, BNE),
		"2026-06-01T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Today", REF, BNE),
		"2026-06-01T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Tomorrow", REF, BNE),
		"2026-06-02T00:00:00+10:00",
	);
	// "on now" means it is running today
	assert.equal(
		parseSingleDateTime("ON NOW", REF, BNE),
		"2026-06-01T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Ongoing", REF, BNE),
		"2026-06-01T00:00:00+10:00",
	);
	// weekday-relative, and weekday + day with no month (musick's format)
	assert.equal(
		parseSingleDateTime("This Saturday", REF, BNE),
		"2026-06-06T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Wed 3", REF, BNE)?.slice(0, 10),
		"2026-06-03",
	);
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
			parseSingleDateTime(raw, REF, BNE),
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
		parseSingleDateTime("Wed, Sep 16 7:00 PM", ref, BNE),
		"2026-09-16T19:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Tue, Sep 08 2:00 PM", ref, BNE),
		"2026-09-08T14:00:00+10:00",
	);
	// Same date without the weekday, and with a comma — both had to work too.
	assert.equal(
		parseSingleDateTime("Sep 16 7:00 PM", ref, BNE),
		"2026-09-16T19:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Wed, Sep 16, 7:00 PM", ref, BNE),
		"2026-09-16T19:00:00+10:00",
	);
});

test("numeric dates stay day-first", () => {
	// The whole reason en.GB is the primary locale. The month-first retry is
	// gated on a month NAME precisely so this cannot regress: 03/04 is 3 April
	// in Australia, and the US locale would read it as 4 March.
	const ref = new Date("2026-01-01T09:00:00+10:00");
	assert.equal(
		parseSingleDateTime("03/04/2026", ref, BNE),
		"2026-04-03T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("12/01/2026", ref, BNE),
		"2026-01-12T00:00:00+10:00",
	);
});

test("a weekday is not trusted when the text states a calendar date", () => {
	// "Prefer null over a guess": if both locales fail on a string that plainly
	// names a month and a day, the weekday must not be used to invent one.
	const ref = new Date("2026-09-03T09:00:00+10:00");
	assert.equal(parseSingleDateTime("Wed, Sep 45 7:00 PM", ref, BNE), null);
	// A weekday with no calendar date in sight is still fine.
	assert.equal(
		parseSingleDateTime("This Saturday", ref, BNE),
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
	assert.equal(
		parseSingleDateTime("Thu 3", ref, BNE),
		"2026-09-03T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Thu 10", ref, BNE),
		"2026-09-10T00:00:00+10:00",
	);
	// A day already gone this month means next month's.
	assert.equal(
		parseSingleDateTime("Wed 2", ref, BNE),
		"2026-10-02T00:00:00+10:00",
	);
	// A trailing time still applies to that day.
	assert.equal(
		parseSingleDateTime("Sat 12 7:30pm", ref, BNE),
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
		assert.equal(parseSingleDateTime(text, ref, BNE)?.slice(0, 10), want, text);
	}
});

test("an open-ended run that is still on starts today", () => {
	// "Until 6 Sep" is on NOW and closes then, so a null start read as undated
	// and dropped the event — five real exhibitions lost.
	const ref = new Date("2026-09-03T09:00:00+10:00");
	assert.deepEqual(parseDateRange("Until 6 Sep 2026", ref, BNE), {
		startISO: "2026-09-03T00:00:00+10:00",
		endISO: "2026-09-06T00:00:00+10:00",
	});
	// An end already past is an archive listing, so it stays start-less.
	assert.equal(parseDateRange("Until 1 Jan 2020", ref, BNE).startISO, null);
});

test("countDateHits: a real listing excerpt scores well above a dateless footer", () => {
	const listing =
		"Sat 12 Sep, 7:00pm — Jazz Night at The Tivoli. Sun 13 Sep, 3pm — Matinee.";
	const footer =
		"Follow us on Instagram and Facebook. Contact us. Privacy policy. Terms.";
	assert.ok(countDateHits(listing) > 0);
	assert.equal(countDateHits(footer), 0);
});

test("countDateHits: llmExtract skips exactly the batches with zero hits", () => {
	// Mirrors the filter in llmExtract.ts's extractPage: a batch this cheap
	// check rules out never reaches the model.
	const batches = [
		"Sat 12 Sep, 7:00pm — Jazz Night.",
		"Related articles. Share this page. Subscribe to our newsletter.",
		"Mon 14 Sep — Trivia at 8pm.",
	];
	const kept = batches.filter((b) => countDateHits(b) > 0);
	assert.deepEqual(kept, [batches[0], batches[2]]);
});

// --- DST: a city whose offset changes (Byron Bay, Australia/Sydney) ----------

const SYD = "Australia/Sydney";
const SYD_REF = new Date("2026-09-25T09:00:00+10:00");

test("Sydney: times take the offset in force on their own date", () => {
	assert.equal(
		parseSingleDateTime("10 July 2026 7:00 PM", SYD_REF, SYD),
		"2026-07-10T19:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("10 October 2026 7:00 PM", SYD_REF, SYD),
		"2026-10-10T19:00:00+11:00",
	);
	// Weekday-and-day shape, resolved against a pre-DST reference.
	assert.equal(
		parseSingleDateTime("Sat 10 7:30pm", SYD_REF, SYD),
		"2026-10-10T19:30:00+11:00",
	);
});

test("Sydney: an explicit offset or UTC instant is kept, shown in city time", () => {
	assert.equal(
		parseSingleDateTime("2026-10-10T19:00:00+11:00", SYD_REF, SYD),
		"2026-10-10T19:00:00+11:00",
	);
	assert.equal(
		parseSingleDateTime("2026-10-10T08:00:00Z", SYD_REF, SYD),
		"2026-10-10T19:00:00+11:00",
	);
	// The same instant for a Brisbane source is 6pm there.
	assert.equal(
		parseSingleDateTime("2026-10-10T08:00:00Z", SYD_REF, BNE),
		"2026-10-10T18:00:00+10:00",
	);
});

test("Sydney: a date-only value carries the offset at its own midnight", () => {
	// DST starts at 02:00 on 4 Oct, so that midnight is still +10:00.
	assert.equal(
		parseSingleDateTime("4 October 2026", SYD_REF, SYD),
		"2026-10-04T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("5 October 2026", SYD_REF, SYD),
		"2026-10-05T00:00:00+11:00",
	);
});

test("Sydney: the skipped hour is refused with a named rejection", (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	assert.equal(
		parseSingleDateTime("4 October 2026 2:30am", SYD_REF, SYD),
		null,
	);
	assert.deepEqual(parseDateRange("4 October 2026 2:30am", SYD_REF, SYD), {
		startISO: null,
		endISO: null,
	});
	assert.equal(warn.mock.callCount(), 2);
	assert.ok(String(warn.mock.calls[0].arguments[0]).includes(DST_GAP));
	// Either side of the gap is fine.
	assert.equal(
		parseSingleDateTime("4 October 2026 1:30am", SYD_REF, SYD),
		"2026-10-04T01:30:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("4 October 2026 3:00am", SYD_REF, SYD),
		"2026-10-04T03:00:00+11:00",
	);
});

test("Sydney: the repeated hour resolves to its first (daylight) occurrence", () => {
	assert.equal(
		parseSingleDateTime("4 April 2027 2:30am", SYD_REF, SYD),
		"2027-04-04T02:30:00+11:00",
	);
	assert.equal(
		parseSingleDateTime("4 April 2027 3:30am", SYD_REF, SYD),
		"2027-04-04T03:30:00+10:00",
	);
});

test("Sydney: the 11-1pm correction shifts wall-clock time across the DST change", () => {
	// 11pm on 3 Oct to 1pm on 4 Oct spans the 02:00 change; shifting instants
	// rather than clock readings would have landed an hour out.
	assert.deepEqual(parseDateRange("3 Oct 2026, 11-1pm", SYD_REF, SYD), {
		startISO: "2026-10-03T11:00:00+10:00",
		endISO: "2026-10-03T13:00:00+10:00",
	});
});

test("'today' is read in the city's zone, whatever the host's", () => {
	// 09:00 on 3 Sep in Brisbane is still 2 Sep in UTC. On the UTC runner chrono
	// used to push "3 September" to NEXT year here.
	const ref = new Date("2026-09-03T09:00:00+10:00");
	assert.equal(
		parseSingleDateTime("3 September", ref, BNE),
		"2026-09-03T00:00:00+10:00",
	);
	assert.equal(
		parseSingleDateTime("Today", new Date("2026-10-10T23:30:00+11:00"), SYD),
		"2026-10-10T00:00:00+11:00",
	);
});
