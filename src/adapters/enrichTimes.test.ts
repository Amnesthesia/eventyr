import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enrichCandidateTimes } from "./enrichTimes.ts";
import type { CandidateEvent, Fetcher, SourceDefinition } from "./types.ts";

const REF = new Date("2026-09-03T09:00:00+10:00");

const SOURCE = {
	id: "loganarts",
	name: "Logan Arts",
	homepage: null,
	listingUrls: ["https://loganarts.com.au/events"],
	domains: ["loganarts.com.au"],
	venue: { name: "Logan Arts", address: null, suburb: null },
	strategy: "html",
	sourceTier: "independents",
} as unknown as SourceDefinition;

function candidate(partial: Partial<CandidateEvent>): CandidateEvent {
	return {
		title: "Social Saturdays: Book Club",
		description: null,
		startISO: "2026-09-05T00:00:00+10:00",
		endISO: null,
		startRaw: "Sat 5 Sep",
		endRaw: null,
		venueName: null,
		address: null,
		url: "https://loganarts.com.au/event/social-saturdays-book-club-6/",
		price: null,
		imageUrl: null,
		organiser: null,
		category: null,
		sourceEventId: null,
		provenance: {
			sourceId: "loganarts",
			sourceUrl: "https://loganarts.com.au/events",
			fetchedAt: REF.toISOString(),
			strategy: "html",
		},
		...partial,
	} as CandidateEvent;
}

/** Serves a fixed body from disk, the way SourceFetcher does. */
function serving(body: string): Fetcher {
	const dir = mkdtempSync(join(tmpdir(), "enrich-"));
	const bodyPath = join(dir, "page.html");
	writeFileSync(bodyPath, body, "utf-8");
	return {
		fetch: async (_id, url) => ({
			url,
			fetchedAt: REF.toISOString(),
			status: 200,
			notModified: false,
			contentType: "text/html",
			bodyPath,
			strategy: "html" as const,
		}),
	};
}

test("a time on the detail page is added to the day the listing gave", () => {
	// The real page text for the event that prompted this.
	return enrichCandidateTimes(
		[candidate({})],
		SOURCE,
		serving("<p>Saturday 05 Sep 2026, 10:30AM</p>"),
		REF,
	).then(({ candidates, stats }) => {
		assert.equal(candidates[0].startISO, "2026-09-05T10:30:00+10:00");
		assert.deepEqual(stats, { eligible: 1, fetched: 1, upgraded: 1 });
	});
});

test("JSON-LD is preferred over the page text", async () => {
	const body = `<script type="application/ld+json">${JSON.stringify({
		"@type": "Event",
		name: "Social Saturdays: Book Club",
		startDate: "2026-09-05T14:00:00+10:00",
	})}</script><p>Saturday 05 Sep 2026, 10:30AM</p>`;
	const { candidates } = await enrichCandidateTimes(
		[candidate({})],
		SOURCE,
		serving(body),
		REF,
	);
	assert.equal(candidates[0].startISO, "2026-09-05T14:00:00+10:00");
});

test("a time from a DIFFERENT day is refused, never applied", async () => {
	// A detail page carries other dates — related events, a footer, a posted-on
	// line. Only a time on the day we already had may be taken from text.
	const { candidates, stats } = await enrichCandidateTimes(
		[candidate({})],
		SOURCE,
		serving("<p>Tuesday 22 Sep 2026, 6:00PM</p>"),
		REF,
	);
	assert.equal(candidates[0].startISO, "2026-09-05T00:00:00+10:00");
	assert.equal(stats.upgraded, 0);
});

test("candidates that already have a time are not fetched at all", async () => {
	let fetches = 0;
	const counting: Fetcher = {
		fetch: async (...args) => {
			fetches++;
			return serving("").fetch(...args);
		},
	};
	const { stats } = await enrichCandidateTimes(
		[candidate({ startISO: "2026-09-05T10:30:00+10:00" })],
		SOURCE,
		counting,
		REF,
	);
	assert.equal(stats.eligible, 0);
	assert.equal(fetches, 0);
});

test("a candidate with no URL is left alone", async () => {
	const { stats } = await enrichCandidateTimes(
		[candidate({ url: null })],
		SOURCE,
		serving("<p>Saturday 05 Sep 2026, 10:30AM</p>"),
		REF,
	);
	assert.equal(stats.eligible, 0);
});

test("a detail page that fails to load leaves the candidate untouched", async () => {
	const failing: Fetcher = {
		fetch: async () => {
			throw new Error("ECONNREFUSED");
		},
	};
	const { candidates, stats } = await enrichCandidateTimes(
		[candidate({})],
		SOURCE,
		failing,
		REF,
	);
	assert.equal(candidates[0].startISO, "2026-09-05T00:00:00+10:00");
	assert.equal(stats.upgraded, 0);
});

test("no time anywhere on the page is not a failure", async () => {
	const { candidates, stats } = await enrichCandidateTimes(
		[candidate({})],
		SOURCE,
		serving("<p>A book club at the museum. Saturday 05 Sep 2026</p>"),
		REF,
	);
	assert.equal(candidates[0].startISO, "2026-09-05T00:00:00+10:00");
	assert.equal(stats.upgraded, 0);
});
