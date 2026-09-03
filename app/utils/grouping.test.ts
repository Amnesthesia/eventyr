import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import { startOfWeek } from "./dates";
import { dateLabel, dateWindowFor, groupEvents } from "./grouping";

const WINDOW = { from: "2026-09-03", to: "2026-09-13" };
// Frozen, so the "Today"/"Tomorrow" labels do not depend on the clock.
const TODAY = "2026-09-01";

function ev(partial: Partial<Event>): Event {
	return {
		title: "x",
		datetime: "",
		location: "",
		link: "",
		category: "Community / Other",
		cost: "",
		source: "",
		description: "",
		tags: [],
		score: 5,
		datetime_iso: "",
		datetime_end_iso: "",
		image: "",
		...partial,
	};
}

test("date groups come from the window, not from the events' own dates", () => {
	// The defect this replaced: an exhibition that opened in 2023 created its
	// own one-event group, so a page showing one week had 33 groups outside it.
	const groups = groupEvents(
		[
			ev({
				title: "old run",
				datetime_iso: "2023-09-20",
				datetime_end_iso: "2026-12-01",
			}),
			ev({
				title: "jan run",
				datetime_iso: "2026-01-01",
				datetime_end_iso: "2026-10-01",
			}),
			ev({ title: "thursday", datetime_iso: "2026-09-03T19:00:00" }),
		],
		"date",
		WINDOW,
		TODAY,
	);
	assert.deepEqual(
		groups.map((g) => g.label),
		["Thursday 3 Sep", "Ongoing"],
	);
	// One event, one group — never repeated across every date it covers.
	assert.deepEqual(
		groups[1].events.map((e) => e.title),
		["jan run", "old run"],
	);
});

test("a day with no events gets no heading", () => {
	const groups = groupEvents(
		[
			ev({ datetime_iso: "2026-09-04T10:00:00" }),
			ev({ datetime_iso: "2026-09-12T10:00:00" }),
		],
		"date",
		WINDOW,
		TODAY,
	);
	assert.equal(groups.length, 2);
	assert.deepEqual(
		groups.map((g) => g.key),
		["2026-09-04", "2026-09-12"],
	);
});

test("days are chronological and the exceptions come after them", () => {
	const groups = groupEvents(
		[
			ev({ title: "undated" }),
			ev({ title: "later", datetime_iso: "2026-11-01T10:00:00" }),
			ev({ title: "ongoing", datetime_iso: "2026-02-01" }),
			ev({ title: "day 2", datetime_iso: "2026-09-05T10:00:00" }),
			ev({ title: "day 1", datetime_iso: "2026-09-04T10:00:00" }),
		],
		"date",
		WINDOW,
		TODAY,
	);
	assert.deepEqual(
		groups.map((g) => g.events[0].title),
		["day 1", "day 2", "ongoing", "later", "undated"],
	);
});

test("events inside a group are ordered by start time", () => {
	const groups = groupEvents(
		[
			ev({ title: "evening", datetime_iso: "2026-09-04T19:30:00" }),
			ev({ title: "all day", datetime_iso: "2026-09-04" }),
			ev({ title: "morning", datetime_iso: "2026-09-04T09:00:00" }),
			ev({ title: "afternoon", datetime_iso: "2026-09-04T14:00:00" }),
		],
		"date",
		WINDOW,
		TODAY,
	);
	// A date with no time is an all-day event, so it leads the day.
	assert.deepEqual(
		groups[0].events.map((e) => e.title),
		["all day", "morning", "afternoon", "evening"],
	);
});

test("category groups keep the fixed CATEGORIES order and sort by time", () => {
	const groups = groupEvents(
		[
			ev({
				title: "b",
				category: "Concert / Music",
				datetime_iso: "2026-09-04T20:00:00",
			}),
			ev({
				title: "a",
				category: "Concert / Music",
				datetime_iso: "2026-09-04T18:00:00",
			}),
			ev({
				title: "talk",
				category: "Public Lecture",
				datetime_iso: "2026-09-05T10:00:00",
			}),
		],
		"category",
		WINDOW,
		TODAY,
	);
	assert.deepEqual(
		groups.map((g) => g.label),
		["Public Lecture", "Concert / Music"],
	);
	assert.deepEqual(groups[0].cat, "talks");
	assert.deepEqual(
		groups[1].events.map((e) => e.title),
		["a", "b"],
	);
});

test("ungrouped is one group and keeps the incoming order", () => {
	const events = [
		ev({ title: "second", datetime_iso: "2026-09-09" }),
		ev({ title: "first" }),
	];
	const groups = groupEvents(events, "none", WINDOW, TODAY);
	assert.equal(groups.length, 1);
	assert.deepEqual(
		groups[0].events.map((e) => e.title),
		["second", "first"],
	);
});

test("the window runs from today to the end of next week", () => {
	assert.deepEqual(dateWindowFor("2026-08-31", "2026-09-06", "2026-09-03"), {
		from: "2026-09-03",
		to: "2026-09-13",
	});
	// A build being viewed after its window closed falls back to its own week
	// rather than filing every event under "Later".
	assert.deepEqual(dateWindowFor("2026-08-31", "2026-09-06", "2027-01-01"), {
		from: "2026-08-31",
		to: "2026-09-13",
	});
});

test("dateLabel names the year only when it differs from today's", () => {
	assert.equal(dateLabel("2026-09-12", "2026-09-04"), "Saturday 12 Sep");
	assert.equal(dateLabel("2027-01-16", "2026-09-04"), "Saturday 16 Jan 2027");
	assert.equal(dateLabel("2026-09-04", "2026-09-04"), "Today");
});

test("startOfWeek is the Monday, with Sunday belonging to the week before", () => {
	assert.equal(startOfWeek("2026-09-04"), "2026-08-31"); // a Friday
	assert.equal(startOfWeek("2026-09-06"), "2026-08-31"); // Sunday
	assert.equal(startOfWeek("2026-08-31"), "2026-08-31"); // Monday itself
});
