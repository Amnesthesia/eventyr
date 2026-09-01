import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPageAdapter } from "./pageAdapter.ts";
import type {
	Fetcher,
	RawCandidateFields,
	RawListing,
	SourceDefinition,
} from "./types.ts";

const REF = new Date("2026-06-01T00:00:00+10:00");
const TMP = mkdtempSync(join(tmpdir(), "eventyr-pageadapter-test-"));

function writeFixture(name: string, body: string): string {
	const path = join(TMP, name);
	writeFileSync(path, body, "utf-8");
	return path;
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

function makeListing(bodyPath: string | null, notModified = false): RawListing {
	return {
		url: "https://example.com/whats-on",
		fetchedAt: "2026-06-01T00:00:00.000Z",
		status: notModified ? 304 : 200,
		notModified,
		contentType: "text/html",
		bodyPath,
		strategy: "html",
	};
}

function fetcherReturning(listings: RawListing[]): Fetcher {
	let i = 0;
	return {
		async fetch() {
			return listings[i++];
		},
	};
}

test("discover() fetches every listingUrl via the injected fetcher", async () => {
	const source: SourceDefinition = {
		...SOURCE,
		listingUrls: ["https://example.com/a", "https://example.com/b"],
	};
	const calls: Array<[string, string, string]> = [];
	const fetcher: Fetcher = {
		async fetch(sourceId, url, strategy) {
			calls.push([sourceId, url, strategy]);
			return makeListing(null);
		},
	};
	const adapter = createPageAdapter(source, {
		fetcher,
		extractPage: async () => [],
	});
	const listings = await adapter.discover();
	assert.equal(listings.length, 2);
	assert.deepEqual(calls, [
		["test-source", "https://example.com/a", "html"],
		["test-source", "https://example.com/b", "html"],
	]);
});

test("JSON-LD present: extracts deterministically and never calls the LLM extractor", async () => {
	const bodyPath = writeFixture(
		"jsonld.html",
		`<html><head><script type="application/ld+json">
{"@type":"Event","name":"Philosophy Salon","startDate":"2026-06-14T19:00:00+10:00","url":"https://example.com/e/1"}
</script></head></html>`,
	);
	let llmCalled = false;
	const adapter = createPageAdapter(SOURCE, {
		fetcher: fetcherReturning([]),
		extractPage: async () => {
			llmCalled = true;
			return [];
		},
		now: () => REF,
	});
	const events = await adapter.extract(makeListing(bodyPath));
	assert.equal(llmCalled, false);
	assert.equal(events.length, 1);
	assert.equal(events[0].title, "Philosophy Salon");
	assert.equal(events[0].provenance.strategy, "jsonld");
	// dates.ts normalises an explicit-offset ISO string via Date#toISOString
	// (UTC/"Z" form) — same behaviour asserted in dates.test.ts.
	assert.equal(
		events[0].startISO,
		new Date("2026-06-14T19:00:00+10:00").toISOString(),
	);
});

test("no JSON-LD: falls back to the injected LLM extractor over reduced page text", async () => {
	const bodyPath = writeFixture(
		"plain.html",
		`<html><body><nav>skip me</nav><h1>What's On</h1><p>Trivia Night — 14 June</p></body></html>`,
	);
	let receivedText = "";
	let receivedSourceName = "";
	const stubbed: RawCandidateFields = {
		title: "Trivia Night",
		description: null,
		startRaw: "14 June",
		endRaw: null,
		venueName: null,
		address: null,
		url: null,
		price: null,
		imageUrl: null,
		organiser: null,
		category: null,
		sourceEventId: null,
	};
	const adapter = createPageAdapter(SOURCE, {
		fetcher: fetcherReturning([]),
		extractPage: async (pageText, sourceName) => {
			receivedText = pageText;
			receivedSourceName = sourceName;
			return [stubbed];
		},
		now: () => REF,
	});
	const events = await adapter.extract(makeListing(bodyPath));
	assert.equal(receivedSourceName, "Test Source");
	assert.ok(receivedText.includes("Trivia Night"));
	assert.ok(
		!receivedText.includes("skip me"),
		"nav boilerplate should have been stripped",
	);
	assert.equal(events.length, 1);
	assert.equal(events[0].title, "Trivia Night");
	assert.equal(events[0].provenance.strategy, "html");
	assert.equal(events[0].startISO, "2026-06-14T00:00:00+10:00");
});

test("a not-modified (304) listing is skipped without touching the extractor", async () => {
	let called = false;
	const adapter = createPageAdapter(SOURCE, {
		fetcher: fetcherReturning([]),
		extractPage: async () => {
			called = true;
			return [];
		},
	});
	const events = await adapter.extract(makeListing("/does/not/matter", true));
	assert.deepEqual(events, []);
	assert.equal(called, false);
});

test("a listing with no persisted body (hard fetch failure) yields no candidates", async () => {
	const adapter = createPageAdapter(SOURCE, {
		fetcher: fetcherReturning([]),
		extractPage: async () => [],
	});
	const events = await adapter.extract(makeListing(null));
	assert.deepEqual(events, []);
});
