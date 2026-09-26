import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The store writes under DATA_ROOT, so point that at a scratch dir before the
// module under test resolves it.
const scratch = mkdtempSync(join(tmpdir(), "eventyr-httpcache-"));
process.env.EVENTYR_DATA_ROOT = scratch;
const { SourceFetcher } = await import("@dothingslol/scraper");
const { createHttpCacheStore } = await import("./httpCache.ts");

test("a data/_cache entry written before the move still drives a conditional GET", async () => {
	// The exact file the old fetch.ts wrote: data/_cache/{sourceId}.json keyed
	// by URL, with the body at data/_raw/{sourceId}/. The Actions cache
	// restores these across runs, so the new fetcher + store must read them.
	const url = "https://example.com/whats-on";
	const bodyPath = join(
		scratch,
		"_raw",
		"venue",
		"2026-09-01T00-00-00-000Z__example_com_whats_on.html",
	);
	mkdirSync(join(scratch, "_raw", "venue"), { recursive: true });
	writeFileSync(bodyPath, "<html>cached</html>", "utf-8");
	mkdirSync(join(scratch, "_cache"), { recursive: true });
	writeFileSync(
		join(scratch, "_cache", "venue.json"),
		JSON.stringify({
			[url]: {
				etag: '"abc"',
				lastModified: "Mon, 01 Sep 2026 00:00:00 GMT",
				bodyPath,
				fetchedAt: "2026-09-01T00:00:00.000Z",
			},
		}),
		"utf-8",
	);

	const seen: Record<string, string>[] = [];
	const fetchImpl: typeof fetch = async (_input, init) => {
		seen.push({ ...(init?.headers as Record<string, string>) });
		return new Response(null, { status: 304 });
	};
	const fetcher = new SourceFetcher({
		store: createHttpCacheStore(),
		fetchImpl,
		minIntervalMs: 0,
	});
	const listing = await fetcher.fetch("venue", url, "html");
	assert.equal(seen[0]["If-None-Match"], '"abc"');
	assert.equal(seen[0]["If-Modified-Since"], "Mon, 01 Sep 2026 00:00:00 GMT");
	assert.equal(listing.status, 304);
	assert.equal(listing.notModified, true);
	assert.equal(listing.bodyPath, bodyPath);
	assert.equal(
		readFileSync(listing.bodyPath ?? "", "utf-8"),
		"<html>cached</html>",
	);
});

test("a fresh response is written in the same layout the old fetcher used", async () => {
	const url = "https://example.com/feed.json";
	const fetchImpl: typeof fetch = async () =>
		new Response("[]", {
			status: 200,
			headers: { "content-type": "application/json", etag: '"v2"' },
		});
	const fetcher = new SourceFetcher({
		store: createHttpCacheStore(),
		fetchImpl,
		minIntervalMs: 0,
	});
	const listing = await fetcher.fetch("venue", url, "html");
	assert.match(
		listing.bodyPath ?? "",
		/\/_raw\/venue\/\d{4}-\d{2}-\d{2}T[\d-]+Z__example_com_feed_json\.json$/,
	);
	const cache = JSON.parse(
		readFileSync(join(scratch, "_cache", "venue.json"), "utf-8"),
	);
	assert.equal(cache[url].etag, '"v2"');
	assert.equal(cache[url].bodyPath, listing.bodyPath);
	// The entry from the first test is still there: the file is merged, not replaced.
	assert.ok(cache["https://example.com/whats-on"]);
});
