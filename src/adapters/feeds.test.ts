import assert from "node:assert/strict";
import { test } from "node:test";
import { toCandidateEvent } from "./candidate.ts";
import {
	apiRequestFor,
	feedUrlsFromHtml,
	parseFeed,
	parseIcal,
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
	// Trumba's hosted event page, not the council's embed permalink, which
	// only lands on its event search.
	assert.equal(
		e.url,
		"https://www.trumba.com/calendars/LIVE?eventid=208676347",
	);
	// Off Trumba's host there is no calendar name, so the permalink stays.
	assert.equal(
		parseFeed(body, "https://mirror.example/calendars/LIVE.json")?.events[0]
			?.url,
		"https://www.brisbane.qld.gov.au/trumba?trumbaEmbed=view%3Devent%26eventid%3D208676347",
	);
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
	assert.equal(
		e.url,
		"https://www.trumba.com/calendars/brisbane-events-rss?eventid=204260023",
	);
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

// Trimmed from fivestarcinemas.com.au/api/movie/playing-now (New Farm cookie).
const fsSession = (date: string, attrs: string[] = [], id = date) => ({
	_id: id,
	date,
	time: "6:45pm",
	bookingLink: "https://ticketing.oz.veezi.com/purchase/1?siteToken=t",
	attributes: attrs.map((shortName) => ({ shortName })),
});
const FIVESTAR = JSON.stringify([
	{
		url: "rocky-horror-picture-show",
		title: "The Rocky Horror Picture Show (1975)",
		synopsisShort: "Interactive <b>midnight</b> screening.",
		releaseDate: "2026-10-31",
		sessionTimes: [
			fsSession("2026-10-30", ["NFT", "Classic"], "a"),
			fsSession("2026-10-31", ["Classic"], "b"),
			fsSession("2026-10-31", ["Classic"], "c"),
		],
	},
	// An ordinary release: many sessions, none tagged — skipped.
	{
		url: "heart-of-the-beast",
		title: "Heart of the Beast",
		releaseDate: "2026-09-24",
		sessionTimes: ["24", "25", "26"].map((d) => fsSession(`2026-09-${d}`)),
	},
	// One session, released on the night: a one-off, kept untagged.
	{
		url: "hard-as-puck",
		title: "Hard as Puck",
		releaseDate: "2026-11-15",
		sessionTimes: [fsSession("2026-11-15", ["Premium"])],
	},
	// One session but released years earlier: a placeholder / tail of a run.
	{
		url: "ticket-swap",
		title: "Ticket Swap",
		releaseDate: "2021-12-31",
		sessionTimes: [fsSession("2027-01-01", ["Premium"])],
	},
]);

test("Five Star keeps tagged and one-off screenings, skips ordinary runs", () => {
	const r = parseFeed(FIVESTAR, "https://www.fivestarcinemas.com.au/new-farm");
	assert.equal(r?.format, "fivestar");
	assert.deepEqual(
		r?.events.map((e) => e.title),
		[
			"The Rocky Horror Picture Show (1975)",
			"The Rocky Horror Picture Show (1975)",
			"The Rocky Horror Picture Show (1975)",
			"Hard as Puck",
		],
	);
	const e = r?.events[0];
	assert.equal(e?.startRaw, "2026-10-30 6:45pm");
	assert.equal(
		e?.description,
		"Classic screening. Interactive midnight screening.",
	);
	assert.equal(
		e?.url,
		"https://www.fivestarcinemas.com.au/new-farm/movie/rocky-horror-picture-show",
	);
	assert.equal(e?.sourceEventId, "a");
	assert.equal(
		iso(e as Parameters<typeof iso>[0]),
		"2026-10-30T18:45:00+10:00",
	);
});

test("Five Star: an empty programme is a verified negative only on its own host", () => {
	assert.equal(
		parseFeed("[]", "https://www.fivestarcinemas.com.au/redhill")?.events
			.length,
		0,
	);
	assert.equal(parseFeed("[]", "https://x.com/api"), null);
});

test("Five Star requests carry the cinema cookie; other URLs are untouched", async () => {
	const never = (() => {
		throw new Error("no network");
	}) as unknown as typeof fetch;
	const req = await apiRequestFor(
		"https://www.fivestarcinemas.com.au/redhill",
		never,
	);
	assert.equal(
		req?.url,
		"https://www.fivestarcinemas.com.au/api/movie/playing-now",
	);
	assert.equal(
		req?.headers.Cookie,
		"multisiteDomainv3=fivestarcinemas.com.au%2Fredhill",
	);
	assert.equal(await apiRequestFor("https://x.com/events", never), null);
});

// Trimmed from prod-api.readingcinemas.com.au/films (Angelika, South City Square).
const readingFilm = (
	slug: string,
	name: string,
	release: string,
	times: string[],
) => ({
	slug,
	name,
	synopsis: "<p>A film.</p>",
	release_date: release,
	showdates: [
		{
			date: times[0]?.slice(0, 10),
			showtypes: [
				{
					type: "Premium",
					showtimes: times.map((t, i) => ({
						id: `${slug}-${i}`,
						date_time: t,
					})),
				},
			],
		},
	],
});
const READING = JSON.stringify({
	statusCode: 200,
	data: [
		readingFilm("10413", "Angelika Archive - Space Jam (1996)", "2026-09-25", [
			"2026-09-25T20:30:00+10",
			"2026-09-29T18:30:00+10",
		]),
		readingFilm(
			"10244",
			"The Odyssey",
			"2026-07-16",
			["24", "25", "26"].map((d) => `2026-09-${d}T14:45:00+10`),
		),
		// Two sessions but released months ago: the end of an ordinary run.
		readingFilm("9000", "Old Release", "2026-06-01", [
			"2026-09-26T10:00:00+10",
		]),
	],
});

test("Reading Cinemas keeps only one-off films, with Angelika links", () => {
	const url =
		"https://prod-api.readingcinemas.com.au/films?countryId=3&cinemaId=southcity&status=nowShowing";
	const r = parseFeed(READING, url);
	assert.equal(r?.format, "reading-cinemas");
	assert.deepEqual(
		r?.events.map((e) => e.sourceEventId),
		["10413-0", "10413-1"],
	);
	const e = r?.events[0];
	assert.equal(e?.url, "https://angelikacinemas.com.au/movies/details/10413");
	assert.equal(e?.description, "A film.");
	assert.equal(
		iso(e as Parameters<typeof iso>[0]),
		"2026-09-25T20:30:00+10:00",
	);
	assert.equal(
		parseFeed(JSON.stringify({ statusCode: 200, data: [] }), url)?.events
			.length,
		0,
	);
});

// Trimmed from palacecinemas.com.au/cinemas/palace-james-st. The occasion's
// startDateUTC (20 Aug) is the promotion start — reading it made every Palace
// event look past — and session dates carry a false "Z": 18:15Z renders on
// the page as "6:15 pm".
const palacePage = (pageProps: unknown) =>
	`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></html>`;
const PALACE = palacePage({
	cinema: {
		upcomingEvents: [
			{
				title:
					"ST. ALi Italian Film Festival Opening Night Premiere: Holy Cannoli",
				startDateUTC: "2026-08-20T12:00:00.000Z",
				caption: "With prosecco.",
			},
			{ title: "Fine Wine Preview: Sense and Sensibility", caption: "Wine." },
			{ title: "Matinee Preview: Sense and Sensibility", caption: "Tea." },
		],
	},
	sessions: [
		{
			slug: "iff26-holy-cannoli",
			title: "IFF26 Holy Cannoli",
			releaseDateUtc: "2026-09-16T00:00:00.000Z",
			sessions: [
				{
					sessionId: "1",
					date: "2026-09-24T18:15:00.000Z",
					isSpecialEvent: true,
					displayAttributeText: "SPECIAL EVENT",
				},
				{
					sessionId: "2",
					date: "2026-09-27T12:40:00.000Z",
					isSpecialEvent: false,
					displayAttributeText: null,
				},
				{
					sessionId: "3",
					date: "2026-09-29T15:40:00.000Z",
					isSpecialEvent: false,
					displayAttributeText: null,
				},
			],
		},
		{
			slug: "sense-and-sensibility",
			title: "Sense and Sensibility",
			releaseDateUtc: "2026-10-15T00:00:00.000Z",
			sessions: [
				{
					sessionId: "4",
					date: "2026-10-09T18:30:00.000Z",
					displayAttributeText: "Sneak",
				},
				{
					sessionId: "5",
					date: "2026-10-11T11:00:00.000Z",
					displayAttributeText: "Sneak",
				},
			],
		},
		{
			slug: "resident-evil",
			title: "Resident Evil",
			releaseDateUtc: "2026-09-17T00:00:00.000Z",
			sessions: [
				{
					sessionId: "6",
					date: "2026-09-24T13:00:00.000Z",
					displayAttributeText: "RECLINER",
				},
				{
					sessionId: "7",
					date: "2026-09-24T15:00:00.000Z",
					displayAttributeText: null,
				},
				{
					sessionId: "8",
					date: "2026-09-25T15:00:00.000Z",
					displayAttributeText: null,
				},
			],
		},
	],
});

test("Palace dates come from sessions, not the occasion's promotion date", () => {
	const url = "https://www.palacecinemas.com.au/cinemas/palace-james-st";
	const r = parseFeed(PALACE, url);
	assert.equal(r?.format, "palace");
	// Ordinary runs and recliner sessions are skipped; tagged sessions kept.
	assert.deepEqual(
		r?.events.map((e) => e.sourceEventId),
		["1", "4", "5"],
	);
	const [cannoli, sense] = r?.events ?? [];
	assert.equal(
		cannoli.title,
		"ST. ALi Italian Film Festival Opening Night Premiere: Holy Cannoli",
	);
	assert.equal(
		iso(cannoli as Parameters<typeof iso>[0]),
		"2026-09-24T18:15:00+10:00",
	);
	assert.match(
		cannoli.description ?? "",
		/special event screening\. With prosecco\./,
	);
	assert.equal(
		cannoli.url,
		"https://www.palacecinemas.com.au/movies/iff26-holy-cannoli",
	);
	// Two occasions name this film and nothing says which session is which.
	assert.equal(sense.title, "Sense and Sensibility");
	// The same page shape on another host is not claimed.
	assert.equal(parseFeed(PALACE, "https://example.com/cinemas/x"), null);
});

const ics = (...lines: string[]) =>
	["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");

test("iCal: exact instants, all-day dates, recurrences and cancellations", () => {
	const body = ics(
		"BEGIN:VEVENT",
		"UID:one",
		"DTSTART:20260926T020000Z",
		"DTEND:20260926T110000Z",
		"SUMMARY:Claudia Cloud",
		"LOCATION:House Conspiracy\\, 36 Mary St",
		"URL:https://houseconspiracy.org/claudia",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:allday",
		"DTSTART;VALUE=DATE:20260930",
		"SUMMARY:Open studio",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:gone",
		"STATUS:CANCELLED",
		"DTSTART:20260927T020000Z",
		"SUMMARY:Cancelled",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:weekly",
		"DTSTART:20210101T090000Z",
		"RRULE:FREQ=WEEKLY",
		"EXDATE:20260925T090000Z",
		"SUMMARY:Life drawing",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:weekly",
		"RECURRENCE-ID:20261002T090000Z",
		"DTSTART:20261002T100000Z",
		"SUMMARY:Life drawing (late)",
		"END:VEVENT",
	);
	const r = parseIcal(body, new Date("2026-09-20T00:00:00Z"));
	assert.equal(r?.format, "ical");
	const byId = new Map(r?.events.map((e) => [e.sourceEventId, e]));
	const one = byId.get("one");
	assert.equal(one?.startRaw, "2026-09-26T02:00:00.000Z");
	assert.equal(
		iso(one as Parameters<typeof iso>[0]),
		"2026-09-26T12:00:00+10:00",
	);
	assert.equal(one?.address, "House Conspiracy, 36 Mary St");
	assert.equal(one?.url, "https://houseconspiracy.org/claudia");
	assert.equal(byId.get("allday")?.startRaw, "2026-09-30");
	assert.equal(byId.has("gone"), false);
	const weekly = r?.events
		.filter((e) => e.sourceEventId?.startsWith("weekly@"))
		.map((e) => `${e.title} ${e.startRaw}`);
	// Expanded from 2021 to the window only; the EXDATE is honoured and the
	// overridden occurrence carries its own time and title. Fridays 2 Oct–13 Nov.
	assert.equal(weekly?.[0], "Life drawing (late) 2026-10-02T10:00:00.000Z");
	assert.equal(
		weekly?.includes("Life drawing 2026-09-25T09:00:00.000Z"),
		false,
	);
	assert.equal(weekly?.length, 7);
});

test("a body that is not a VCALENDAR is not claimed as iCal", () => {
	assert.equal(parseIcal("<html>BEGIN:VCALENDAR</html>"), null);
});

test("Trumba links prefer the organiser's page, then the booking page", () => {
	const ev = (extra: Record<string, unknown>) => ({
		eventID: 208992655,
		title: "Brisbane Illustration Fair",
		startDateTime: "2026-10-03T10:00:00",
		startTimeZoneOffset: "+1000",
		permaLinkUrl:
			"https://www.brisbane.qld.gov.au/trumba?trumbaEmbed=view%3Devent%26eventid%3D208992655",
		...extra,
	});
	const url = "https://www.trumba.com/calendars/brisbane-city-council.json";
	const links = parseFeed(
		JSON.stringify([
			ev({
				webLink:
					'<a href="https://brisbaneillustrationfair.square.site/" target="_blank" rel="noopener">brisbaneillustrationfair.square.site</a>',
				customFields: [
					{
						label: "Bookings",
						value: '<a href="https://www.eventbrite.com.au/e/1">Eventbrite</a>',
					},
				],
			}),
			ev({
				customFields: [
					{
						label: "Bookings",
						value:
							'Email <a href="mailto:x@y.z">us</a> or book via <a href="https://bookwhen.com/x?a=1&amp;b=2">Bookwhen</a>.',
					},
				],
			}),
			ev({
				customFields: [{ label: "Bookings", value: "No bookings required" }],
			}),
			ev({
				description:
					'<p>At <a href="https://maps.google.com/?q=x">the hall</a>. For more information, see <a href="https://nscf.org.au/gala">NSCF</a>.</p>',
				customFields: [{ label: "Bookings", value: "No bookings required" }],
			}),
			ev({
				description:
					'See <a href="https://nscf.org.au/gala">NSCF</a>. Directions: <a href="https://goo.gl/maps/abc">map</a>',
				customFields: [
					{
						label: "Bookings",
						value: '<a href="https://www.eventbrite.com.au/e/2">Eventbrite</a>',
					},
				],
			}),
			ev({
				description: 'Directions: <a href="https://goo.gl/maps/abc">map</a>',
			}),
			ev({
				description: 'Details at <a href="https://nscf.org.au/gala">NSCF</a>.',
				customFields: [
					{
						label: "Bookings",
						value:
							'Book at <a href="https://events.brisbane.qld.gov.au/">Council</a>',
					},
				],
			}),
		]),
		url,
	)?.events.map((e) => e.url);
	assert.deepEqual(links, [
		"https://brisbaneillustrationfair.square.site/",
		// mailto: skipped, entities decoded.
		"https://bookwhen.com/x?a=1&b=2",
		"https://www.trumba.com/calendars/brisbane-city-council?eventid=208992655",
		// No webLink or booking link: the description's, skipping Google Maps.
		"https://nscf.org.au/gala",
		// A booking link beats the description's.
		"https://www.eventbrite.com.au/e/2",
		// Only a map link: falls through to Trumba's page.
		"https://www.trumba.com/calendars/brisbane-city-council?eventid=208992655",
		// The council booking portal's front page is not the event.
		"https://nscf.org.au/gala",
	]);
});

test("Trumba Atom takes the booking link from gc:bookings", () => {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns:gd="http://schemas.google.com/g/2005" xmlns:x-trumba="http://schemas.trumba.com/atom/x-trumba" xmlns="http://www.w3.org/2005/Atom">
	<entry>
		<id>http://uid.trumba.com/event/1</id>
		<title type="text">Kayak tour</title>
		<gd:when startTime="2026-09-26T21:00:00Z" />
		<gc:bookings type="string">Book via &lt;a href="https://bookeo.com/kayak"&gt;Bookeo&lt;/a&gt;</gc:bookings>
	</entry>
</feed>`;
	const r = parseFeed(
		body,
		"https://www.trumba.com/calendars/brisbane-events-rss.xml?filterview=parks",
	);
	assert.equal(r?.events[0]?.url, "https://bookeo.com/kayak");
});

// Trimmed from data.brisbane.qld.gov.au's riverstage-events dataset.
test("Opendatasoft records parse deterministically, with the ticketing link", () => {
	const body = JSON.stringify({
		nhits: 1,
		parameters: { dataset: "riverstage-events" },
		records: [
			{
				recordid: "abc",
				fields: {
					subject: "Ashnikko - Smoochies Tour",
					start_datetime: "2026-09-25T18:00:00+10:00",
					end_datetime: "2026-09-25T22:00:00+10:00",
					venue: "Riverstage, Brisbane City",
					venueaddress: "Riverstage, Gardens Point Road, Brisbane City",
					cost: "See website for ticket prices",
					primaryeventtype: "Music",
					web_link:
						"https://www.brisbane.qld.gov.au/trumba?trumbaEmbed=view%3Devent%26eventid%3D191635791",
					bookings:
						'Bookings are required via <a href="https://www.ticketmaster.com.au/ashnikko/event/1300632FD4695702" target="_blank">Ticketmaster</a>.',
				},
			},
		],
	});
	const r = parseFeed(
		body,
		"https://data.brisbane.qld.gov.au/api/records/1.0/search/?dataset=riverstage-events",
	);
	assert.equal(r?.format, "opendatasoft");
	const e = r?.events[0];
	assert.equal(e?.title, "Ashnikko - Smoochies Tour");
	assert.equal(
		e?.url,
		"https://www.ticketmaster.com.au/ashnikko/event/1300632FD4695702",
	);
	assert.equal(
		iso(e as Parameters<typeof iso>[0]),
		"2026-09-25T18:00:00+10:00",
	);
	assert.equal(e?.venueName, "Riverstage, Brisbane City");
});
