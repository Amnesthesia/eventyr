import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateToEvent, humanDatetime, zonedNaive } from "./normalise.ts";
import type { CandidateEvent, ScrapeSource } from "./types.ts";

const BNE = "Australia/Brisbane";

// The exact shape ical.ts's parseDt accepts (src/ical.ts:19,30). Anything
// else is silently dropped from the feed, with no error anywhere — so this
// regex is the real contract normalise.ts has to satisfy. Duplicated rather
// than imported because ical.ts runs requireEnv()/main() at module load.
const ICAL_ACCEPTS = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;

function candidate(over: Partial<CandidateEvent> = {}): CandidateEvent {
	return {
		title: "Test Event",
		description: null,
		startISO: "2026-09-08T19:00:00+10:00",
		startRaw: null,
		endISO: null,
		endRaw: null,
		venueName: null,
		address: null,
		url: null,
		price: null,
		imageUrl: null,
		organiser: null,
		category: null,
		sourceEventId: null,
		provenance: {
			sourceId: "test-source",
			sourceUrl: "https://example.com/whats-on",
			fetchedAt: "2026-09-07T00:00:00.000Z",
			strategy: "html",
		},
		...over,
	};
}

const SOURCE: ScrapeSource = {
	id: "test-source",
	name: "Test Venue",
	homepage: "https://example.com",
	venue: {
		name: "Test Venue",
		address: "1 Example St",
		suburb: "South Brisbane",
	},
	tier: "institutions",
};

test("zonedNaive keeps wall-clock for an explicit +10:00 offset", () => {
	assert.equal(
		zonedNaive("2026-10-05T19:00:00+10:00", BNE),
		"2026-10-05T19:00:00",
	);
});

test("zonedNaive shifts a UTC instant into Brisbane time", () => {
	// dates.ts:187 normalises any explicitly-offset ISO input to UTC, so the
	// JSON-LD path produces this shape. Slicing the offset off the string
	// instead of converting would land on 09:00 — ten hours wrong.
	assert.equal(
		zonedNaive("2026-10-05T09:00:00.000Z", BNE),
		"2026-10-05T19:00:00",
	);
});

test("zonedNaive collapses parsed midnight to a date-only string", () => {
	assert.equal(zonedNaive("2026-09-05T00:00:00+10:00", BNE), "2026-09-05");
});

test("zonedNaive returns null for missing or unparsable input", () => {
	assert.equal(zonedNaive(null, BNE), null);
	assert.equal(zonedNaive("next Tuesday", BNE), null);
});

test("zonedNaive uses the offset in force at the instant, for a DST city", () => {
	const SYD = "Australia/Sydney";
	// 08:00Z is 7pm in Sydney in October (AEDT, +11) but 6pm in July (AEST).
	assert.equal(
		zonedNaive("2026-10-10T08:00:00.000Z", SYD),
		"2026-10-10T19:00:00",
	);
	assert.equal(
		zonedNaive("2026-07-10T08:00:00.000Z", SYD),
		"2026-07-10T18:00:00",
	);
	// dates.ts gives a date-only value its own midnight's offset, so both sides
	// of the DST change collapse back to a date.
	assert.equal(zonedNaive("2026-10-04T00:00:00+10:00", SYD), "2026-10-04");
	assert.equal(zonedNaive("2026-10-05T00:00:00+11:00", SYD), "2026-10-05");
});

test("every zonedNaive output is accepted by ical.ts's parseDt", () => {
	for (const iso of [
		"2026-10-05T19:00:00+10:00",
		"2026-10-05T09:00:00.000Z",
		"2026-09-05T00:00:00+10:00",
		"2026-01-01T23:59:00+10:00",
	]) {
		const out = zonedNaive(iso, BNE);
		assert.ok(out, `expected a value for ${iso}`);
		assert.match(out, ICAL_ACCEPTS, `ical.ts would silently drop ${out}`);
	}
});

test("humanDatetime formats from the resolved instant, not the raw page text", () => {
	assert.equal(humanDatetime("2026-09-08T19:00:00"), "Tue 8 Sep, 7:00 PM");
	assert.equal(humanDatetime("2026-09-08T00:30:00"), "Tue 8 Sep, 12:30 AM");
	assert.equal(humanDatetime("2026-09-08T12:00:00"), "Tue 8 Sep, 12:00 PM");
	assert.equal(humanDatetime("2026-09-08"), "Tue 8 Sep");
	assert.equal(humanDatetime(null), "");
});

test("humanDatetime shows the range when the end is a later day", () => {
	assert.equal(
		humanDatetime("2026-05-02", "2026-12-05"),
		"Sat 2 May – Sat 5 Dec",
	);
	// A timed start keeps its time in a range. This used to drop it — the span
	// was treated as the whole point — but "when does it start today?" is the
	// question a card has to answer, and the time was already known.
	assert.equal(
		humanDatetime("2026-05-23T10:00:00", "2026-11-08"),
		"Sat 23 May, 10:00 AM – Sun 8 Nov",
	);
	// A run crossing a new year is dated at BOTH ends: with the year on the end
	// alone, a 2025 opening reads as this May.
	assert.equal(
		humanDatetime("2026-05-29", "2027-08-11"),
		"Fri 29 May 2026 – Wed 11 Aug 2027",
	);
	assert.equal(
		humanDatetime("2023-09-20T10:00:00", "2027-01-26"),
		"Wed 20 Sep 2023, 10:00 AM – Tue 26 Jan 2027",
	);
	// Same day, or an end before the start, is not a range.
	assert.equal(
		humanDatetime("2026-09-08T19:00:00", "2026-09-08T22:00:00"),
		"Tue 8 Sep, 7:00 PM",
	);
	assert.equal(humanDatetime("2026-09-08", "2026-09-07"), "Tue 8 Sep");
});

test("candidateToEvent composes location from candidate then registry venue", () => {
	assert.equal(
		candidateToEvent(
			candidate({ venueName: "The Tivoli", address: "52 Costin St" }),
			SOURCE,
			BNE,
		).location,
		"The Tivoli, 52 Costin St",
	);
	// falls back to the registry when the page names no venue
	assert.equal(
		candidateToEvent(candidate(), SOURCE, BNE).location,
		"Test Venue, 1 Example St",
	);
	// no duplication when the address is already inside the venue name
	assert.equal(
		candidateToEvent(
			candidate({
				venueName: "Brisbane Powerhouse, New Farm",
				address: "New Farm",
			}),
			undefined,
			BNE,
		).location,
		"Brisbane Powerhouse, New Farm",
	);
	assert.equal(candidateToEvent(candidate(), undefined, BNE).location, "");
});

test("candidateToEvent always produces a string cost (markdown.ts lowercases it)", () => {
	assert.equal(candidateToEvent(candidate(), SOURCE, BNE).cost, "See link");
	assert.equal(
		candidateToEvent(candidate({ price: "AUD 25" }), SOURCE, BNE).cost,
		"AUD 25",
	);
});

test("candidateToEvent drops a relative image URL", () => {
	assert.equal(
		candidateToEvent(candidate({ imageUrl: "/img/hero.jpg" }), SOURCE, BNE)
			.image,
		"",
	);
	assert.equal(
		candidateToEvent(
			candidate({ imageUrl: "https://example.com/hero.jpg" }),
			SOURCE,
			BNE,
		).image,
		"https://example.com/hero.jpg",
	);
});

test("candidateToEvent falls back to the source homepage for a missing link", () => {
	assert.equal(
		candidateToEvent(candidate(), SOURCE, BNE).link,
		"https://example.com",
	);
});
