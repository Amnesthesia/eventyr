import assert from "node:assert/strict";
import { test } from "node:test";
import {
	annotationKey,
	previousAnnotationIndex,
	reuseAnnotation,
} from "./annotate.ts";

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		title: "Gig Night",
		datetime_iso: "2026-09-09T19:00:00",
		location: "The Tivoli",
		description: "A night of live music.",
		category: "Concert / Music",
		tags: ["music"],
		social: true,
		intellectual: false,
		hands_on: false,
		creative: true,
		...over,
	};
}

test("annotationKey identifies an event by title, start and venue", () => {
	assert.equal(annotationKey(event()), annotationKey(event()));
	assert.notEqual(
		annotationKey(event()),
		annotationKey(event({ location: "The Zoo" })),
	);
});

test("previousAnnotationIndex looks events up by their identity key", () => {
	const prev = [event(), event({ title: "Other Gig" })];
	const index = previousAnnotationIndex(prev);
	assert.equal(index.get(annotationKey(event())), prev[0]);
	assert.equal(index.size, 2);
});

test("reuseAnnotation lifts the judgement fields when the page description is unchanged", () => {
	const previous = event();
	const current = event(); // same description as last time
	const reused = reuseAnnotation(current, previous);
	assert.ok(reused);
	assert.equal(reused?.category, "Concert / Music");
	assert.deepEqual(reused?.tags, ["music"]);
	assert.equal(reused?.social, true);
	assert.equal(
		reused?.drop,
		false,
		"a reused annotation never re-drops an event",
	);
});

test("reuseAnnotation refuses to reuse when the page's own description changed", () => {
	const previous = event({ description: "Old description." });
	const current = event({ description: "New description." });
	assert.equal(reuseAnnotation(current, previous), null);
});

test("reuseAnnotation accepts when the current page has no description at all", () => {
	// This is the case where the model wrote the description last time — exactly
	// what should be kept, not treated as a mismatch.
	const previous = event({ description: "Model-written description." });
	const current = event({ description: "" });
	const reused = reuseAnnotation(current, previous);
	assert.ok(reused);
	assert.equal(reused?.description, "Model-written description.");
});

test("reuseAnnotation returns null with nothing to reuse from", () => {
	assert.equal(reuseAnnotation(event(), undefined), null);
});

test("reuseAnnotation returns null when the previous record has no valid category", () => {
	const previous = event({ category: "Not A Real Category" });
	assert.equal(reuseAnnotation(event(), previous), null);
});
