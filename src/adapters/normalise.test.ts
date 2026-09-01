import assert from "node:assert/strict";
import { test } from "node:test";
import {
	brisbaneNaive,
	candidateToEvent,
	humanDatetime,
	prepareCandidates,
	withinWeek,
} from "./normalise.ts";
import type { CandidateEvent, SourceDefinition } from "./types.ts";

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

const SOURCE: SourceDefinition = {
	id: "test-source",
	name: "Test Venue",
	homepage: "https://example.com",
	listingUrls: ["https://example.com/whats-on"],
	domains: ["example.com"],
	venue: {
		name: "Test Venue",
		address: "1 Example St",
		suburb: "South Brisbane",
		lat: null,
		lng: null,
		aliases: [],
	},
	strategy: "html",
	sourceTier: "institutions",
	schedule: "weekly",
};

test("brisbaneNaive keeps wall-clock for an explicit +10:00 offset", () => {
	assert.equal(
		brisbaneNaive("2026-10-05T19:00:00+10:00"),
		"2026-10-05T19:00:00",
	);
});

test("brisbaneNaive shifts a UTC instant into Brisbane time", () => {
	// dates.ts:187 normalises any explicitly-offset ISO input to UTC, so the
	// JSON-LD path produces this shape. Slicing the offset off the string
	// instead of converting would land on 09:00 — ten hours wrong.
	assert.equal(
		brisbaneNaive("2026-10-05T09:00:00.000Z"),
		"2026-10-05T19:00:00",
	);
});

test("brisbaneNaive collapses parsed midnight to a date-only string", () => {
	assert.equal(brisbaneNaive("2026-09-05T00:00:00+10:00"), "2026-09-05");
});

test("brisbaneNaive returns null for missing or unparsable input", () => {
	assert.equal(brisbaneNaive(null), null);
	assert.equal(brisbaneNaive("next Tuesday"), null);
});

test("every brisbaneNaive output is accepted by ical.ts's parseDt", () => {
	for (const iso of [
		"2026-10-05T19:00:00+10:00",
		"2026-10-05T09:00:00.000Z",
		"2026-09-05T00:00:00+10:00",
		"2026-01-01T23:59:00+10:00",
	]) {
		const out = brisbaneNaive(iso);
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

test("withinWeek keeps a multi-day event straddling the week boundary", () => {
	const mon = "2026-09-07";
	const sun = "2026-09-13";
	assert.equal(withinWeek("2026-09-09T19:00:00", null, mon, sun), true);
	assert.equal(withinWeek("2026-08-20", "2026-09-30", mon, sun), true);
	assert.equal(withinWeek("2026-10-05T19:00:00", null, mon, sun), false);
	assert.equal(withinWeek("2026-09-01", "2026-09-02", mon, sun), false);
	assert.equal(withinWeek(null, null, mon, sun), false);
});

test("candidateToEvent composes location from candidate then registry venue", () => {
	assert.equal(
		candidateToEvent(
			candidate({ venueName: "The Tivoli", address: "52 Costin St" }),
			SOURCE,
		).location,
		"The Tivoli, 52 Costin St",
	);
	// falls back to the registry when the page names no venue
	assert.equal(
		candidateToEvent(candidate(), SOURCE).location,
		"Test Venue, 1 Example St",
	);
	// no duplication when the address is already inside the venue name
	assert.equal(
		candidateToEvent(
			candidate({ venueName: "Brisbane Powerhouse, New Farm", address: "New Farm" }),
			undefined,
		).location,
		"Brisbane Powerhouse, New Farm",
	);
	assert.equal(candidateToEvent(candidate(), undefined).location, "");
});

test("candidateToEvent always produces a string cost (markdown.ts lowercases it)", () => {
	assert.equal(candidateToEvent(candidate(), SOURCE).cost, "See link");
	assert.equal(
		candidateToEvent(candidate({ price: "AUD 25" }), SOURCE).cost,
		"AUD 25",
	);
});

test("candidateToEvent drops a relative image URL", () => {
	assert.equal(
		candidateToEvent(candidate({ imageUrl: "/img/hero.jpg" }), SOURCE).image,
		"",
	);
	assert.equal(
		candidateToEvent(
			candidate({ imageUrl: "https://example.com/hero.jpg" }),
			SOURCE,
		).image,
		"https://example.com/hero.jpg",
	);
});

test("candidateToEvent falls back to the source homepage for a missing link", () => {
	assert.equal(candidateToEvent(candidate(), SOURCE).link, "https://example.com");
});

test("prepareCandidates drops untitled, undated and out-of-week candidates", () => {
	const { prepared, stats } = prepareCandidates(
		[
			candidate({ title: "Keeper" }),
			candidate({ title: "  " }),
			// dates.ts refused to parse this one — keeping it would let it match
			// any similarly-titled event on any date during the merge
			candidate({ title: "Undated", startISO: null }),
			candidate({ title: "Next month", startISO: "2026-10-20T19:00:00+10:00" }),
		],
		SOURCE,
		"2026-09-07",
		"2026-09-13",
	);
	assert.equal(prepared.length, 1);
	assert.equal(prepared[0].event.title, "Keeper");
	assert.deepEqual(stats, {
		total: 4,
		noTitle: 1,
		noDate: 1,
		outsideWeek: 1,
		kept: 1,
	});
});
