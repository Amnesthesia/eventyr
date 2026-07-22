import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DATA_ROOT,
	fmtDate,
	getWeekRange,
	requireEnv,
	toISODate,
} from "./common.ts";

const CITY = requireEnv("CITY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);

type Event = Record<string, unknown>;

// ponytail: plain Maps search URL, no Geocoding/Places API key or billing
// needed — Maps resolves the query live when clicked. Upgrade to the Places
// "Find Place From Text" API for a precise place_id link if search-query
// links ever prove unreliable for a venue.
function mapsUrl(location: string, cityName: string): string {
	const query = `${location}, ${cityName}`;
	return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

async function main(): Promise<void> {
	const { monday, sunday } = getWeekRange();
	const jsonPath = join(DATA_ROOT, `${CITY}.json`);

	if (!existsSync(jsonPath)) {
		throw new Error(`✗ ${jsonPath} not found — run curate.ts first.`);
	}

	const payload = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<
		string,
		unknown
	>;

	if (!FORCE && payload.geocoded_at === toISODate(monday)) {
		console.log(
			"→ Already geocoded for this week — skipping. Set FORCE=true to re-geocode.",
		);
		return;
	}

	const events = (payload.events as Event[]) ?? [];
	if (events.length === 0) {
		throw new Error("✗ No events to geocode.");
	}

	const cityName = payload.city as string;
	console.log(
		`Geocoding — ${cityName} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);
	console.log("=".repeat(50));

	const cache = new Map<string, string>();
	let mapped = 0;
	for (const event of events) {
		const location = ((event.location as string) ?? "").trim();
		if (!location || location === "—") {
			event.location_url = "";
			continue;
		}
		const key = location.toLowerCase();
		let url = cache.get(key);
		if (!url) {
			url = mapsUrl(location, cityName);
			cache.set(key, url);
		}
		event.location_url = url;
		mapped++;
	}

	console.log(
		`→ ${mapped}/${events.length} events mapped (${cache.size} unique locations)`,
	);

	const updated = { ...payload, geocoded_at: toISODate(monday), events };
	writeFileSync(jsonPath, JSON.stringify(updated, null, 2), "utf-8");
	console.log(`→ Written ${jsonPath}`);
	console.log("✓ Geocoding complete.");
}

await main();
