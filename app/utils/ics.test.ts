import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import { buildEventIcs, icsFilename } from "./ics";

function ev(partial: Partial<Event>): Event {
	return {
		title: "Test Event",
		datetime: "",
		location: "The Triffid, Newstead",
		link: "",
		category: "Concert / Music",
		cost: "",
		source: "The Triffid",
		description: "",
		tags: [],
		score: 8,
		datetime_iso: "2026-09-05T19:30:00",
		datetime_end_iso: "",
		image: "",
		...partial,
	};
}

function lines(ics: string): string[] {
	return ics.split("\r\n");
}

test("a timed event is written as local wall-clock under a TZID", () => {
	// The bug this guards: `new Date(naive).toISOString()` parses as the HOST's
	// local time and writes back UTC, so on an Australia/Brisbane machine every
	// timed event came out ten hours early — a 7:30pm gig published as 9:30am —
	// while CI happened to be correct. 193000 must appear verbatim.
	const ics = buildEventIcs(ev({}), "brisbane") as string;
	assert.ok(
		lines(ics).includes("DTSTART;TZID=Australia/Brisbane:20260905T193000"),
		ics,
	);
	// Two hours when the source gave no end, so the entry has a duration.
	assert.ok(
		lines(ics).includes("DTEND;TZID=Australia/Brisbane:20260905T213000"),
		ics,
	);
	// And no Z-suffixed UTC stamp anywhere, which is what a conversion looks like.
	assert.ok(!/DTSTART[^\r\n]*Z\r\n/.test(ics), "no UTC conversion");
});

test("an explicit end is used as given", () => {
	const ics = buildEventIcs(
		ev({ datetime_end_iso: "2026-09-05T23:00:00" }),
		"brisbane",
	) as string;
	assert.ok(
		lines(ics).includes("DTEND;TZID=Australia/Brisbane:20260905T230000"),
	);
});

test("a date with no time is an all-day event, with an exclusive DTEND", () => {
	// DTEND == DTSTART renders as zero-length and some clients drop the event
	// entirely, so a one-day event has to end the following day.
	const ics = buildEventIcs(
		ev({ datetime_iso: "2026-09-05", datetime_end_iso: "" }),
		"brisbane",
	) as string;
	assert.ok(lines(ics).includes("DTSTART;VALUE=DATE:20260905"), ics);
	assert.ok(lines(ics).includes("DTEND;VALUE=DATE:20260906"), ics);
});

test("a multi-day all-day event ends the day after its last day", () => {
	const ics = buildEventIcs(
		ev({ datetime_iso: "2026-09-05", datetime_end_iso: "2026-09-07" }),
		"brisbane",
	) as string;
	assert.ok(lines(ics).includes("DTEND;VALUE=DATE:20260908"), ics);
});

test("an undated event produces nothing rather than a broken file", () => {
	assert.equal(buildEventIcs(ev({ datetime_iso: "" }), "brisbane"), null);
	assert.equal(
		buildEventIcs(ev({ datetime_iso: "every Tuesday" }), "brisbane"),
		null,
	);
});

test("the UID matches the city feed's, so adding one event never duplicates it", () => {
	const event = ev({
		title: "Dice Rolls & Flagons – Casual Board Game Meetup",
		datetime_iso: "2026-09-06T14:00:00",
		location: "Netherworld, Fortitude Valley",
	});
	const ics = buildEventIcs(event, "brisbane") as string;
	// Same value src/ical.ts writes — see src/shared.test.ts, which pins it.
	assert.ok(lines(ics).includes("UID:brisbane-b8wguc"), ics);
});

test("TEXT values are escaped", () => {
	const ics = buildEventIcs(
		ev({
			title: "Wine; Cheese, and Chat",
			description: "Line one\nLine two",
			location: "A, B; C",
		}),
		"brisbane",
	) as string;
	assert.ok(ics.includes("SUMMARY:Wine\\; Cheese\\, and Chat"), ics);
	assert.ok(ics.includes("LOCATION:A\\, B\\; C"), ics);
	assert.ok(ics.includes("Line one\\nLine two"), ics);
});

test("long lines are folded to 75 octets with a leading space", () => {
	const ics = buildEventIcs(
		ev({ title: "x".repeat(200) }),
		"brisbane",
	) as string;
	for (const line of lines(ics)) {
		assert.ok(line.length <= 75, `${line.length}: ${line.slice(0, 40)}…`);
	}
	// A folded continuation is only valid if it starts with whitespace.
	const folded = lines(ics).filter((l) => l.startsWith(" "));
	assert.ok(folded.length > 0, "expected continuation lines");
});

test("the calendar is well-formed and CRLF-terminated", () => {
	const ics = buildEventIcs(ev({}), "brisbane") as string;
	assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
	assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
	assert.equal(lines(ics).filter((l) => l === "BEGIN:VEVENT").length, 1);
	assert.equal(lines(ics).filter((l) => l === "END:VEVENT").length, 1);
});

test("the filename says which event it is", () => {
	assert.equal(
		icsFilename(ev({ title: "Dice Rolls & Flagons" })),
		"dice-rolls-flagons.ics",
	);
	assert.equal(icsFilename(ev({ title: "" })), "event.ics");
	assert.ok(icsFilename(ev({ title: "y".repeat(200) })).length <= 54);
});
