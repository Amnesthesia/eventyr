import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateEvent } from "@dothingslol/scraper";
import type { SourceDefinition } from "../adapters/types.js";
import {
	councilEventUrl,
	isPast,
	prepareCandidates,
	withinWindow,
} from "./normalise.ts";

const BNE = "Australia/Brisbane";

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
	},
	strategy: "html",
	sourceTier: "institutions",
	timeZone: "Australia/Brisbane",
};

test("withinWindow keeps a multi-day event straddling the boundary", () => {
	const mon = "2026-09-07";
	const sun = "2026-09-13";
	assert.equal(withinWindow("2026-09-09T19:00:00", null, mon, sun), true);
	assert.equal(withinWindow("2026-08-20", "2026-09-30", mon, sun), true);
	assert.equal(withinWindow("2026-10-05T19:00:00", null, mon, sun), false);
	assert.equal(withinWindow("2026-09-01", "2026-09-02", mon, sun), false);
	assert.equal(withinWindow(null, null, mon, sun), false);
});

test("prepareCandidates drops untitled, undated, past and out-of-window candidates", () => {
	const { prepared, stats } = prepareCandidates(
		[
			candidate({ title: "Keeper" }),
			candidate({ title: "  " }),
			// dates.ts refused to parse this one — keeping it would let it match
			// any similarly-titled event on any date during the merge
			candidate({ title: "Undated", startISO: null }),
			candidate({ title: "Next month", startISO: "2026-10-20T19:00:00+10:00" }),
			// already finished — the signal that a listing URL is an archive
			candidate({ title: "Last month", startISO: "2026-08-02T19:00:00+10:00" }),
		],
		SOURCE,
		"2026-09-07",
		"2026-09-13",
		BNE,
	);
	assert.equal(prepared.length, 1);
	assert.equal(prepared[0].event.title, "Keeper");
	assert.deepEqual(stats, {
		total: 5,
		noTitle: 1,
		noDate: 1,
		past: 1,
		later: 1,
		kept: 1,
	});
});

test("rejections are recorded with the raw date text that failed", () => {
	// This is what makes a bad yield diagnosable from a file rather than by
	// re-running the extraction.
	const { rejected } = prepareCandidates(
		[
			candidate({
				title: "Undated",
				startISO: null,
				startRaw: "every Tuesday",
			}),
			candidate({ title: "Old", startISO: "2026-08-02T19:00:00+10:00" }),
		],
		SOURCE,
		"2026-09-07",
		"2026-09-13",
		BNE,
	);
	assert.equal(rejected.length, 2);
	assert.deepEqual(
		rejected.map((r) => r.reason),
		["no date", "past"],
	);
	assert.equal(rejected[0].startRaw, "every Tuesday");
});

test("the window excludes the past but includes next week", () => {
	const from = "2026-09-09"; // a Wednesday run
	const to = "2026-09-20"; // end of next week
	// Monday's finished event must not come back just because it is "this week"
	assert.equal(withinWindow("2026-09-07T19:00:00", null, from, to), false);
	assert.equal(isPast("2026-09-07T19:00:00", null, from), true);
	// next week is in
	assert.equal(withinWindow("2026-09-17T19:00:00", null, from, to), true);
	// the week after is not
	assert.equal(withinWindow("2026-09-28T19:00:00", null, from, to), false);
	// a run that started before the window but is still on stays
	assert.equal(withinWindow("2026-08-01", "2026-09-30", from, to), true);
	assert.equal(isPast("2026-08-01", "2026-09-30", from), false);
});

test("council Trumba embed links become the event's own Trumba page", () => {
	for (const path of ["trumba", "brisbane-events"]) {
		assert.equal(
			councilEventUrl(
				`https://www.brisbane.qld.gov.au/${path}?trumbaEmbed=view%3Devent%26eventid%3D191635791`,
			),
			"https://www.trumba.com/calendars/brisbane-city-council?eventid=191635791",
		);
	}
	assert.equal(
		councilEventUrl("https://riverstage.com.au/events/x"),
		"https://riverstage.com.au/events/x",
	);
	// The same link handed over unescaped.
	assert.equal(
		councilEventUrl(
			"https://www.brisbane.qld.gov.au/trumba?trumbaEmbed=view=event&eventid=204315895",
		),
		"https://www.trumba.com/calendars/brisbane-city-council?eventid=204315895",
	);
	assert.equal(councilEventUrl(null), null);
});
