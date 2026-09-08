import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSuggestionLines } from "./discover.ts";

test("parses Name|domain lines and applies the niche's tier", () => {
	const out = parseSuggestionLines(
		"Big Fork Theatre|bigforktheatre.com\nThe Sit Down Comedy Club|standup.com.au",
		"independents",
	);
	assert.equal(out.length, 2);
	assert.deepEqual(out[0], {
		name: "Big Fork Theatre",
		host: "bigforktheatre.com",
		tier: "independents",
	});
	assert.equal(out[1].tier, "independents");
});

test("normalises hosts and tolerates list markers the model was told not to add", () => {
	const out = parseSuggestionLines(
		"1. Metro Arts|https://www.metroarts.com.au/whats-on\n-.  Doo-Bop|DOO-BOP.COM.AU",
		"independents",
	);
	assert.deepEqual(
		out.map((s) => [s.name, s.host]),
		[
			["Metro Arts", "metroarts.com.au"],
			["Doo-Bop", "doo-bop.com.au"],
		],
	);
});

test("drops login-walled hosts, bare labels and malformed lines", () => {
	const out = parseSuggestionLines(
		[
			"Here are the venues I found:", // prose, no pipe
			"Another|facebook.com", // login-walled
			"Bio|linktr.ee", // link-in-bio, never a listing
			"Broken|localhost", // no dot
			"|nohost.com", // no name
			"No Domain|", // no host
			"Real Venue|realvenue.com.au",
		].join("\n"),
		"institutions",
	);
	assert.deepEqual(
		out.map((s) => s.host),
		["realvenue.com.au"],
	);
	assert.equal(out[0].tier, "institutions");
});

test("ticketing aggregators are no longer filtered out in advance", () => {
	// They used to be dropped on the untested assumption that their listings
	// are all login-gated. When that was actually measured, feverup.com yielded
	// 120 candidates through the ordinary ladder. Whether one works is probe's
	// call, made on extracted events, not a regex's call made in advance.
	const out = parseSuggestionLines(
		["A|eventbrite.com.au", "B|humanitix.com", "C|moshtix.com.au"].join("\n"),
		"aggregators",
	);
	assert.deepEqual(
		out.map((s) => s.host),
		["eventbrite.com.au", "humanitix.com", "moshtix.com.au"],
	);
});
