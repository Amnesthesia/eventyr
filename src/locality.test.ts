import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DATA_ROOT, loadCityConfig } from "./common.ts";
import {
	type CityCentre,
	distanceKm,
	findElsewhere,
	type Geocoder,
	type Place,
	withPlaceCache,
} from "./locality.ts";

const BRISBANE: CityCentre = { lat: -27.4698, lng: 153.0251, radiusKm: 50 };

// Real coordinates, and the distances they imply are what the radius in
// sources/*.yml is chosen against.
const PLACES: Record<string, Place> = {
	"The Triffid, Newstead": {
		lat: -27.4478,
		lng: 153.0453,
		label: "Stratton St, Newstead QLD",
	},
	"George Clayton Park, Manly": {
		lat: -27.4548,
		lng: 153.1861,
		label: "Manly QLD",
	},
	"Enmore Theatre, Newtown": {
		lat: -33.8977,
		lng: 151.1755,
		label: "Newtown NSW",
	},
	"Home of the Arts, Bundall": {
		lat: -28.0055,
		lng: 153.4083,
		label: "Bundall QLD",
	},
};

test("findElsewhere drops what is outside the radius and keeps what is inside", () => {
	const elsewhere = findElsewhere(new Map(Object.entries(PLACES)), BRISBANE);
	assert.deepEqual([...elsewhere.keys()].sort(), [
		"Enmore Theatre, Newtown",
		"Home of the Arts, Bundall",
	]);
	// The reason is logged, so it has to name the place and the distance.
	assert.match(elsewhere.get("Enmore Theatre, Newtown") ?? "", /Newtown NSW/);
	assert.match(elsewhere.get("Enmore Theatre, Newtown") ?? "", /7\d\d km/);
});

test("an unresolved or failed location is kept, never dropped", () => {
	const places = new Map<string, Place | null>([
		// the geocoder knows of no such place
		["Zzzz Nonexistent Venue", null],
		["The Triffid, Newstead", PLACES["The Triffid, Newstead"]],
	]);
	// A request that failed is absent from the map entirely, which is the other
	// way a location reaches findElsewhere without an answer.
	assert.equal(findElsewhere(places, BRISBANE).size, 0);
});

test("the Gold Coast and Brisbane do not swallow each other", () => {
	const GOLD_COAST: CityCentre = { lat: -28.0167, lng: 153.4, radiusKm: 35 };
	const hota = PLACES["Home of the Arts, Bundall"];
	const triffid = PLACES["The Triffid, Newstead"];
	// Each city's own venue is inside its own radius…
	assert.ok(distanceKm(GOLD_COAST, hota) <= GOLD_COAST.radiusKm);
	assert.ok(distanceKm(BRISBANE, triffid) <= BRISBANE.radiusKm);
	// …and outside the other's. The two centres are ~67 km apart, so both
	// radii must stay under that or one city eats the other.
	assert.ok(distanceKm(BRISBANE, hota) > BRISBANE.radiusKm);
	assert.ok(distanceKm(GOLD_COAST, triffid) > GOLD_COAST.radiusKm);
});

test("withPlaceCache geocodes each distinct location exactly once", async (t) => {
	// The whole reason the interface takes a list: 500 events must not become
	// 500 requests. This is the assertion that fails if someone "simplifies" it
	// back to one call per event.
	const CITY = "_test_locality";
	const cachePath = join(DATA_ROOT, CITY, "locations.json");
	t.after(() =>
		rmSync(join(DATA_ROOT, CITY), { recursive: true, force: true }),
	);
	rmSync(join(DATA_ROOT, CITY), { recursive: true, force: true });

	const asked: string[][] = [];
	const stub: Geocoder = async (locations) => {
		asked.push(locations);
		return new Map(locations.map((l) => [l, PLACES[l] ?? null]));
	};

	const geocode = withPlaceCache(stub, CITY);
	const places = await geocode([
		"The Triffid, Newstead",
		"The Triffid, Newstead",
		" The Triffid, Newstead ",
		"Enmore Theatre, Newtown",
		"",
	]);
	assert.equal(asked.length, 1);
	assert.deepEqual(asked[0], [
		"The Triffid, Newstead",
		"Enmore Theatre, Newtown",
	]);
	assert.equal(geocode.stats.requested, 2);
	assert.equal(findElsewhere(places, BRISBANE).size, 1);

	// A second run over the same locations asks for nothing at all.
	const again = withPlaceCache(stub, CITY);
	const cached = await again([
		"The Triffid, Newstead",
		"Enmore Theatre, Newtown",
	]);
	assert.equal(asked.length, 1);
	assert.equal(again.stats.cached, 2);
	assert.equal(again.stats.requested, 0);
	assert.equal(findElsewhere(cached, BRISBANE).size, 1);
	assert.ok(existsSync(cachePath));
});

test("a failed request is not cached as an answer", async (t) => {
	// A transient failure that cached as "no such place" would be a permanent
	// wrong verdict for that venue, so it has to be retried next run.
	const CITY = "_test_locality_fail";
	t.after(() =>
		rmSync(join(DATA_ROOT, CITY), { recursive: true, force: true }),
	);
	rmSync(join(DATA_ROOT, CITY), { recursive: true, force: true });

	let calls = 0;
	// Absent from the returned map = the request failed, as the real geocoder
	// reports it.
	const flaky: Geocoder = async (locations) => {
		calls++;
		return calls === 1
			? new Map()
			: new Map(locations.map((l) => [l, PLACES[l] ?? null]));
	};

	assert.equal(
		(await withPlaceCache(flaky, CITY)(["Enmore Theatre, Newtown"])).size,
		0,
	);
	const retried = withPlaceCache(flaky, CITY);
	const places = await retried(["Enmore Theatre, Newtown"]);
	assert.equal(retried.stats.requested, 1, "should have asked again");
	assert.equal(findElsewhere(places, BRISBANE).size, 1);
});

test("no city's radius reaches another city's centre", () => {
	// A radius wide enough to cover the next city over would silently put its
	// events in this city's digest — Brisbane and the Gold Coast are only 71 km
	// apart, so there is not much room. Reads the real configs on purpose: this
	// is what makes a radius edit safe.
	const cities = ["brisbane", "goldcoast", "sunnycoast"].map((key) => ({
		key,
		centre: loadCityConfig(key).centre,
	}));
	for (const { key, centre } of cities) {
		assert.ok(centre, `${key} has no centre configured`);
	}
	for (const a of cities) {
		for (const b of cities) {
			if (a.key === b.key || !a.centre || !b.centre) continue;
			const km = distanceKm(a.centre, b.centre);
			assert.ok(
				km > a.centre.radiusKm,
				`${a.key}'s ${a.centre.radiusKm} km radius reaches ${b.key} (${Math.round(km)} km)`,
			);
		}
	}
});

test("an unusable centre keeps everything instead of dropping everything", () => {
	// The failure this prevents: a new city's config written with placeholder
	// coordinates. (0, 0) is finite and passes a NaN check, but it is in the
	// Gulf of Guinea — so every real venue reads as thousands of km away and
	// the whole city's digest empties out.
	const places = new Map(Object.entries(PLACES));
	for (const centre of [
		{ lat: 0, lng: 0, radiusKm: 50 },
		{ lat: Number.NaN, lng: 153, radiusKm: 50 },
		{ lat: -27.4698, lng: 153.0251, radiusKm: 0 },
	]) {
		assert.equal(findElsewhere(places, centre).size, 0);
	}
});
