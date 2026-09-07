import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import {
	calculate1hReminderTime,
	filterEventsForMorningDigest,
	formatEventTime,
	formatMorningDigest,
} from "./notifications";

function makeEvent(partial: Partial<Event>): Event {
	return {
		title: "Test Event",
		datetime: "",
		location: "Brisbane City Hall",
		link: "https://example.com",
		category: "Workshop / Class",
		cost: "Free",
		source: "Test",
		description: "Test description",
		tags: ["writing"],
		score: 8,
		datetime_iso: "",
		datetime_end_iso: "",
		image: "",
		...partial,
	};
}

test("calculate1hReminderTime computes exactly 1 hour before timed event", () => {
	const iso = "2026-09-07T11:00:00";
	const expectedStart = new Date(iso).getTime();
	const reminderTime = calculate1hReminderTime(iso);
	assert.ok(reminderTime !== null);
	assert.equal(reminderTime, expectedStart - 60 * 60 * 1000);
});

test("calculate1hReminderTime handles date-only events by scheduling at 8:00 AM", () => {
	const dateOnly = "2026-09-07";
	const reminderTime = calculate1hReminderTime(dateOnly);
	assert.ok(reminderTime !== null);
	const reminderDate = new Date(reminderTime);
	assert.equal(reminderDate.getFullYear(), 2026);
	assert.equal(reminderDate.getMonth(), 8); // 0-indexed September
	assert.equal(reminderDate.getDate(), 7);
	assert.equal(reminderDate.getHours(), 8);
	assert.equal(reminderDate.getMinutes(), 0);
});

test("calculate1hReminderTime returns null for invalid or missing date", () => {
	assert.equal(calculate1hReminderTime(""), null);
	assert.equal(calculate1hReminderTime("not-a-date"), null);
});

test("formatEventTime formats 12-hour time correctly", () => {
	assert.equal(formatEventTime("2026-09-07T11:00:00"), "11:00 AM");
	assert.equal(formatEventTime("2026-09-07T19:30:00"), "7:30 PM");
	assert.equal(formatEventTime("2026-09-07T00:15:00"), "12:15 AM");
	assert.equal(formatEventTime("2026-09-07"), "Today");
	assert.equal(formatEventTime(""), "Today");
});

test("filterEventsForMorningDigest filters events active today", () => {
	const today = "2026-09-07";
	const events: Event[] = [
		makeEvent({
			title: "Today Event",
			datetime_iso: "2026-09-07T11:00:00",
		}),
		makeEvent({
			title: "Ongoing Exhibition",
			datetime_iso: "2026-09-01",
			datetime_end_iso: "2026-09-10",
		}),
		makeEvent({
			title: "Tomorrow Event",
			datetime_iso: "2026-09-08T18:00:00",
		}),
		makeEvent({
			title: "Yesterday Event",
			datetime_iso: "2026-09-06T19:00:00",
			datetime_end_iso: "2026-09-06T21:00:00",
		}),
	];

	const filtered = filterEventsForMorningDigest(events, today);
	assert.equal(filtered.length, 2);
	assert.deepEqual(
		filtered.map((e) => e.title),
		["Today Event", "Ongoing Exhibition"],
	);
});

test("formatMorningDigest produces informative notification content", () => {
	const ev1 = makeEvent({
		title: "Creative Writers",
		datetime: "Mon 7 Sep, 11:00 AM",
		datetime_iso: "2026-09-07T11:00:00",
		location: "Carindale Library",
	});
	const singleResult = formatMorningDigest([ev1]);
	assert.equal(singleResult.title, "Today: Creative Writers");
	assert.ok(singleResult.body.includes("11:00 AM"));
	assert.ok(singleResult.body.includes("Carindale Library"));

	const ev2 = makeEvent({
		title: "Comedy Underground",
		datetime: "Mon 7 Sep, 7:30 PM",
		datetime_iso: "2026-09-07T19:30:00",
	});
	const multiResult = formatMorningDigest([ev1, ev2]);
	assert.equal(multiResult.title, "Today's Events (2)");
	assert.ok(multiResult.body.includes("Creative Writers"));
	assert.ok(multiResult.body.includes("Comedy Underground"));
});
