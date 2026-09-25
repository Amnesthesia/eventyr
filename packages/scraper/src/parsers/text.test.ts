import assert from "node:assert/strict";
import { test } from "node:test";
import { countDateHits } from "./dates.ts";
import { densestWindow } from "./readableText.ts";

test("the densest window beats the first window", () => {
	// The measured failure: long listing pages open with nav, hero copy and
	// editorial, and the dated listing starts well past the cutoff.
	// classbento.com.au had 3832 date-shaped fragments and none in its first
	// 12 KB, so reading from position 0 saw an empty page.
	const filler = `${"About us and our story. ".repeat(400)}\n\n`;
	const listing = Array.from(
		{ length: 40 },
		(_, i) => `Pottery Class — 12 September 2026 at 6pm (event ${i})`,
	).join("\n\n");
	const text = filler + listing;

	assert.equal(
		countDateHits(text.slice(0, 2000)),
		0,
		"first window is dateless",
	);
	assert.ok(
		countDateHits(densestWindow(text, 2000)) > 0,
		"densest window finds the listing",
	);
});

test("text shorter than the window is returned whole", () => {
	assert.equal(densestWindow("21 September 2026", 12000), "21 September 2026");
});

test("the window is bounded to the requested size", () => {
	const text = `${"20 September 2026. ".repeat(2000)}`;
	assert.ok(densestWindow(text, 1000).length <= 1000);
});

test("the densest window is never worse than the first window", () => {
	// Regression guard: snapping the start to a paragraph break pushes the same
	// number of characters off the end, which silently cost theurbanlist's
	// what's-on page one of its date hits (15 → 14). Whatever this returns, it
	// must not be beaten by simply reading from the top.
	const cases = [
		`${"Intro copy. ".repeat(100)}\n\n${"Gig on 3 October 2026. ".repeat(50)}`,
		`${"Show on 4 November 2026. ".repeat(50)}\n\n${"Footer nav. ".repeat(200)}`,
		"No dates here at all, just prose. ".repeat(300),
	];
	for (const text of cases) {
		assert.ok(
			countDateHits(densestWindow(text, 2000)) >=
				countDateHits(text.slice(0, 2000)),
		);
	}
});
