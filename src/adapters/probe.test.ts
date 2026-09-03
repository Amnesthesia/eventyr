import assert from "node:assert/strict";
import { test } from "node:test";
import { isSitemapIndex, looksLikeIndex, sitemapPriority } from "./probe.ts";

test("a sitemap's type comes from its root element, not its URL", () => {
	// Broadsheet and My Community Diary both serve an index whose children are
	// extensionless (/sitemap/brisbane). Deciding on a ".xml" suffix meant the
	// crawler treated those children as pages and never descended, reporting
	// "0 listing candidates" for sites that had them.
	assert.ok(
		isSitemapIndex('<?xml version="1.0"?><sitemapindex><sitemap><loc>x</loc>'),
	);
	assert.ok(!isSitemapIndex('<?xml version="1.0"?><urlset><url><loc>x</loc>'));
	assert.ok(!isSitemapIndex("<html><body>Not found</body></html>"));
});

test("a listing index is judged on its last path segment", () => {
	// Listing indexes
	assert.ok(looksLikeIndex("/events"));
	assert.ok(looksLikeIndex("/whats-on/"));
	assert.ok(looksLikeIndex("/buy-tickets"));
	assert.ok(looksLikeIndex("/events/music"));
	// A place or category under a section — mycommunitydiary's real index
	assert.ok(looksLikeIndex("/Queensland/Brisbane"));

	// One event's page. This matched before, because the PATH contained
	// "events", and relevance ranking then preferred it over /events itself.
	assert.ok(!looksLikeIndex("/events/tedx-brisbane"));
	assert.ok(!looksLikeIndex("/events/ian-moss-brisbane"));
	assert.ok(
		!looksLikeIndex("/melbourne/entertainment/article/heartbreak-hotel-show"),
	);
	// Archives are never a listing of upcoming events
	assert.ok(!looksLikeIndex("/past-events"));
	assert.ok(!looksLikeIndex("/events/archive"));
});

test("sitemap children relevant to the city are fetched first", () => {
	const brisbane = ["brisbane", "qld", "queensland"];
	const ourCity = sitemapPriority("https://x.com/sitemap/brisbane", brisbane);
	const otherCity = sitemapPriority(
		"https://x.com/sitemap/melbourne",
		brisbane,
	);
	const eventsIndex = sitemapPriority("https://x.com/sitemap/events", brisbane);
	const neutral = sitemapPriority("https://x.com/sitemap/specials", brisbane);

	// FIFO spent the whole fetch budget inside /sitemap/melbourne and never
	// reached /sitemap/brisbane, so ordering has to be explicit.
	assert.ok(ourCity > neutral, "our city beats an unrelated section");
	assert.ok(neutral > otherCity, "another city sorts to the back");
	assert.ok(eventsIndex > neutral, "an events sitemap beats a generic one");
});
