import assert from "node:assert/strict";
import { test } from "node:test";
import {
	byScoreThenSoonest,
	costLabel,
	eventHash,
	eventPath,
	eventSlug,
	isCurrencyCode,
	normaliseCurrency,
	slugify,
	stripForDisplay,
} from "./shared.ts";

const DICE = {
	title: "Dice Rolls & Flagons – Casual Board Game Meetup",
	datetime_iso: "2026-09-06T14:00:00",
	location: "Netherworld, Fortitude Valley",
};

test("eventHash output is frozen", () => {
	// These are the values ical.ts's uidFor and rss.ts's guidFor produced before
	// the two inline copies were replaced by this function, derived
	// independently rather than captured from it.
	//
	// If this test fails, the change rewrites every iCal UID and every RSS guid
	// at once: calendar clients re-add all 643 events and feed readers
	// re-notify on all of them. That is the cost, and it is only ever worth
	// paying deliberately — never as a side effect of tidying this function.
	assert.equal(eventHash("brisbane", DICE), "b8wguc");
	assert.equal(
		eventHash("goldcoast", {
			title: "Trivia Night",
			datetime_iso: "2026-09-08",
			location: "Home of the Arts, Bundall",
		}),
		"180ed8d",
	);
});

test("the venue is part of the identity", () => {
	// Generic titles repeat across venues on the same night — "Live Music"
	// appeared five times on one date at five different pubs. Without the
	// location in the basis those share an id, and a calendar client shows one
	// event and silently drops four.
	const base = { title: "Live Music", datetime_iso: "2026-09-05T19:00:00" };
	const triffid = eventHash("brisbane", {
		...base,
		location: "The Triffid, Newstead",
	});
	const rics = eventHash("brisbane", {
		...base,
		location: "Ric's Bar, Fortitude Valley",
	});
	assert.equal(triffid, "nrxadx");
	assert.equal(rics, "68lwo1");
	assert.notEqual(triffid, rics);
});

test("the same event in two cities gets two ids", () => {
	assert.notEqual(eventHash("brisbane", DICE), eventHash("goldcoast", DICE));
});

test("a missing field is not a crash, and not a shared id", () => {
	assert.equal(typeof eventHash("brisbane", {}), "string");
	assert.notEqual(
		eventHash("brisbane", {}),
		eventHash("brisbane", { title: "x" }),
	);
	// A non-string value must not become "undefined" or "[object Object]" and
	// collide with a real event that happens to stringify the same way.
	assert.equal(eventHash("brisbane", { title: 42 }), eventHash("brisbane", {}));
});

test("slugify is URL-safe and bounded", () => {
	assert.equal(
		slugify("Dice Rolls & Flagons – Casual Board Game Meetup"),
		"dice-rolls-flagons-casual-board-game-meetup",
	);
	// Diacritics fold rather than vanish or escape.
	assert.equal(slugify("Café Cabaret"), "cafe-cabaret");
	assert.equal(
		slugify("GEED UP “The Worst Show Ever”"),
		"geed-up-the-worst-show-ever",
	);
	const long = slugify("word ".repeat(40));
	assert.ok(long.length <= 60, `${long.length} chars`);
	assert.ok(!long.endsWith("-"), "no trailing hyphen from the truncation");
	assert.match(long, /^[a-z0-9-]+$/);
});

test("eventSlug is readable, unique, and safe as a path segment", () => {
	assert.equal(
		eventSlug("brisbane", DICE),
		"dice-rolls-flagons-casual-board-game-meetup-b8wguc",
	);
	assert.match(eventSlug("brisbane", DICE), /^[a-z0-9-]+$/);
	// An untitled event still gets a usable segment rather than a leading dash.
	assert.equal(eventSlug("brisbane", {}), eventHash("brisbane", {}));
});

test("eventPath uses the public city slug, not the city key", () => {
	assert.equal(
		eventPath("goldcoast", DICE),
		`/gold-coast/e/${eventSlug("goldcoast", DICE)}/`,
	);
	assert.equal(
		eventPath("brisbane", DICE),
		"/brisbane/e/dice-rolls-flagons-casual-board-game-meetup-b8wguc/",
	);
});

test("a parenthesised URL is removed with its brackets and stranded full stop", () => {
	// readableText.ts keeps every <a href> as "label (resolved URL)" so the
	// extraction prompt can copy ticket links verbatim, which is how this
	// reaches a card. The link is already in event.link.
	assert.equal(
		stripForDisplay(
			"Book your place (https://events.humanitix.com/introduction-to-creative-writing) .",
		),
		"Book your place.",
	);
});

test("a bare URL is removed", () => {
	assert.equal(
		stripForDisplay("Tickets at https://oztix.com.au/abc today"),
		"Tickets at today",
	);
	assert.equal(
		stripForDisplay("See //example.com/x for details"),
		"See for details",
	);
});

test("a markdown link keeps its label and loses its URL", () => {
	assert.equal(
		stripForDisplay("Grab a [ticket here](https://example.com/t) now"),
		"Grab a ticket here now",
	);
});

test("markdown emphasis runs are stripped, single asterisks are not", () => {
	assert.equal(
		stripForDisplay("****Tickets go on sale**** Monday"),
		"Tickets go on sale Monday",
	);
	assert.equal(stripForDisplay("__Sold out__"), "Sold out");
	// A lone asterisk is part of real titles, so it stays.
	assert.equal(stripForDisplay("3 * 3 Exhibition"), "3 * 3 Exhibition");
});

test("heading and quote markers are stripped without eating the text", () => {
	assert.equal(
		stripForDisplay("## What's on\nGreat show"),
		"What's on Great show",
	);
	assert.equal(stripForDisplay("> A quote"), "A quote");
	// A hash that is not a heading marker survives.
	assert.equal(
		stripForDisplay("Stand #4 at the market"),
		"Stand #4 at the market",
	);
});

test("a description that was only a URL comes back empty, not as punctuation", () => {
	assert.equal(stripForDisplay("(https://example.com/x)"), "");
	assert.equal(stripForDisplay("https://example.com/x"), "");
});

test("ordinary prose is left alone", () => {
	const prose =
		"An exhibition celebrating strength, identity and individuality — free entry, 9:30 AM daily.";
	assert.equal(stripForDisplay(prose), prose);
});

test("scheme-less www URLs are stripped too", () => {
	assert.equal(
		stripForDisplay("Tickets at www.oztix.com.au/abc now"),
		"Tickets at now",
	);
	assert.equal(stripForDisplay("Details (www.venue.com/gigs) ."), "Details.");
	// A bare word.tld is left alone: matching those eats ordinary prose.
	assert.equal(stripForDisplay("see dothings.lol"), "see dothings.lol");
});

test("a broken or empty link is stripped, not left on the card", () => {
	// The extractor sometimes produces a truncated href or none at all.
	assert.equal(stripForDisplay("Tickets (https://)"), "Tickets");
	assert.equal(stripForDisplay("Tickets (https://..)"), "Tickets");
	assert.equal(
		stripForDisplay("Tickets here https:// today"),
		"Tickets here today",
	);
	// A markdown link whose target is not a URL still loses the target.
	assert.equal(
		stripForDisplay("Grab a [ticket](/broken/path) now"),
		"Grab a ticket now",
	);
	assert.equal(stripForDisplay("Grab a [ticket]() now"), "Grab a ticket now");
});

test("costLabel drops values that say neither a price nor free", () => {
	// "See link" is normalise.ts's fallback when a page gave no price, and it is
	// 294 of 643 events — a pill carrying it tells a reader nothing. The event
	// itself is never filtered out; only the badge goes.
	for (const v of [
		"See link",
		"See website",
		"Check website",
		"Check ticket price",
		"TBA",
		"TBC",
		"Unknown",
		"Not specified",
		"Price on application",
		"Buy Tickets",
		"Ticketed",
		"n/a",
		"—",
		"",
		"   ",
	]) {
		assert.equal(costLabel(v), null, JSON.stringify(v));
	}
	assert.equal(costLabel(undefined), null);
	assert.equal(costLabel(42), null);
});

test("costLabel says free however the source spelled it", () => {
	for (const v of [
		"Free",
		"FREE",
		"free entry",
		"$0",
		"0",
		"AUD 0",
		"AUD 0.00",
	]) {
		assert.equal(costLabel(v), "free", JSON.stringify(v));
	}
});

test("a single amount is formatted by Intl, not concatenated", () => {
	// "AUD 25" used to reach the card verbatim. en-AU renders AUD as "$".
	assert.equal(costLabel("AUD 25"), "$25");
	assert.equal(costLabel("AUD 12.50"), "$12.50");
	// A whole amount loses the pointless ".00"; real cents survive.
	assert.equal(costLabel("$10.00"), "$10");
	assert.equal(costLabel("$25"), "$25");
	// The locale decides the symbol and its placement, not us.
	assert.equal(
		costLabel("25", { locale: "de-DE", currency: "EUR" }),
		"25\u00a0€",
	);
	assert.equal(
		costLabel("USD 25", { locale: "en-US", currency: "USD" }),
		"$25",
	);
});

test("anything more complex than one amount is left verbatim", () => {
	// Reformatting these would lose the labels that make them useful.
	for (const v of [
		"$10 ONLINE | $15 ON THE DOOR",
		"$2–$12",
		"From $12",
		"Sold Out",
	]) {
		assert.equal(costLabel(v), v);
	}
});

test("a foreign currency code is corrected to the city's", () => {
	// The Cave Inn declares priceCurrency: "USD" on every event, which reached
	// the site as "USD 0". Every source in a city's list is a venue in that
	// city, so the code is wrong rather than the price.
	assert.equal(normaliseCurrency("USD 0", "AUD"), "AUD 0");
	assert.equal(normaliseCurrency("USD 25", "AUD"), "AUD 25");
	assert.equal(normaliseCurrency("usd 25", "AUD"), "AUD 25");
	// Already the city's currency, or no code at all: untouched.
	assert.equal(normaliseCurrency("AUD 20", "AUD"), "AUD 20");
	assert.equal(normaliseCurrency("$25", "AUD"), "$25");
	assert.equal(normaliseCurrency("Free", "AUD"), "Free");
	assert.equal(normaliseCurrency("", "AUD"), "");
	// A different city keeps its own currency rather than an AUD default.
	assert.equal(normaliseCurrency("AUD 30", "NZD"), "NZD 30");
});

test("only a real ISO code is treated as a currency", () => {
	// Asked of Intl rather than a hand-written list, so SGD and JPY count and
	// three letters that merely precede a number do not.
	assert.ok(isCurrencyCode("AUD"));
	assert.ok(isCurrencyCode("sgd"));
	assert.ok(isCurrencyCode("JPY"));
	assert.equal(isCurrencyCode("XYZ"), false);
	assert.equal(isCurrencyCode("ONL"), false);
	assert.equal(isCurrencyCode("AU"), false);
	// So a word that happens to sit before a number survives.
	assert.equal(normaliseCurrency("ONLINE 25", "AUD"), "ONLINE 25");
});

test("events order by score, then soonest first", () => {
	// The tiebreak was missing: four places sorted on score alone, and because
	// Array#sort is stable that left same-score events in whatever order dedupe
	// produced — a run of 8s could open with something ten days out while
	// tonight's sat below it.
	const events = [
		{ score: 8, datetime_iso: "2026-09-13T19:00:00", title: "late 8" },
		{ score: 9, datetime_iso: "2026-09-12T19:00:00", title: "late 9" },
		{ score: 8, datetime_iso: "2026-09-04T10:00:00", title: "soon 8" },
		{ score: 9, datetime_iso: "2026-09-03T10:00:00", title: "soon 9" },
	];
	assert.deepEqual(
		[...events].sort(byScoreThenSoonest).map((e) => e.title),
		["soon 9", "late 9", "soon 8", "late 8"],
	);
});

test("an undated event sinks to the bottom of its own score", () => {
	// Not treated as the epoch, which would float it to the top of its score.
	const events = [
		{ score: 8, datetime_iso: "" },
		{ score: 8, datetime_iso: "2026-09-10T19:00:00" },
		{ score: 9, datetime_iso: "" },
	];
	assert.deepEqual(
		[...events].sort(byScoreThenSoonest).map((e) => e.datetime_iso),
		["", "2026-09-10T19:00:00", ""],
	);
	// …and still below every dated event that shares its score.
	const sorted = [...events].sort(byScoreThenSoonest);
	assert.equal(sorted[0].score, 9);
	assert.equal(sorted[1].datetime_iso, "2026-09-10T19:00:00");
});

test("a missing or non-numeric score sorts last, not first", () => {
	const events = [
		{ datetime_iso: "2026-09-03T10:00:00" },
		{ score: 5, datetime_iso: "2026-09-09T10:00:00" },
		{ score: "8" as unknown, datetime_iso: "2026-09-04T10:00:00" },
	];
	const sorted = [...events].sort(byScoreThenSoonest);
	assert.equal(sorted[0].score, 5);
});
