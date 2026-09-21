import assert from "node:assert/strict";
import { test } from "node:test";
import { toCandidateEvent } from "./candidate.ts";
import {
	feedUrlsFromHtml,
	parseFeed,
	wpJsonRoutesToFeedUrls,
} from "./feeds.ts";

const PROV = {
	sourceId: "x",
	sourceUrl: "u",
	fetchedAt: "2026-09-08T00:00:00.000Z",
	strategy: "feed" as const,
};
const REF = new Date("2026-09-08T00:00:00+10:00");
const iso = (raw: Parameters<typeof toCandidateEvent>[0]) =>
	toCandidateEvent(raw, PROV, REF).startISO;

// Trimmed from the live response that motivated this module: beachhotel.com.au
// serves a 76-character JS-reload shell for every HTML URL, and 384 events here.
const TEC = JSON.stringify({
	events: [
		{
			id: 12345,
			title: "Jason Delphin",
			description: "<p>Live from 6pm</p>",
			url: "https://www.beachhotel.com.au/event/jason-delphin-13/",
			start_date: "2026-09-08 18:00:00",
			end_date: "2026-09-08 21:00:00",
			cost: "Free",
			venue: { venue: "Beach Hotel", address: "Bay St" },
			image: { url: "https://www.beachhotel.com.au/img.jpg" },
			categories: [{ name: "Live Music" }],
		},
	],
	total: 384,
	rest_url: "https://www.beachhotel.com.au/wp-json/tribe/events/v1/events/",
});

test("The Events Calendar feed yields exact local times", () => {
	const r = parseFeed(
		TEC,
		"https://www.beachhotel.com.au/wp-json/tribe/events/v1/events",
	);
	assert.equal(r?.format, "events-calendar");
	assert.equal(r?.events.length, 1);
	const e = r?.events[0];
	assert.ok(e);
	assert.equal(e.title, "Jason Delphin");
	// The date is copied verbatim and resolved by dates.ts — never computed here.
	assert.equal(e.startRaw, "2026-09-08 18:00:00");
	assert.equal(iso(e), "2026-09-08T18:00:00+10:00");
	assert.equal(e.venueName, "Beach Hotel");
	assert.equal(e.price, "Free");
	assert.equal(e.description, "Live from 6pm");
});

test("a feed that answers with nothing is a verified negative, not a miss", () => {
	// The distinction the pipeline lacked: "nothing on this week" must be
	// tellable from "we failed to look", or a quiet week and a broken scraper
	// look identical. Non-null result, empty events.
	const r = parseFeed(
		JSON.stringify({ events: [], total: 0, rest_url: "x" }),
		"https://x.com/wp-json/tribe/events/v1/events",
	);
	assert.deepEqual(r, { format: "events-calendar", events: [] });
});

test("a body that is not a feed falls through the ladder", () => {
	assert.equal(
		parseFeed("<html><body>gigs</body></html>", "https://x.com/"),
		null,
	);
	assert.equal(parseFeed("not json at all", "https://x.com/"), null);
	// Valid JSON that is not an event feed must not be claimed.
	assert.equal(
		parseFeed(JSON.stringify({ hello: "world" }), "https://x.com/"),
		null,
	);
});

test("Squarespace events come from upcoming/past, never from items", () => {
	// The silent-zero trap: event collections leave `items` empty and split
	// into top-level upcoming/past. Reading `items` reports every Squarespace
	// source as empty and looks like a working integration.
	// Derived, not hand-typed: an epoch literal in a fixture is one digit away
	// from silently testing the wrong year.
	const startEpoch = Date.parse("2026-09-08T07:00:00.000Z"); // 17:00 Brisbane
	const body = JSON.stringify({
		collection: { typeName: "events", title: "What's On" },
		items: [],
		upcoming: [
			{
				id: "a",
				title: "Trivia Night",
				startDate: startEpoch,
				fullUrl: "/whats-on/trivia",
			},
		],
		past: [
			{
				id: "b",
				title: "Old Show",
				startDate: Date.parse("2020-09-13T00:00:00.000Z"),
			},
		],
	});
	const r = parseFeed(
		body,
		"https://www.bangalowhall.com/whats-on?format=json",
	);
	assert.equal(r?.format, "squarespace");
	// Past events are kept: the window filter downstream decides, and dropping
	// them here would hide "this is an archive" behind "the feed failed".
	assert.equal(r?.events.length, 2);
	const upcoming = r?.events.find((e) => e.title === "Trivia Night");
	assert.ok(upcoming);
	assert.equal(iso(upcoming), "2026-09-08T17:00:00+10:00");
	// Relative fullUrl is resolved against the page origin, not left relative.
	assert.equal(upcoming.url, "https://www.bangalowhall.com/whats-on/trivia");
});

test("feed URLs come from the site's own route list, never a guessed path", () => {
	// Guessing the tribe path across 24 hosts scored 1/24; asking /wp-json/ for
	// its routes found Modern Events Calendar on two of those same hosts.
	const root = JSON.stringify({
		namespaces: ["wp/v2", "mec/v1"],
		routes: { "/mec/v1/events": {}, "/wp/v2/posts": {} },
	});
	assert.deepEqual(wpJsonRoutesToFeedUrls(root, "https://shedding.com.au"), [
		"https://shedding.com.au/wp-json/mec/v1/events",
	]);
	// No event route means no URL invented.
	assert.deepEqual(
		wpJsonRoutesToFeedUrls(
			JSON.stringify({ routes: { "/wp/v2/posts": {} } }),
			"https://x.com",
		),
		[],
	);
});

test("an empty MEC array only counts as a feed when the URL says so", () => {
	// A bare [] is ambiguous on its own — claiming it would swallow any JSON
	// array response as "a feed with nothing in it".
	assert.equal(
		parseFeed("[]", "https://x.com/wp-json/mec/v1/events")?.events.length,
		0,
	);
	assert.equal(parseFeed("[]", "https://x.com/some/list.json"), null);
});

test("URLs from feed content are scheme-checked", () => {
	const hostile = JSON.stringify({
		events: [
			{
				title: "X",
				start_date: "2026-09-08 18:00:00",
				url: "javascript:alert(1)",
			},
		],
		total: 1,
	});
	const r = parseFeed(hostile, "https://x.com/wp-json/tribe/events/v1/events");
	assert.equal(r?.events[0]?.url, null);
});

test("oembed links are not followed as event feeds", () => {
	// They describe the page itself, so a fetch can never yield a dated event.
	const html =
		'<link rel="alternate" type="application/json+oembed" href="/wp-json/oembed/1.0/embed?url=x">' +
		'<link rel="alternate" href="/wp-json/tribe/events/v1/events">';
	assert.deepEqual(feedUrlsFromHtml(html, "https://x.com/"), [
		"https://x.com/wp-json/tribe/events/v1/events",
	]);
});

test("self-describing wp-json endpoints are not fetched as feeds", () => {
	// beachhotel.com.au advertises both of these, and each cost a fetch that
	// could never yield an event: wp/v2/pages returns the page's own metadata,
	// and a bare namespace root returns a route index.
	const html =
		'<link rel="alternate" type="application/json" href="/wp-json/wp/v2/pages/1140">' +
		'<link rel="alternate" href="/wp-json/tribe/events/v1/">' +
		'<link rel="alternate" href="/wp-json/tribe/events/v1/events">';
	assert.deepEqual(feedUrlsFromHtml(html, "https://beachhotel.com.au/"), [
		"https://beachhotel.com.au/wp-json/tribe/events/v1/events",
	]);
});

test("Trumba calendar JSON is parsed from customFields", () => {
	const body = JSON.stringify([
		{
			eventID: 208676347,
			title: "Empire of the Sun",
			description: "<p>Frontier Touring&#39;s biggest show.</p>",
			location: "Riverstage, Brisbane City",
			startDateTime: "2027-02-21T17:15:00",
			endDateTime: "2027-02-21T22:00:00",
			startTimeZoneOffset: "+1000",
			endTimeZoneOffset: "+1000",
			permaLinkUrl:
				"https://www.brisbane.qld.gov.au/trumba?trumbaEmbed=view%3Devent%26eventid%3D208676347",
			eventImage: { url: "https://www.trumba.com/i/x.jpg" },
			customFields: [
				{ label: "Venue", value: "Riverstage, Brisbane City" },
				{ label: "Cost", value: "See website for ticket prices" },
				{ label: "Primary event type", value: "Concerts" },
			],
		},
	]);
	const r = parseFeed(body, "https://www.trumba.com/calendars/LIVE.json");
	assert.equal(r?.format, "trumba-json");
	assert.equal(r?.events.length, 1);
	const e = r?.events[0];
	assert.ok(e);
	assert.equal(e.title, "Empire of the Sun");
	// Entities decoded, tags stripped.
	assert.equal(e.description, "Frontier Touring's biggest show.");
	// Local wall-clock + separate zone offset, concatenated verbatim.
	assert.equal(e.startRaw, "2027-02-21T17:15:00+10:00");
	assert.equal(iso(e), "2027-02-21T17:15:00+10:00");
	assert.equal(e.venueName, "Riverstage, Brisbane City");
	assert.equal(e.price, "See website for ticket prices");
	assert.equal(e.category, "Concerts");
});

test("an empty Trumba array only counts as a feed when the URL says so", () => {
	assert.equal(
		parseFeed("[]", "https://www.trumba.com/calendars/x.json")?.events.length,
		0,
	);
	assert.equal(parseFeed("[]", "https://x.com/some/list.json"), null);
});

test("Trumba's Atom/GData calendar is parsed, including the duplicate-tag category trap", () => {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns:gd="http://schemas.google.com/g/2005" xmlns:x-trumba="http://schemas.trumba.com/atom/x-trumba" xmlns="http://www.w3.org/2005/Atom">
	<entry>
		<id>http://uid.trumba.com/event/204260023</id>
		<title type="text">Pilates</title>
		<content type="html">ignored, gc:notes wins</content>
		<link rel="alternate" type="text/html" href="https://x.com/e/204260023" />
		<gd:where valueString="Moora Park, Shorncliffe" />
		<gd:when startTime="2026-09-20T21:00:00Z" endTime="2026-09-20T22:00:00Z" />
		<gc:notes type="string">Bring a mat.</gc:notes>
		<gc:cost type="string">$6</gc:cost>
		<gc:venue type="string">Moora Park, Shorncliffe</gc:venue>
		<gc:venueaddress type="location">Moora Park, 65 Park Parade, Shorncliffe</gc:venueaddress>
		<gc:eventtype type="number">Move Well Brisbane events</gc:eventtype>
		<gc:eventtype type="string">Fitness &amp; well-being</gc:eventtype>
	</entry>
</feed>`;
	const r = parseFeed(
		body,
		"https://www.trumba.com/calendars/brisbane-events-rss.xml?filterview=parks",
	);
	assert.equal(r?.format, "trumba-atom");
	assert.equal(r?.events.length, 1);
	const e = r?.events[0];
	assert.ok(e);
	assert.equal(e.title, "Pilates");
	assert.equal(e.description, "Bring a mat.");
	assert.equal(e.startRaw, "2026-09-20T21:00:00Z");
	assert.equal(e.endRaw, "2026-09-20T22:00:00Z");
	assert.equal(e.venueName, "Moora Park, Shorncliffe");
	assert.equal(e.address, "Moora Park, 65 Park Parade, Shorncliffe");
	assert.equal(e.url, "https://x.com/e/204260023");
	assert.equal(e.price, "$6");
	// The numeric-typed duplicate must not win over the string one.
	assert.equal(e.category, "Fitness & well-being");
	assert.equal(e.sourceEventId, "204260023");
});

test("an unrelated Atom/RSS feed is not claimed as Trumba's", () => {
	const body = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Post</title></entry></feed>`;
	assert.equal(parseFeed(body, "https://x.com/feed/"), null);
});

test("WordPress RSS is not offered as an event feed", () => {
	// Advertised on every page of every WP site, syndicates posts rather than
	// events, and nothing here parses RSS — 77 wasted fetches in one city run.
	const html =
		'<link rel="alternate" type="application/rss+xml" href="https://x.com/feed/">' +
		'<link rel="alternate" type="application/rss+xml" href="https://x.com/comments/feed/">' +
		'<link rel="alternate" href="https://x.com/wp-json/tribe/events/v1/events">';
	assert.deepEqual(feedUrlsFromHtml(html, "https://x.com/"), [
		"https://x.com/wp-json/tribe/events/v1/events",
	]);
});
