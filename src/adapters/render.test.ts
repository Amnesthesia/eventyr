import assert from "node:assert/strict";
import { test } from "node:test";
import { countRenderedDateHits, looksEventish } from "./render.ts";

test("only date-bearing JSON responses count as an event API", () => {
	// The page's own XHR is how the API behind a client-rendered calendar or a
	// "load more" button becomes visible — embeddedJson.ts documents post-load
	// XHR as out of scope, and this is the signal that closes that gap. It has
	// to be narrow: every site fetches analytics and config JSON too.
	assert.ok(
		looksEventish(
			JSON.stringify([{ title: "Gig", start_date: "2026-09-09 19:00:00" }]),
		),
	);
	assert.ok(
		looksEventish(JSON.stringify({ events: [{ startDate: 1757314800000 }] })),
	);

	// A date-shaped key with no actual date, and config/analytics payloads.
	assert.ok(!looksEventish(JSON.stringify({ start_date: "soon" })));
	assert.ok(!looksEventish(JSON.stringify({ consent: true, gtm: "GTM-XYZ" })));
	assert.ok(!looksEventish("{}"));
	assert.ok(!looksEventish(""));
});

test("rendered text is scored for date-shaped content", () => {
	// This is what tells a defeated wall from an empty page: beachhotel served
	// 76 characters and zero date hits until it was rendered.
	assert.equal(countRenderedDateHits("Nothing on here at all"), 0);
	assert.ok(
		countRenderedDateHits("Trivia Tue 9, Comedy 12 Sep, Gig Sat 13") >= 3,
	);
});
