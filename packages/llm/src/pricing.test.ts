import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateUsd, PRICES } from "./pricing.ts";

test("estimateUsd prices uncached and cached tokens differently", () => {
	const cheap = estimateUsd("claude-sonnet-5", {
		promptTokens: 1_000_000,
		cachedTokens: 1_000_000,
		outputTokens: 0,
	});
	const full = estimateUsd("claude-sonnet-5", {
		promptTokens: 1_000_000,
		cachedTokens: 0,
		outputTokens: 0,
	});
	assert.ok(cheap < full, "a fully cached call must cost less than a cold one");
});

test("estimateUsd bills search queries as a flat per-query fee", () => {
	const withSearch = estimateUsd("claude-sonnet-5", { searchQueries: 3 });
	const without = estimateUsd("claude-sonnet-5", { searchQueries: 0 });
	assert.ok(withSearch > without);
});

test("estimateUsd returns 0 for an unpriced model rather than throwing", () => {
	assert.equal(estimateUsd("some-future-model", { promptTokens: 1000 }), 0);
});

test("batch pricing is half the standard row for every model with one", () => {
	const u = {
		promptTokens: 2_000_000,
		cachedTokens: 500_000,
		cacheWriteTokens: 500_000,
		outputTokens: 1_000_000,
	};
	for (const [model, price] of Object.entries(PRICES)) {
		if (!("batch" in price)) continue;
		assert.equal(estimateUsd(model, u, true), estimateUsd(model, u) / 2, model);
	}
	// A model without a batch row costs the same either way rather than 0.
	assert.equal(estimateUsd("sonar-pro", u, true), estimateUsd("sonar-pro", u));
});
