import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockedError, extractListing } from "./ladder.ts";
import type { RawCandidateFields, RawListing, ScrapeSource } from "./types.ts";

const REF = new Date("2026-06-01T00:00:00+10:00");
const TZ = "Australia/Brisbane";
const SOURCE: ScrapeSource = { id: "test-source", name: "Test Source" };

function listing(over: Partial<RawListing> = {}): RawListing {
	return {
		url: "https://example.com/whats-on",
		fetchedAt: "2026-06-01T00:00:00.000Z",
		status: 200,
		notModified: false,
		contentType: "text/html",
		bodyPath: "/dev/null",
		strategy: "html",
		...over,
	};
}

const noFallback = async () => {
	throw new Error("fallback must not be called");
};

test("a feed is a verified answer, empty or not, and never falls through", async () => {
	const full = await extractListing(
		JSON.stringify({
			events: [{ id: 1, title: "Gig", start_date: "2026-06-14 19:00:00" }],
			total: 1,
		}),
		listing({ url: "https://example.com/wp-json/tribe/events/v1/events" }),
		SOURCE,
		TZ,
		noFallback,
		REF,
	);
	assert.equal(full.via, "feed");
	assert.equal(full.format, "events-calendar");
	assert.equal(full.candidates[0].provenance.strategy, "feed");
	const empty = await extractListing(
		"[]",
		listing({ url: "https://example.com/wp-json/mec/v1/events" }),
		SOURCE,
		TZ,
		noFallback,
		REF,
	);
	assert.equal(empty.via, "feed");
	assert.deepEqual(empty.candidates, []);
});

test("JSON-LD present: extracts deterministically and never calls the fallback", async () => {
	const body = `<html><head><script type="application/ld+json">
{"@type":"Event","name":"Philosophy Salon","startDate":"2026-06-14T19:00:00+10:00","url":"https://example.com/e/1"}
</script></head></html>`;
	const { via, candidates } = await extractListing(
		body,
		listing(),
		SOURCE,
		TZ,
		noFallback,
		REF,
	);
	assert.equal(via, "jsonld");
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].title, "Philosophy Salon");
	assert.equal(candidates[0].provenance.strategy, "jsonld");
	assert.equal(candidates[0].provenance.sourceId, "test-source");
	// dates.ts normalises an explicit-offset ISO string via Date#toISOString
	// (UTC/"Z" form) — same behaviour asserted in dates.test.ts.
	assert.equal(candidates[0].startISO, "2026-06-14T19:00:00+10:00");
});

test("no structured data: falls back to the injected extractor over reduced page text", async () => {
	const body = `<html><body><nav>skip me</nav><h1>What's On</h1><p>Trivia Night — 14 June</p></body></html>`;
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
	const { via, candidates } = await extractListing(
		body,
		listing(),
		SOURCE,
		TZ,
		async (pageText, sourceName) => {
			receivedText = pageText;
			receivedSourceName = sourceName;
			return [stubbed];
		},
		REF,
	);
	assert.equal(via, "fallback");
	assert.equal(receivedSourceName, "Test Source");
	assert.ok(receivedText.includes("Trivia Night"));
	assert.ok(
		!receivedText.includes("skip me"),
		"nav boilerplate should have been stripped",
	);
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].provenance.strategy, "html");
	assert.equal(candidates[0].startISO, "2026-06-14T00:00:00+10:00");
});

test("a blocked response throws BlockedError rather than reading as an empty listing", async () => {
	await assert.rejects(
		extractListing(
			"<html>Attention Required!</html>",
			listing({ status: 403 }),
			SOURCE,
			TZ,
			noFallback,
			REF,
		),
		(err: unknown) => err instanceof BlockedError && err.message === "HTTP 403",
	);
	// A 304 carries the cached body and is a normal, extractable response.
	const cached = await extractListing(
		`<html><body><script type="application/ld+json">${JSON.stringify({
			"@type": "Event",
			name: "Cached Gig",
			startDate: "2026-06-14T19:00:00+10:00",
		})}</script></body></html>`,
		listing({ status: 304, notModified: true }),
		SOURCE,
		TZ,
		noFallback,
		REF,
	);
	assert.equal(cached.candidates[0].title, "Cached Gig");
});

test("a page with nothing readable yields no candidates and spends no fallback call", async () => {
	const { via, candidates } = await extractListing(
		'<html><body><div id="app"></div></body></html>',
		listing(),
		SOURCE,
		TZ,
		noFallback,
		REF,
	);
	assert.equal(via, null);
	assert.deepEqual(candidates, []);
	// And with no fallback at all, a plain page is simply empty rather than an error.
	const plain = await extractListing(
		"<html><body><p>Trivia 14 June</p></body></html>",
		listing(),
		SOURCE,
		TZ,
		undefined,
		REF,
	);
	assert.deepEqual(plain.candidates, []);
});
