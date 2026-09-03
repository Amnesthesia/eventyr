import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import {
	haystackFor,
	matchesQuery,
	normalise,
	queryTokens,
	withinOneEdit,
} from "./search";

function ev(partial: Partial<Event>): Event {
	return {
		title: "",
		datetime: "",
		location: "",
		link: "",
		category: "Community / Other",
		cost: "",
		source: "",
		description: "",
		tags: [],
		score: 5,
		datetime_iso: "",
		datetime_end_iso: "",
		image: "",
		...partial,
	};
}

const match = (e: Event, q: string) => matchesQuery(e, queryTokens(q));

test("normalise folds case, diacritics and punctuation", () => {
	assert.equal(normalise("Café  Cabaret!"), "cafe cabaret");
	assert.equal(normalise("Henson’s — Jim"), "henson s jim");
});

test("a diacritic does not have to be typed", () => {
	assert.ok(match(ev({ title: "Café Cabaret" }), "cafe"));
});

test("tokens match in any order and across fields", () => {
	const e = ev({ title: "Twilight Market", location: "West End" });
	assert.ok(match(e, "market west"));
	assert.ok(match(e, "west market"));
	// Every token has to match: this narrows to nothing.
	assert.equal(match(e, "market rome"), false);
});

test("tags, category, source and description are searchable", () => {
	const e = ev({
		title: "Untitled",
		tags: ["pottery"],
		category: "Workshop / Class",
		source: "Netherworld",
		description: "an evening of pinball",
	});
	for (const q of ["pottery", "workshop", "netherworld", "pinball"]) {
		assert.ok(match(e, q), q);
	}
});

test("a single typo still finds the event", () => {
	const e = ev({ title: "Pinball Tournament" });
	assert.ok(match(e, "pinbal"), "deletion");
	assert.ok(match(e, "pinballl"), "insertion");
	assert.ok(match(e, "pinbell"), "substitution");
	// Two edits is not a typo any more, it is a different word.
	assert.equal(match(e, "pinbxxl"), false);
});

test("short tokens are exact, so they do not match everything", () => {
	// At three characters "one edit away" covers most of the alphabet, which
	// would make a short query useless.
	const e = ev({ title: "Jazz Night" });
	assert.ok(match(e, "jaz"));
	assert.equal(match(e, "cat"), false);
});

test("an empty query matches everything", () => {
	assert.ok(match(ev({ title: "anything" }), ""));
	assert.ok(match(ev({ title: "anything" }), "   "));
});

test("withinOneEdit covers all four single-edit kinds, and stops there", () => {
	assert.ok(withinOneEdit("market", "market"), "identical");
	assert.ok(withinOneEdit("market", "markt"), "deletion");
	assert.ok(withinOneEdit("market", "markett"), "insertion");
	assert.ok(withinOneEdit("market", "marxet"), "substitution");
	// The typo people actually make. Two substitutions under plain
	// Levenshtein, so it needs handling of its own.
	assert.ok(withinOneEdit("market", "marekt"), "transposition");
	assert.equal(withinOneEdit("market", "mrkt"), false, "two deletions");
	assert.equal(withinOneEdit("market", "marxyt"), false, "two substitutions");
});

test("a transposed query still finds the event", () => {
	assert.ok(match(ev({ title: "Twilight Market" }), "marekt"));
});

test("haystackFor includes every searchable field once", () => {
	const h = haystackFor(
		ev({
			title: "A",
			location: "B",
			source: "C",
			tags: ["D"],
			description: "E",
		}),
	);
	for (const part of ["a", "b", "c", "d", "e"])
		assert.ok(h.includes(part), part);
});
