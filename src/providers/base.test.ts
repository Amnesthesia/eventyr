import assert from "node:assert/strict";
import { test } from "node:test";
import type { CityConfig } from "../common.ts";
import type { ProviderOptions, SearchResult } from "./base.ts";
import { BaseProvider, selectTiers } from "./base.ts";

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

class TestProvider extends BaseProvider {
	readonly name = "test";
	readonly tiers = ["institutions", "independents"] as const;
	async searchEvents(): Promise<SearchResult> {
		return { events: [] };
	}
	buildTierUserPublic(opts: ProviderOptions): string {
		return this.buildTierUser(opts);
	}
}

function optsFor(
	tier: string,
	sources: CityConfig["sources"],
): ProviderOptions {
	return {
		city: "test",
		cityCfg: { name: "Testville", sources },
		tier,
		weekStart: new Date("2026-09-21"),
		weekEnd: new Date("2026-09-27"),
		curate: async () => [],
	};
}

test("a pinned venue gets a firmer sentence than the generic steer", () => {
	const provider = new TestProvider();
	const sources = {
		aggregators: [],
		institutions: [
			{
				name: "Quiet Concert Hall",
				method: "llm" as const,
				domains: ["quiethall.com"],
				pin: true,
			},
			{ name: "Regular Museum", method: "llm" as const, domains: ["m.com"] },
		],
		independents: [],
	};
	const prompt = provider.buildTierUserPublic(optsFor("institutions", sources));
	assert.match(
		prompt,
		/Check these venues' own listings directly and include every confirmed event this week, even a single show: Quiet Concert Hall/,
	);
	// The unpinned venue still gets the softer "steer, not checklist" sentence.
	assert.match(
		prompt,
		/Venues that have listed relevant events before include: Regular Museum/,
	);
});
