import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import {
	appleCalendarUrl,
	calendarLinks,
	googleCalendarUrl,
	outlookCalendarUrl,
} from "./calendarLinks";

function ev(partial: Partial<Event>): Event {
	return {
		title: "Lebanon Hanover",
		datetime: "Thu 17 Sep, 7:00 PM",
		location: "The Triffid, Newstead",
		link: "https://thetriffid.com.au/lebanon-hanover",
		category: "Concert / Music",
		cost: "$60",
		source: "The Triffid",
		description: "Cold wave.",
		tags: [],
		score: 8,
		datetime_iso: "2026-09-17T19:00:00",
		datetime_end_iso: "",
		image: "",
		...partial,
	};
}

/** The whole point of these tests. The pipeline's strings are naive Brisbane
 * wall-clock, and running them through `new Date(naive).toISOString()` shifts
 * every timed event by ten hours on an Australian machine — the bug ics.ts
 * documents at length. A stamp that still reads 190000 proves no conversion
 * happened. */
test("a timed event keeps its wall-clock time, unconverted", () => {
	const url = googleCalendarUrl(ev({}), "brisbane") ?? "";
	const dates = new URL(url).searchParams.get("dates");
	assert.equal(dates, "20260917T190000/20260917T210000");
	// Google is told the zone separately rather than in the stamp.
	assert.equal(new URL(url).searchParams.get("ctz"), "Australia/Brisbane");
});

test("no end means two hours, and a late start does not roll past midnight", () => {
	const late =
		googleCalendarUrl(
			ev({ datetime_iso: "2026-09-17T23:00:00" }),
			"brisbane",
		) ?? "";
	// 23:00 + 2h would be "25:00", which no calendar accepts. Ending a minute
	// before midnight is wrong by a minute and right by a day.
	assert.equal(
		new URL(late).searchParams.get("dates"),
		"20260917T230000/20260917T235900",
	);
});

test("a date-only event is all-day, and its end is exclusive", () => {
	const url =
		googleCalendarUrl(
			ev({ datetime_iso: "2026-09-20", datetime_end_iso: "" }),
			"brisbane",
		) ?? "";
	// DTEND is exclusive everywhere in calendaring, so a one-day event ends on
	// the following day or it renders as zero-length.
	assert.equal(new URL(url).searchParams.get("dates"), "20260920/20260921");
});

test("Outlook carries the offset inline, since it has no ctz", () => {
	const url = outlookCalendarUrl(ev({}), "brisbane") ?? "";
	const params = new URL(url).searchParams;
	assert.equal(params.get("startdt"), "2026-09-17T19:00:00+10:00");
	assert.equal(params.get("enddt"), "2026-09-17T21:00:00+10:00");
});

test("the Apple route is a real .ics URL, not a blob", () => {
	// Only a real URL gets handed to Calendar by iOS Safari without a download
	// step, which is the entire reason the pipeline writes these as files.
	// Root-relative, so it resolves against whatever host is serving the page —
	// an absolute SITE_URL sent every local click to production.
	const url = appleCalendarUrl(ev({}), "brisbane") ?? "";
	assert.match(url, /^\/brisbane\/e\/[a-z0-9-]+\.ics$/);
});

test("an event with no usable date offers no calendar route at all", () => {
	const undated = ev({ datetime_iso: "", datetime_end_iso: "" });
	assert.equal(googleCalendarUrl(undated, "brisbane"), null);
	assert.equal(outlookCalendarUrl(undated, "brisbane"), null);
	assert.equal(appleCalendarUrl(undated, "brisbane"), null);
	// Only the download row survives, which is how callers detect "nothing to
	// offer" and hide the button.
	assert.deepEqual(
		calendarLinks(undated, "brisbane").map((l) => l.key),
		["download"],
	);
});

test("every route is offered for a normal event", () => {
	assert.deepEqual(
		calendarLinks(ev({}), "brisbane").map((l) => l.key),
		["google", "apple", "outlook", "download"],
	);
});
