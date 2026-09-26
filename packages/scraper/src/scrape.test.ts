import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scrape } from "./scrape.ts";
import { createFixtureFetcher } from "./testing.ts";
import type { RawCandidateFields } from "./types.ts";

const FIXTURES = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"test",
	"fixtures",
);
const NOW = () => new Date("2026-09-23T10:00:00+10:00");
const TZ = "Australia/Brisbane";
const fetcher = createFixtureFetcher(FIXTURES);
const marker: RawCandidateFields = {
	title: "From the fallback",
	description: null,
	startRaw: "Tuesday 29 September 2026, 7:00 PM",
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

test("a feed answers with its format, and its events are normalised", async () => {
	const r = await scrape(
		"https://abbeymuseum.com.au/wp-json/tribe/events/v1/events",
		{
			timeZone: TZ,
			fetcher,
			now: NOW,
		},
	);
	assert.equal(r.fetch.status, "ok");
	assert.equal(r.parse.via, "feed");
	assert.equal(r.parse.format, "events-calendar");
	assert.equal(r.parse.found, 3);
	assert.equal(r.parse.kept, 3);
	assert.equal(r.events.length, 3);
	assert.ok(r.events[0].datetime_iso);
	assert.equal(r.events[0].source, "abbeymuseum.com.au");
	assert.ok(r.fetch.bytes > 0);
});

test("a blocked response is a refusal, not an empty listing", async () => {
	const r = await scrape("https://example-walled.com.au/whats-on", {
		timeZone: TZ,
		fetcher,
		now: NOW,
	});
	assert.equal(r.fetch.status, "blocked");
	assert.equal(r.fetch.httpStatus, 403);
	assert.equal(r.fetch.error, "HTTP 403");
	assert.equal(r.parse.found, 0);
});

test("a fetch that never completed is failed, with the reason", async () => {
	const r = await scrape("https://nxdomain.example-gone.com.au/whats-on", {
		timeZone: TZ,
		fetcher,
		now: NOW,
	});
	assert.equal(r.fetch.status, "failed");
	assert.match(r.fetch.error ?? "", /ENOTFOUND/);
	assert.equal(r.fetch.httpStatus, null);
});

test("a 304 is parsed from the cached body", async () => {
	const r = await scrape("https://thetivoli.com.au/events/ash?cached", {
		timeZone: TZ,
		fetcher,
		now: NOW,
	});
	assert.equal(r.fetch.status, "not-modified");
	assert.equal(r.parse.via, "jsonld");
	assert.equal(r.parse.found, 3);
	assert.deepEqual(r.parse.rejected.map((x) => x.reason).sort(), [
		"no date",
		"no title",
	]);
	assert.equal(r.events.length, 1);
});

test("the fallback is reached only when nothing structured is on the page, and never for an empty one", async () => {
	let calls = 0;
	const fallback = async () => {
		calls++;
		return [marker];
	};
	const plain = await scrape("https://example-plain.com.au/whats-on", {
		timeZone: TZ,
		fetcher,
		fallback,
		now: NOW,
		source: {
			id: "hall",
			name: "Example Hall",
			homepage: "https://example-plain.com.au/",
		},
		linkRewriter: (u) => u ?? "https://rewritten.example/",
	});
	assert.equal(calls, 1);
	assert.equal(plain.parse.via, "fallback");
	assert.equal(plain.events[0].title, "From the fallback");
	assert.equal(plain.events[0].datetime_iso, "2026-09-29T19:00:00");
	assert.equal(plain.events[0].link, "https://rewritten.example/");
	assert.equal(plain.events[0].source, "Example Hall");

	const empty = await scrape("https://example-empty.com.au/whats-on", {
		timeZone: TZ,
		fetcher,
		fallback,
		now: NOW,
	});
	assert.equal(calls, 1, "an empty page must not spend a fallback call");
	assert.equal(empty.fetch.status, "ok");
	assert.equal(empty.parse.via, null);

	const jsonld = await scrape("https://thetivoli.com.au/events/ash", {
		timeZone: TZ,
		fetcher,
		fallback,
		now: NOW,
	});
	assert.equal(calls, 1, "JSON-LD must win before the fallback");
	assert.equal(jsonld.parse.via, "jsonld");
});
