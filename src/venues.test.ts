import assert from "node:assert/strict";
import { test } from "node:test";
import {
	aliasMap,
	numbersConflict,
	rawVenue,
	resolveVenues,
	VENUE_PROMPT_VERSION,
	type VenueCache,
	type VenueClassifyFn,
	venueKey,
} from "./venues.ts";

const emptyCache = (): VenueCache => ({
	prompt_version: VENUE_PROMPT_VERSION,
	map: {},
});

function run(
	counts: Record<string, number>,
	opts: {
		cache?: VenueCache;
		aliases?: Map<string, string>;
		classify?: VenueClassifyFn;
	} = {},
) {
	return resolveVenues({
		counts: new Map(Object.entries(counts)),
		samples: new Map(),
		cache: opts.cache ?? emptyCache(),
		cityName: "Brisbane",
		aliases: opts.aliases ?? new Map(),
		classify: opts.classify,
	});
}

test("rawVenue takes the first comma segment", () => {
	assert.equal(rawVenue("GOMA, Stanley Place, South Bank"), "GOMA");
	assert.equal(rawVenue("  The Cave Inn  "), "The Cave Inn");
	assert.equal(rawVenue(""), "");
	assert.equal(rawVenue(undefined), "");
	assert.equal(
		rawVenue("Level 1, 36 Scarborough Street"),
		"36 Scarborough Street",
	);
	assert.equal(
		rawVenue("Level 5 · The Exhibitionist Bar"),
		"The Exhibitionist Bar",
	);
	assert.equal(rawVenue("Level 5"), "Level 5");
});

test("numbersConflict vetoes merges across different numbers only", () => {
	assert.equal(numbersConflict("Level 5", "Level 1"), true);
	assert.equal(numbersConflict("HOTA Gallery 2", "HOTA Gallery"), false);
	assert.equal(
		numbersConflict("165 Duringan St", "165 Duringan Street"),
		false,
	);
});

test("venueKey ignores case, punctuation and a leading 'the'", () => {
	assert.equal(
		venueKey("The Fortitude Music Hall"),
		venueKey("fortitude music hall."),
	);
	assert.equal(venueKey("Felons Brewing Co."), "felons brewing co");
});

test("rules: city name is not a venue, acronym and spelling match known", async () => {
	const cache = emptyCache();
	cache.map["Queensland Art Gallery"] = "Queensland Art Gallery";
	cache.map["The Tivoli"] = "The Tivoli";
	const { resolved, stats } = await run(
		{ Brisbane: 3, QAG: 2, "the tivoli": 1 },
		{ cache },
	);
	assert.equal(resolved.get("Brisbane"), null);
	assert.equal(resolved.get("QAG"), "Queensland Art Gallery");
	assert.equal(resolved.get("the tivoli"), "The Tivoli");
	assert.equal(stats.rule, 3);
	assert.equal(stats.unresolved, 0);
});

test("aliases override the cache", async () => {
	const cache = emptyCache();
	cache.map.Powerhouse = "Powerhouse";
	const aliases = aliasMap([
		{ venue: { name: "Brisbane Powerhouse", aliases: ["Powerhouse"] } },
	]);
	const { resolved } = await run({ Powerhouse: 1 }, { cache, aliases });
	assert.equal(resolved.get("Powerhouse"), "Brisbane Powerhouse");
});

test("model merges are validated; the most common spelling names the group", async () => {
	const cache = emptyCache();
	cache.map.GOMA = "GOMA";
	const classify: VenueClassifyFn = async (known, batch) => {
		assert.deepEqual(known, ["GOMA"]);
		// By count, then name: Tivoli Theatre (5) comes before its typo (1).
		assert.deepEqual(
			batch.map((b) => b.name),
			[
				"Tivoli Theatre",
				"Gallery of Modern Art",
				"Bogus",
				"Tivoli Theatr",
				"WeekendNotes",
			],
		);
		return [
			{ i: 0, known: null, same_as: null, not_venue: false },
			{ i: 1, known: 0, same_as: null, not_venue: false },
			// Out-of-range known index and self same_as: ignored.
			{ i: 2, known: 9, same_as: 2, not_venue: false },
			{ i: 3, known: null, same_as: 0, not_venue: false },
			{ i: 4, known: null, same_as: null, not_venue: true },
			{ i: 99, known: 0, same_as: null, not_venue: false },
		];
	};
	const { resolved, stats } = await run(
		{
			"Tivoli Theatre": 5,
			"Gallery of Modern Art": 4,
			"Tivoli Theatr": 1,
			WeekendNotes: 1,
			Bogus: 1,
		},
		{ cache, classify },
	);
	assert.equal(resolved.get("Gallery of Modern Art"), "GOMA");
	assert.equal(resolved.get("Tivoli Theatr"), "Tivoli Theatre");
	assert.equal(resolved.get("WeekendNotes"), null);
	assert.equal(resolved.get("Bogus"), "Bogus");
	assert.equal(cache.map["Tivoli Theatr"], "Tivoli Theatre");
	assert.equal(stats.model, 5);
	assert.equal(stats.venues, 3); // Tivoli Theatre, GOMA, Bogus
});

test("a failed model call caches nothing and counts as unresolved", async () => {
	const cache = emptyCache();
	const { resolved, stats } = await run(
		{ "Some Bar": 2 },
		{ cache, classify: async () => null },
	);
	assert.equal(resolved.get("Some Bar"), "Some Bar");
	assert.equal(stats.unresolved, 1);
	assert.equal("Some Bar" in cache.map, false);
});

test("a shorter prefix renames the venue; a mere substring does not", async () => {
	const cache = emptyCache();
	cache.map["HOTA Lake Precinct"] = "HOTA Lake Precinct";
	cache.map["Ipswich Art Gallery"] = "Ipswich Art Gallery";
	const classify: VenueClassifyFn = async (known, batch) =>
		batch.map((b, i) => ({
			i,
			known: known.indexOf(
				b.name === "HOTA" ? "HOTA Lake Precinct" : "Ipswich Art Gallery",
			),
			same_as: null,
			not_venue: false,
		}));
	const { resolved, merges } = await run(
		{ "HOTA Lake Precinct": 3, HOTA: 1, "Art Gallery": 1 },
		{ cache, classify },
	);
	assert.equal(resolved.get("HOTA Lake Precinct"), "HOTA");
	assert.equal(resolved.get("HOTA"), "HOTA");
	assert.equal(cache.map["HOTA Lake Precinct"], "HOTA");
	assert.equal(resolved.get("Art Gallery"), "Ipswich Art Gallery");
	assert.ok(
		merges.some(([a, b]) => a === "HOTA Lake Precinct" && b === "HOTA"),
	);
});
