import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractEmbeddedJson,
	extractFromEmbeddedJson,
	findEventObjects,
	isEventLike,
} from "./embeddedJson.ts";

test("reads __NEXT_DATA__ and generic application/json blobs", () => {
	const html = `<html><body>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"a":1}}</script>
    <script type="application/json">{"b":2}</script>
    <script type="application/ld+json">{"@type":"Event"}</script>
    <script>var notJson = 1;</script>
  </body></html>`;
	const blobs = extractEmbeddedJson(html);
	assert.equal(blobs.length, 2, "ld+json and plain scripts are not picked up here");
});

test("reassembles Next.js app-router flight chunks", () => {
	// self.__next_f.push([1,"<chunk>"]) — the payload is a JSON string whose
	// contents are `<id>:<json>` lines, split across chunks mid-value.
	const payload = '3a:[{"title":"Gig Night","runDateStart":"2026-09-09"}]';
	const half = Math.floor(payload.length / 2);
	const html = `<script>self.__next_f.push([1,${JSON.stringify(payload.slice(0, half))}])</script>
    <script>self.__next_f.push([1,${JSON.stringify(payload.slice(half))}])</script>`;
	const objects = findEventObjects(extractEmbeddedJson(html));
	assert.equal(objects.length, 1);
	assert.equal(objects[0].title, "Gig Night");
});

test("isEventLike needs a name and a date-shaped value", () => {
	assert.ok(isEventLike({ title: "Show", startDate: "2026-09-09" }));
	// real-world key spellings
	assert.ok(isEventLike({ name: "Show", runDateStart: "2026-09-09" }));
	assert.ok(isEventLike({ title: "Show", starts_at: "9 September 2026" }));
	// a title with no date can't survive normalisation, so it isn't an event
	assert.ok(!isEventLike({ title: "About us" }));
	// nav items and menus have a label but nothing date-shaped
	assert.ok(!isEventLike({ label: "What's On", href: "/whats-on", count: 12 }));
	assert.ok(!isEventLike({ title: "Show", startDate: "soon" }));
	assert.ok(!isEventLike(null));
	assert.ok(!isEventLike(["title"]));
});

test("an end-dated key is never mistaken for the start", () => {
	const [fields] = extractFromEmbeddedJson(
		`<script type="application/json">${JSON.stringify([
			{ title: "Season", runDateStart: "2026-09-09", runDateEnd: "2026-09-20" },
		])}</script>`,
		"https://example.com/whats-on",
	);
	assert.equal(fields.startRaw, "2026-09-09");
	assert.equal(fields.endRaw, "2026-09-20");
});

test("maps nested venue/image shapes and resolves relative URLs", () => {
	const [fields] = extractFromEmbeddedJson(
		`<script type="application/json">${JSON.stringify([
			{
				title: "Dumpling Masterclass",
				startDate: "2026-09-09T18:00:00",
				venue: { name: "HOTA", address: "135 Bundall Rd" },
				href: "/events/dumplings",
				imageUrl: "/img/d.jpg",
				price: "$95",
				description: "Roll your own.",
			},
		])}</script>`,
		"https://hota.com.au/whats-on/",
	);
	assert.equal(fields.title, "Dumpling Masterclass");
	assert.equal(fields.venueName, "HOTA");
	assert.equal(fields.address, "135 Bundall Rd");
	assert.equal(fields.url, "https://hota.com.au/events/dumplings");
	assert.equal(fields.imageUrl, "https://hota.com.au/img/d.jpg");
	assert.equal(fields.price, "$95");
});

test("the same event in two blobs is returned once", () => {
	const event = { title: "Gig", startDate: "2026-09-09", url: "/g" };
	const html = `<script type="application/json">${JSON.stringify([event])}</script>
    <script type="application/json">${JSON.stringify({ cache: { items: [event] } })}</script>`;
	assert.equal(extractFromEmbeddedJson(html, "https://example.com").length, 1);
});

test("a page with no embedded JSON yields nothing rather than throwing", () => {
	assert.deepEqual(
		extractFromEmbeddedJson("<html><body><p>Hi</p></body></html>", "https://x.com"),
		[],
	);
	assert.deepEqual(
		extractFromEmbeddedJson('<script type="application/json">{oops</script>', "https://x.com"),
		[],
	);
});

test("a publish/modify date is never read as the event's start", () => {
	const [fields] = extractFromEmbeddedJson(
		`<script type="application/json">${JSON.stringify([
			{
				title: "Real Gig",
				dateModified: "2020-01-01",
				datePublished: "2019-05-05",
				startDate: "2026-09-03T19:00:00+10:00",
			},
		])}</script>`,
		"https://example.com",
	);
	assert.equal(fields.startRaw, "2026-09-03T19:00:00+10:00");
});

test("prose containing a month word is not a date", () => {
	// These were passing as events, and because pageAdapter returns on the
	// first strategy that yields anything, they suppressed the LLM fallback.
	assert.ok(!isEventLike({ label: "Members may book early", from: "Members may book" }));
	assert.ok(!isEventLike({ title: "March of the Penguins", date: "a March release" }));
	assert.ok(!isEventLike({ title: "Blog post", datePublished: "2026-09-01" }));
	// but real date spellings still count
	assert.ok(isEventLike({ title: "Gig", startDate: "Sep 3, 2026" }));
	assert.ok(isEventLike({ title: "Gig", startDate: "3 September 2026" }));
	assert.ok(isEventLike({ title: "Gig", startDate: "2026-09-03" }));
});
