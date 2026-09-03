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

test("drops platforms, bare labels and malformed lines", () => {
	const out = parseSuggestionLines(
		[
			"Here are the venues I found:", // prose, no pipe
			"Some Venue|eventbrite.com.au", // ticketing platform
			"Another|facebook.com", // social
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
