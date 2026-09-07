import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import { offsetPercent, startMinutes, weekLayout } from "./weekLayout";

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

const MONDAY = "2026-09-07";

test("a timed event lands on its own day, in start order", () => {
	const layout = weekLayout(
		[
			ev({ title: "evening", datetime_iso: "2026-09-09T19:30:00" }),
			ev({ title: "morning", datetime_iso: "2026-09-09T09:00:00" }),
			ev({ title: "other day", datetime_iso: "2026-09-11T12:00:00" }),
		],
		MONDAY,
	);
	const wednesday = layout.lanes[2];
	assert.equal(wednesday.day, "2026-09-09");
	assert.deepEqual(
		wednesday.timed.map((t) => t.event.title),
		["morning", "evening"],
	);
	assert.equal(layout.lanes[4].timed.length, 1);
});

test("a multi-day run is ONE bar spanning the days it covers", () => {
	// An exhibition running Tue–Thu is a single bar over three columns, not
	// three identical chips and not a slot at an invented hour. Repeating it
	// per day filled the strip and pushed the grid off screen.
	const layout = weekLayout(
		[
			ev({
				title: "exhibition",
				datetime_iso: "2026-09-08",
				datetime_end_iso: "2026-09-10",
			}),
		],
		MONDAY,
	);
	assert.equal(layout.allDayBars.length, 1);
	// Column 1 is the time gutter, so Tuesday is column 3 and the end line is
	// one past Thursday.
	assert.equal(layout.allDayBars[0].startCol, 3);
	assert.equal(layout.allDayBars[0].endCol, 6);
	assert.deepEqual(
		layout.lanes.map((l) => l.timed.length),
		[0, 0, 0, 0, 0, 0, 0],
	);
});

test("a run that opened before this week starts at the first column", () => {
	// An exhibition that opened in May has no start column in this week; the
	// bar touches the left edge instead, which is what "already running" looks
	// like on a calendar.
	const layout = weekLayout(
		[ev({ datetime_iso: "2026-05-02", datetime_end_iso: "2026-12-05" })],
		MONDAY,
	);
	assert.equal(layout.allDayBars[0].startCol, 2);
	assert.equal(layout.allDayBars[0].endCol, 9);
});

test("a run with a start TIME is still a bar, not a slot on its opening day", () => {
	// The bug this fixes: "14 Feb, 10:00 AM" closing in January was blocked out
	// as a two-hour slot on 14 February, so it vanished from every other week —
	// and dragged the calendar's opening week back to February with it.
	const layout = weekLayout(
		[
			ev({
				title: "German Expressionism",
				datetime_iso: "2026-02-14T10:00:00",
				datetime_end_iso: "2028-01-16",
			}),
		],
		MONDAY,
	);
	assert.equal(layout.allDayBars.length, 1);
	assert.deepEqual(
		layout.lanes.map((l) => l.timed.length),
		[0, 0, 0, 0, 0, 0, 0],
	);
});

test("overlapping runs stack into separate rows", () => {
	const layout = weekLayout(
		[
			ev({
				title: "a",
				datetime_iso: "2026-09-07",
				datetime_end_iso: "2026-09-09",
			}),
			ev({
				title: "b",
				datetime_iso: "2026-09-08",
				datetime_end_iso: "2026-09-10",
			}),
			// Starts after "a" ends, so it can reuse the first row.
			ev({
				title: "c",
				datetime_iso: "2026-09-11",
				datetime_end_iso: "2026-09-12",
			}),
		],
		MONDAY,
	);
	assert.deepEqual(
		layout.allDayBars.map((b) => [b.event.title, b.lane]),
		[
			["a", 1],
			["b", 2],
			["c", 1],
		],
	);
	assert.equal(layout.allDayLanes, 2);
});

test("the hour range widens for anything outside the default lane", () => {
	const early = weekLayout(
		[ev({ datetime_iso: "2026-09-09T06:15:00" })],
		MONDAY,
	);
	assert.equal(early.firstHour, 6);
	const late = weekLayout(
		[ev({ datetime_iso: "2026-09-09T23:30:00" })],
		MONDAY,
	);
	// 23:30 needs the row through midnight, and 24 is the ceiling.
	assert.equal(late.lastHour, 24);
});

test("a week with nothing in it still has a usable default range", () => {
	// Math.min/max over an empty spread returns Infinity — a grid built from
	// that renders nothing at all.
	const layout = weekLayout([], MONDAY);
	assert.equal(layout.firstHour, 8);
	assert.equal(layout.lastHour, 23);
	assert.equal(layout.days.length, 7);
});

test("the offset puts a start where the hour labels say it is", () => {
	// 12:00 in an 08:00–20:00 grid is exactly a third of the way down.
	assert.equal(Math.round(offsetPercent(12 * 60, 8, 20)), 33);
	assert.equal(offsetPercent(8 * 60, 8, 20), 0);
	assert.equal(offsetPercent(20 * 60, 8, 20), 100);
});

test("a naive wall-clock string is read, never parsed as a Date", () => {
	// Constructing a Date from a naive string applies the VIEWER's timezone to
	// a value already local to the city — a Londoner would see every Brisbane
	// gig on the wrong row.
	assert.equal(startMinutes(ev({ datetime_iso: "2026-09-09T19:30:00" })), 1170);
	assert.equal(startMinutes(ev({ datetime_iso: "2026-09-09" })), null);
	assert.equal(startMinutes(ev({ datetime_iso: "" })), null);
});
