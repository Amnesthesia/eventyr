import assert from "node:assert/strict";
import { test } from "node:test";
import { eventHash, eventPath, eventSlug, slugify } from "./shared.ts";

const DICE = {
	title: "Dice Rolls & Flagons – Casual Board Game Meetup",
	datetime_iso: "2026-09-06T14:00:00",
	location: "Netherworld, Fortitude Valley",
};

test("eventHash output is frozen", () => {
	// These are the values ical.ts's uidFor and rss.ts's guidFor produced before
	// the two inline copies were replaced by this function, derived
	// independently rather than captured from it.
	//
	// If this test fails, the change rewrites every iCal UID and every RSS guid
	// at once: calendar clients re-add all 643 events and feed readers
	// re-notify on all of them. That is the cost, and it is only ever worth
	// paying deliberately — never as a side effect of tidying this function.
	assert.equal(eventHash("brisbane", DICE), "b8wguc");
	assert.equal(
		eventHash("goldcoast", {
			title: "Trivia Night",
			datetime_iso: "2026-09-08",
			location: "Home of the Arts, Bundall",
		}),
		"180ed8d",
	);
});

test("the venue is part of the identity", () => {
	// Generic titles repeat across venues on the same night — "Live Music"
	// appeared five times on one date at five different pubs. Without the
	// location in the basis those share an id, and a calendar client shows one
	// event and silently drops four.
	const base = { title: "Live Music", datetime_iso: "2026-09-05T19:00:00" };
	const triffid = eventHash("brisbane", {
		...base,
		location: "The Triffid, Newstead",
	});
	const rics = eventHash("brisbane", {
		...base,
		location: "Ric's Bar, Fortitude Valley",
	});
	assert.equal(triffid, "nrxadx");
	assert.equal(rics, "68lwo1");
	assert.notEqual(triffid, rics);
});

test("the same event in two cities gets two ids", () => {
	assert.notEqual(eventHash("brisbane", DICE), eventHash("goldcoast", DICE));
});

test("a missing field is not a crash, and not a shared id", () => {
	assert.equal(typeof eventHash("brisbane", {}), "string");
	assert.notEqual(
		eventHash("brisbane", {}),
		eventHash("brisbane", { title: "x" }),
	);
	// A non-string value must not become "undefined" or "[object Object]" and
	// collide with a real event that happens to stringify the same way.
	assert.equal(eventHash("brisbane", { title: 42 }), eventHash("brisbane", {}));
});

test("slugify is URL-safe and bounded", () => {
	assert.equal(
		slugify("Dice Rolls & Flagons – Casual Board Game Meetup"),
		"dice-rolls-flagons-casual-board-game-meetup",
	);
	// Diacritics fold rather than vanish or escape.
	assert.equal(slugify("Café Cabaret"), "cafe-cabaret");
	assert.equal(
		slugify("GEED UP “The Worst Show Ever”"),
		"geed-up-the-worst-show-ever",
	);
	const long = slugify("word ".repeat(40));
	assert.ok(long.length <= 60, `${long.length} chars`);
	assert.ok(!long.endsWith("-"), "no trailing hyphen from the truncation");
	assert.match(long, /^[a-z0-9-]+$/);
});

test("eventSlug is readable, unique, and safe as a path segment", () => {
	assert.equal(
		eventSlug("brisbane", DICE),
		"dice-rolls-flagons-casual-board-game-meetup-b8wguc",
	);
	assert.match(eventSlug("brisbane", DICE), /^[a-z0-9-]+$/);
	// An untitled event still gets a usable segment rather than a leading dash.
	assert.equal(eventSlug("brisbane", {}), eventHash("brisbane", {}));
});

test("eventPath uses the public city slug, not the city key", () => {
	assert.equal(
		eventPath("goldcoast", DICE),
		`/gold-coast/e/${eventSlug("goldcoast", DICE)}`,
	);
	assert.equal(
		eventPath("brisbane", DICE),
		"/brisbane/e/dice-rolls-flagons-casual-board-game-meetup-b8wguc",
	);
});
