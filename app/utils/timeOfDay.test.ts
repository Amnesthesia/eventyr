import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import { bandOf, matchesTimeBands } from "./timeOfDay";

const at = (iso: string) => ({ title: "x", datetime_iso: iso }) as Event;

test("events land in the band their start time falls in", () => {
	assert.equal(bandOf(at("2026-09-09T09:30:00")), "morning");
	assert.equal(bandOf(at("2026-09-09T12:00:00")), "afternoon");
	assert.equal(bandOf(at("2026-09-09T16:30:00")), "afternoon");
	assert.equal(bandOf(at("2026-09-09T17:00:00")), "evening");
	assert.equal(bandOf(at("2026-09-09T20:00:00")), "evening");
	// A late set belongs to the evening it started in, not the next morning.
	assert.equal(bandOf(at("2026-09-09T01:00:00")), "evening");
});

test("a date with no time has no band", () => {
	// Roughly a third of events carry a date-only start. Treating those as
	// midnight would file every one of them as "evening".
	assert.equal(bandOf(at("2026-09-09")), null);
	assert.equal(bandOf({ title: "x" } as Event), null);
});

test("an event with no time is never filtered out", () => {
	// A filter that silently drops what it cannot read is worse than one that
	// admits it: excluding these would hide a third of the listings.
	const undated = at("2026-09-09");
	assert.ok(matchesTimeBands(undated, ["morning"]));
	assert.ok(matchesTimeBands(undated, ["evening"]));
});

test("multiple bands can be selected at once", () => {
	const morning = at("2026-09-09T09:00:00");
	const evening = at("2026-09-09T19:00:00");
	const afternoon = at("2026-09-09T14:00:00");
	const both = ["morning", "evening"] as const;
	assert.ok(matchesTimeBands(morning, [...both]));
	assert.ok(matchesTimeBands(evening, [...both]));
	assert.ok(!matchesTimeBands(afternoon, [...both]));
	// No selection means no filtering.
	assert.ok(matchesTimeBands(afternoon, []));
});
