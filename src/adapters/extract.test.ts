import assert from "node:assert/strict";
import { test } from "node:test";
import {
	discoverFeedLinks,
	extractJsonLdBlocks,
	findEventNodes,
	jsonLdNodeToRawFields,
} from "./extract.ts";

const SINGLE_EVENT_HTML = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Event","name":"Philosophy Salon","startDate":"2026-06-14T19:00:00+10:00","location":{"@type":"Place","name":"State Library","address":{"streetAddress":"Stanley Place","addressLocality":"South Brisbane"}},"offers":{"price":"0","priceCurrency":"AUD"},"url":"https://example.com/event/1"}
</script>
</head><body></body></html>`;

const GRAPH_HTML = `<script type="application/ld+json">
{"@graph":[{"@type":"Event","name":"Season Opener","subEvent":[{"@type":"TheaterEvent","name":"Session 1"},{"@type":"TheaterEvent","name":"Session 2"}]}]}
</script>`;

const MALFORMED_HTML = `<script type="application/ld+json">{not valid json</script>
<script type="application/ld+json">{"@type":"Event","name":"Still Works"}</script>`;

test("extracts and maps a single schema.org Event", () => {
	const blocks = extractJsonLdBlocks(SINGLE_EVENT_HTML);
	assert.equal(blocks.length, 1);
	const nodes = findEventNodes(blocks);
	assert.equal(nodes.length, 1);
	const fields = jsonLdNodeToRawFields(nodes[0]);
	assert.equal(fields.title, "Philosophy Salon");
	assert.equal(fields.startRaw, "2026-06-14T19:00:00+10:00");
	assert.equal(fields.venueName, "State Library");
	assert.equal(fields.address, "Stanley Place, South Brisbane");
	assert.equal(fields.price, "AUD 0");
	assert.equal(fields.url, "https://example.com/event/1");
});

test("unwraps @graph and nested subEvent into separate nodes", () => {
	const blocks = extractJsonLdBlocks(GRAPH_HTML);
	const nodes = findEventNodes(blocks);
	// Parent event + two sub-events = 3 nodes.
	assert.equal(nodes.length, 3);
	assert.deepEqual(nodes.map((n) => n.name).sort(), [
		"Season Opener",
		"Session 1",
		"Session 2",
	]);
});

test("one malformed JSON-LD block does not lose events in other blocks", () => {
	const blocks = extractJsonLdBlocks(MALFORMED_HTML);
	assert.equal(blocks.length, 1);
	const nodes = findEventNodes(blocks);
	assert.equal(nodes[0].name, "Still Works");
});

test("no JSON-LD present returns an empty list, not an error", () => {
	assert.deepEqual(
		extractJsonLdBlocks("<html><body>no scripts here</body></html>"),
		[],
	);
});

test("discovers RSS and ICS feed links from <head>, resolved against base", () => {
	const html = `<head>
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
<link rel="alternate" type="text/calendar" href="/events.ics">
</head>`;
	const { rss, ics } = discoverFeedLinks(html, "https://example.com/whats-on");
	assert.deepEqual(rss, ["https://example.com/feed.xml"]);
	assert.deepEqual(ics, ["https://example.com/events.ics"]);
});
