import assert from "node:assert/strict";
import { test } from "node:test";
import { provenanceFor, toCandidateEvent } from "./candidate.ts";
import type {
	RawCandidateFields,
	RawListing,
	SourceDefinition,
} from "./types.ts";

const REF = new Date("2026-06-01T00:00:00+10:00");

function emptyFields(
	overrides: Partial<RawCandidateFields> = {},
): RawCandidateFields {
	return {
		title: null,
		description: null,
		startRaw: null,
		endRaw: null,
		venueName: null,
		address: null,
		url: null,
		price: null,
		imageUrl: null,
		organiser: null,
		category: null,
		sourceEventId: null,
		...overrides,
	};
}

const SOURCE: SourceDefinition = {
	id: "test-source",
	name: "Test Source",
	homepage: "https://example.com",
	listingUrls: ["https://example.com/whats-on"],
	domains: ["example.com"],
	venue: {
		name: "Test Venue",
		address: null,
		suburb: null,
		lat: null,
		lng: null,
		aliases: [],
	},
	strategy: "html",
	sourceTier: "independents",
	schedule: "weekly",
	note: "test fixture",
};

const RAW: RawListing = {
	url: "https://example.com/whats-on",
	fetchedAt: "2026-06-01T00:00:00.000Z",
	status: 200,
	notModified: false,
	contentType: "text/html",
	bodyPath: "/tmp/does-not-matter.html",
	strategy: "html",
};

test("separate startRaw/endRaw (JSON-LD style) resolve independently", () => {
	const fields = emptyFields({
		startRaw: "2026-06-14T19:00:00",
		endRaw: "2026-06-14T21:00:00",
	});
	const event = toCandidateEvent(
		fields,
		provenanceFor(SOURCE, RAW, "jsonld"),
		REF,
	);
	assert.equal(event.startISO, "2026-06-14T19:00:00+10:00");
	assert.equal(event.endISO, "2026-06-14T21:00:00+10:00");
});

test("a single startRaw field holding a full range (HTML-extraction style) resolves both ends", () => {
	const fields = emptyFields({
		startRaw: "5 – 19 September 2026",
		endRaw: null,
	});
	const event = toCandidateEvent(
		fields,
		provenanceFor(SOURCE, RAW, "html"),
		REF,
	);
	assert.equal(event.startISO, "2026-09-05T00:00:00+10:00");
	assert.equal(event.endISO, "2026-09-19T00:00:00+10:00");
});

test("missing date fields stay null, never guessed", () => {
	const event = toCandidateEvent(
		emptyFields(),
		provenanceFor(SOURCE, RAW, "html"),
		REF,
	);
	assert.equal(event.startISO, null);
	assert.equal(event.endISO, null);
});

test("provenance carries the actual per-listing strategy, not necessarily the source's default", () => {
	const event = toCandidateEvent(
		emptyFields(),
		provenanceFor(SOURCE, RAW, "jsonld"),
		REF,
	);
	assert.equal(event.provenance.strategy, "jsonld");
	assert.equal(event.provenance.sourceId, "test-source");
	assert.equal(event.provenance.sourceUrl, RAW.url);
});
