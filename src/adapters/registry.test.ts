import assert from "node:assert/strict";
import { test } from "node:test";
import { llmSourceStrings, loadCityConfig, scraperSources } from "../common.ts";
import { loadSourceRegistry, venueNameFor } from "./registry.ts";

const CITIES = ["brisbane", "goldcoast", "sunnycoast"];

test("every city file parses and declares a valid method for every source", () => {
	for (const city of CITIES) {
		const cfg = loadCityConfig(city);
		assert.ok(cfg.name, `${city} has a name`);
		for (const tier of [
			"aggregators",
			"institutions",
			"independents",
		] as const) {
			const entries = cfg.sources[tier];
			assert.ok(Array.isArray(entries), `${city}.${tier} is an array`);
			assert.ok(entries.length > 0, `${city}.${tier} is non-empty`);
			for (const e of entries) {
				assert.ok(e.name, `${city}.${tier} entry has a name`);
				assert.ok(
					e.method === "llm" || e.method === "scraper",
					`${city}: "${e.name}" has method llm|scraper, got ${e.method}`,
				);
			}
		}
	}
});

test("llmSourceStrings renders prose the search prompts can use", () => {
	const cfg = loadCityConfig("brisbane");
	const strings = llmSourceStrings(cfg, "aggregators");
	assert.ok(strings.length > 0);
	// "Name (domain)" — the shape the prompt builders were written against
	assert.ok(
		strings.some((s) => /\(.+\..+\)$/.test(s.text)),
		"at least one entry carries its domain",
	);
	// a scraper-backed source must never be handed to the search prompts
	const scraperNames = new Set(
		scraperSources(cfg).map(({ entry }) => entry.name),
	);
	for (const s of strings) {
		for (const name of scraperNames) {
			assert.ok(
				!s.text.startsWith(name),
				`${name} is scraped, should not be searched`,
			);
		}
	}
});

test("loadSourceRegistry resolves only scraper sources, with defaults filled", () => {
	for (const city of CITIES) {
		const sources = loadSourceRegistry(city);
		const expected = scraperSources(loadCityConfig(city)).length;
		assert.equal(sources.length, expected);
		for (const s of sources) {
			assert.ok(s.id, "resolved source has an id");
			assert.ok(s.listingUrls.length > 0, `${s.id} has listing URLs`);
			assert.ok(
				["aggregators", "institutions", "independents"].includes(s.sourceTier),
				`${s.id} carries its tier`,
			);
			assert.ok(s.venue, `${s.id} has a venue record`);
			assert.ok(s.strategy, `${s.id} has a strategy`);
		}
	}
});

test("a scraper source that returned nothing falls back to the AI search", () => {
	const cfg = {
		name: "Test",
		sources: {
			aggregators: [],
			institutions: [
				{
					name: "Working Venue",
					method: "scraper" as const,
					domains: ["a.com"],
				},
				{
					name: "Rotted Venue",
					method: "scraper" as const,
					domains: ["b.com"],
				},
				{ name: "Searched Venue", method: "llm" as const, domains: ["c.com"] },
			],
			independents: [],
		},
	};
	// With no barren file, only llm sources are searched.
	const searched = llmSourceStrings(cfg, "institutions");
	assert.deepEqual(searched, [
		{ text: "Searched Venue (c.com)", pinned: false },
	]);
});

test("a pinned llm source is marked pinned in the prompt names", () => {
	const cfg = {
		name: "Test",
		sources: {
			aggregators: [],
			institutions: [
				{
					name: "Quiet Venue",
					method: "llm" as const,
					domains: ["quiet.com"],
					pin: true,
				},
				{ name: "Regular Venue", method: "llm" as const, domains: ["r.com"] },
			],
			independents: [],
		},
	};
	const searched = llmSourceStrings(cfg, "institutions");
	assert.deepEqual(searched, [
		{ text: "Quiet Venue (quiet.com)", pinned: true },
		{ text: "Regular Venue (r.com)", pinned: false },
	]);
});

test("a site already scraped is not also named in the search prompts", () => {
	// The same source gets listed twice under domain variants —
	// discover-sources adds `eventfinda.com.au` beside an existing
	// `brisbane.eventfinda.com.au` — and promotion only touches the entry it
	// verified, leaving the twin on `llm`. The twin then named an
	// already-scraped site in the prompts: budget spent rediscovering events we
	// hold exact data for, plus duplicates for dedupe to clean up.
	const cfg = {
		name: "Test",
		sources: {
			aggregators: [
				{
					name: "Eventfinda Test",
					method: "scraper" as const,
					domains: ["test.eventfinda.com.au"],
					listingUrls: ["https://test.eventfinda.com.au/whatson"],
				},
				// Same site, different host, still on llm.
				{
					name: "Eventfinda Test",
					method: "llm" as const,
					domains: ["eventfinda.com.au"],
				},
				{
					name: "Unrelated Blog",
					method: "llm" as const,
					domains: ["someblog.com.au"],
				},
			],
			institutions: [],
			independents: [],
		},
	};
	const strings = llmSourceStrings(cfg, "aggregators");
	assert.deepEqual(strings, [
		{ text: "Unrelated Blog (someblog.com.au)", pinned: false },
	]);
});

test("only a single-venue source lends its own name as the venue", () => {
	const entry = { name: "WeekendNotes Brisbane", method: "scraper" as const };
	assert.equal(venueNameFor(entry, "aggregators"), null);
	assert.equal(venueNameFor(entry, "independents"), "WeekendNotes Brisbane");
	assert.equal(
		venueNameFor({ ...entry, venue: { name: null } }, "institutions"),
		null,
	);
	assert.equal(
		venueNameFor({ ...entry, venue: { name: "Riverstage" } }, "aggregators"),
		"Riverstage",
	);
});
