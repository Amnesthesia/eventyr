import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventData } from "@dothingslol/core/schema";
import { tagWeight, tagWeights } from "./tagSpecificity";

function ev(tags: string[]): EventData {
	return {
		title: "",
		datetime: "",
		location: "",
		link: "",
		category: "",
		cost: "",
		source: "",
		description: "",
		tags,
		score: 5,
		datetime_iso: "",
		datetime_end_iso: "",
		image: "",
		social: false,
		intellectual: false,
		hands_on: false,
		creative: false,
		venue: "",
	};
}

test("a rarer tag outweighs a commoner one", () => {
	const events = [
		ev(["music", "shoegaze"]),
		ev(["music"]),
		ev(["music"]),
		ev(["music"]),
		ev(["comedy"]),
	];
	const weights = tagWeights(events);
	assert.ok(
		weights.shoegaze > weights.music,
		`shoegaze (${weights.shoegaze}) should outweigh music (${weights.music})`,
	);
});

test("every weight stays within [MIN_WEIGHT, 1]", () => {
	const events = Array.from({ length: 50 }, (_, i) =>
		ev(i === 0 ? ["rare"] : ["common"]),
	);
	const weights = tagWeights(events);
	for (const w of Object.values(weights)) {
		assert.ok(w > 0 && w <= 1, `weight ${w} out of range`);
	}
	assert.equal(weights.rare, 1);
});

test("an unseen tag defaults to fully specific", () => {
	const weights = tagWeights([ev(["music"])]);
	assert.equal(tagWeight("never-seen", weights), 1);
});

test("a single-event city assigns no weights", () => {
	assert.deepEqual(tagWeights([ev(["music"])]), {});
});
