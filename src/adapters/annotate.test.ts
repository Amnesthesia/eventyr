import assert from "node:assert/strict";
import { test } from "node:test";
import {
	annotationKey,
	isRetiredTemplateDescription,
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
	// No text for the classification to have been made against, so nothing to
	// mismatch. The classification is reused; no description is invented.
	const previous = event({ description: "Last week's page description." });
	const current = event({ description: "" });
	const reused = reuseAnnotation(current, previous);
	assert.ok(reused);
	assert.equal(reused?.category, "Concert / Music");
	assert.equal("description" in (reused ?? {}), false);
});

test("reuseAnnotation returns null with nothing to reuse from", () => {
	assert.equal(reuseAnnotation(event(), undefined), null);
});

test("reuseAnnotation returns null when the previous record has no valid category", () => {
	const previous = event({ category: "Not A Real Category" });
	assert.equal(reuseAnnotation(event(), previous), null);
});

function described(
	title: string,
	description: string,
): Record<string, unknown> {
	return { title, description };
}

test("the retired annotate template is recognised", () => {
	for (const [title, description] of [
		[
			"The Spyro Experiment",
			"The Spyro Experiment is a comedy event held at Good Chat Comedy Club.",
		],
		[
			"Sunday Social",
			"Sunday Social is a social event held at South Bank Parklands.",
		],
		[
			"Richard Dunn",
			"Richard Dunn is an Arts / Exhibition event at QAG, Stanley Place, South Bank.",
		],
		["Aria Cook", "Aria Cook is a concert at Eat Street Northshore."],
	]) {
		assert.equal(
			isRetiredTemplateDescription(described(title, description)),
			true,
			description,
		);
	}
});

test("real page copy is never mistaken for the template", () => {
	for (const [title, description] of [
		// Opens with the title and says "is a", but is the venue's own copy.
		[
			"DAYBREAKER",
			"DAYBREAKER is a global, alcohol-free morning dance and wellness event that combines yoga, fitness, and high-energy dance to start the day with joy and community.",
		],
		[
			"Shel We",
			"Delight in this upbeat, full of mischief enchanting dance style.",
		],
		[
			"Pony Club",
			"Pony Club is commissioned and developed through Observatory Theatre's Telescope New Writing Program, with support from Arts Queensland and the Australia Council.",
		],
		["Gig Night", ""],
	]) {
		assert.equal(
			isRetiredTemplateDescription(described(title, description)),
			false,
			description,
		);
	}
});

test("an event with no title cannot match", () => {
	assert.equal(
		isRetiredTemplateDescription(
			described("", " is a comedy event held at X."),
		),
		false,
	);
});
