import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import { eventsFromIds, parseSavedIds, savedCalendarUrl } from "./savedLink";

function ev(title: string, datetime_iso: string): Event {
	return {
		title,
		datetime: "",
		location: "The Triffid",
		link: "",
		category: "Concert / Music",
		cost: "",
		source: "",
		description: "",
		tags: [],
		score: 5,
		datetime_iso,
		datetime_end_iso: "",
		image: "",
	};
}

const EVENTS = [
	ev("Lebanon Hanover", "2026-09-17T19:00:00"),
	ev("Briscoe Sisters", "2026-09-18T17:00:00"),
	ev("Triffid Sundays", "2026-09-20"),
];

test("a saved set survives the round trip through a URL", () => {
	const picked = [EVENTS[2], EVENTS[0]];
	const url = savedCalendarUrl(picked, "brisbane");
	const ids = parseSavedIds(new URL(url).hash);
	assert.ok(ids);
	// The order the link listed them in is the order that comes back.
	assert.deepEqual(
		eventsFromIds(ids, EVENTS, "brisbane").map((e) => e.title),
		["Triffid Sundays", "Lebanon Hanover"],
	);
});

test("a fragment with no cal parameter is null, not an empty set", () => {
	// "no shared link here" and "a shared link holding nothing" need different
	// handling: the first shows the page, the second would show an empty modal.
	assert.equal(parseSavedIds(""), null);
	assert.equal(parseSavedIds("#some-anchor"), null);
	assert.deepEqual(parseSavedIds("#cal="), []);
});

test("an id that no longer resolves is skipped, not an error", () => {
	// A link shared last week points at events this week's digest has dropped.
	const url = savedCalendarUrl([EVENTS[0], EVENTS[1]], "brisbane");
	const ids = parseSavedIds(new URL(url).hash) ?? [];
	const survivors = eventsFromIds(ids, [EVENTS[1]], "brisbane");
	assert.deepEqual(
		survivors.map((e) => e.title),
		["Briscoe Sisters"],
	);
});

test("the same event in another city is a different id", () => {
	// eventHash is city-scoped, so a Gold Coast link cannot silently resolve
	// against Brisbane's list.
	const ids = parseSavedIds(
		new URL(savedCalendarUrl([EVENTS[0]], "goldcoast")).hash,
	);
	assert.deepEqual(eventsFromIds(ids ?? [], EVENTS, "brisbane"), []);
});
