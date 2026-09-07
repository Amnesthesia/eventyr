import assert from "node:assert/strict";
import { test } from "node:test";
import { selectTiers } from "./base.ts";

const TIERS = ["aggregators", "institutions", "independents", "open"] as const;

test("selectTiers keeps every tier when no env var is set", () => {
	assert.deepEqual(selectTiers("anthropic", TIERS, {}), [...TIERS]);
});

test("selectTiers filters to the named tiers, in the provider's own order", () => {
	const result = selectTiers("anthropic", TIERS, {
		ANTHROPIC_TIERS: "institutions,aggregators",
	});
	assert.deepEqual(result, ["aggregators", "institutions"]);
});

test("selectTiers is keyed per provider name, uppercased", () => {
	const result = selectTiers("openai", TIERS, {
		ANTHROPIC_TIERS: "aggregators",
		OPENAI_TIERS: "open",
	});
	assert.deepEqual(result, ["open"]);
});

test("selectTiers ignores blank entries and whitespace", () => {
	const result = selectTiers("anthropic", TIERS, {
		ANTHROPIC_TIERS: " aggregators ,, institutions ",
	});
	assert.deepEqual(result, ["aggregators", "institutions"]);
});

test("selectTiers with an empty value drops every tier rather than keeping all", () => {
	// A tier list a provider does not run at all — distinct from "unset".
	const result = selectTiers("anthropic", TIERS, { ANTHROPIC_TIERS: "" });
	assert.deepEqual(result, [...TIERS], "an empty string is treated as unset");
});
