import assert from "node:assert/strict";
import { test } from "node:test";
import { sortForWindow } from "./events.ts";

const ev = (id: string, start: string) => ({ id, start });

const titles = (events: { id: string }[]) => events.map((e) => e.id);

test("events starting in the window sort above ones merely running through it", () => {
	const events = [
		ev("exhibition-2023", "2023-09-20T10:00:00+10:00"),
		ev("gig-tonight", "2026-09-17T19:30:00+10:00"),
		ev("exhibition-2025", "2025-06-21T10:00:00+10:00"),
		ev("talk-this-morning", "2026-09-17T09:00:00+10:00"),
	];
	assert.deepEqual(titles(sortForWindow(events, "2026-09-17", "2026-09-17")), [
		"talk-this-morning",
		"gig-tonight",
		"exhibition-2023",
		"exhibition-2025",
	]);
});

test("ties within the window break by start time", () => {
	const events = [
		ev("late", "2026-09-17T21:00:00+10:00"),
		ev("early", "2026-09-17T08:00:00+10:00"),
		ev("mid", "2026-09-17T14:00:00+10:00"),
	];
	assert.deepEqual(titles(sortForWindow(events, "2026-09-17", "2026-09-17")), [
		"early",
		"mid",
		"late",
	]);
});

test("a weekend window covers both of its days", () => {
	const events = [
		ev("ongoing", "2025-01-01T10:00:00+10:00"),
		ev("sunday", "2026-09-20T11:00:00+10:00"),
		ev("saturday", "2026-09-19T18:00:00+10:00"),
	];
	assert.deepEqual(titles(sortForWindow(events, "2026-09-19", "2026-09-20")), [
		"saturday",
		"sunday",
		"ongoing",
	]);
});

test("an event starting after the window still sorts below ones inside it", () => {
	const events = [
		ev("next-month", "2026-10-30T19:00:00+10:00"),
		ev("in-window", "2026-09-17T19:00:00+10:00"),
	];
	assert.deepEqual(titles(sortForWindow(events, "2026-09-17", "2026-09-17")), [
		"in-window",
		"next-month",
	]);
});

test("the input array is not mutated", () => {
	const events = [
		ev("b", "2026-09-17T20:00:00+10:00"),
		ev("a", "2026-09-17T08:00:00+10:00"),
	];
	sortForWindow(events, "2026-09-17", "2026-09-17");
	assert.deepEqual(titles(events), ["b", "a"]);
});
