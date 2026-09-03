import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeedFor, guidFor } from "./rss.ts";

const payload = {
	city: "Brisbane",
	city_key: "brisbane",
	week_start: "2026-09-07",
	week_end: "2026-09-13",
	events: [
		{
			title: "Essay Club 7",
			datetime: "Wed 26 Aug, 6:00 PM",
			datetime_iso: "2026-09-09T18:00:00",
			location: "IMA",
			link: "https://ima.org.au",
			cost: "Free",
			category: "Public Lecture",
			description: "A discussion club.",
		},
		{
			// Different event, same fallback link — the case that made every
			// item collapse into one in a reader when guid was the link.
			title: "Architecture in the Garage",
			datetime_iso: "2026-09-10T18:00:00",
			link: "https://ima.org.au",
			category: "Arts / Exhibition",
			description: 'Talk & drinks <with> "quotes" & ampersands.',
		},
		{ title: "Undated thing", datetime_iso: "", link: "", description: "" },
	],
};

test("guids are unique even when events share a link", () => {
	const guids = payload.events.map((e) => guidFor(e, "brisbane"));
	assert.equal(new Set(guids).size, guids.length);
});

test("guids are stable across rebuilds", () => {
	assert.equal(
		guidFor(payload.events[0], "brisbane"),
		guidFor({ ...payload.events[0] }, "brisbane"),
	);
});

test("feed is well-formed, escapes text, and keeps undated events", () => {
	const xml = buildFeedFor(payload);
	assert.equal(
		(xml.match(/<item>/g) ?? []).length,
		3,
		"undated event still gets an item",
	);
	assert.equal(
		(xml.match(/<pubDate>/g) ?? []).length,
		2,
		"no pubDate when the date is unusable",
	);
	assert.ok(xml.includes("&lt;with&gt;"), "angle brackets escaped");
	assert.ok(xml.includes("&quot;quotes&quot;"), "quotes escaped");
	assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), "no raw ampersands");
	assert.ok(
		xml.includes(
			'<atom:link href="https://www.dothings.lol/brisbane/feed.xml"',
		),
	);
});

test("pubDate is the event's start, converted from Brisbane time to UTC", () => {
	// 18:00 Brisbane (UTC+10) is 08:00 UTC the same day.
	assert.ok(
		buildFeedFor(payload).includes(
			"<pubDate>Wed, 09 Sep 2026 08:00:00 GMT</pubDate>",
		),
	);
});
