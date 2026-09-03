import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isPast, withinWindow } from "./adapters/normalise.ts";
import {
	DATA_ROOT,
	fmtDate,
	getWeekRange,
	isLikelyImageUrl,
	loadCityConfig,
	PROJECT_ROOT,
	requireEnv,
	toISODate,
} from "./common.ts";
import { dedupeEventsSmart } from "./dedupe.ts";
import { createGeminiPairClassifier } from "./dedupeClassifier.ts";
import {
	createGoogleGeocoder,
	findElsewhere,
	withPlaceCache,
} from "./locality.ts";
import { installUsageReporting } from "./providers/gemini.ts";
import { cleanText, cleanUrl } from "./text.ts";

const CITY = requireEnv("CITY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);
const cityCfg = loadCityConfig(CITY);
const CITY_NAME = cityCfg.name;

// Same window the scrape pass uses: today through the end of next week. Kept
// here rather than imported from collect.ts so curate has no dependency on a
// script that may not have run.
const WINDOW_FROM = toISODate(new Date());
const WINDOW_TO = toISODate(
	new Date(getWeekRange().sunday.getTime() + 7 * 86_400_000),
);

function alreadyCuratedThisWeek(monday: Date): boolean {
	const jsonPath = join(DATA_ROOT, `${CITY}.json`);
	if (!existsSync(jsonPath)) return false;
	try {
		const payload = JSON.parse(readFileSync(jsonPath, "utf-8"));
		return payload.week_start === toISODate(monday);
	} catch {
		return false;
	}
}

function findJsonFiles(baseDir: string, subPath: string): string[] {
	if (!existsSync(baseDir)) return [];
	const results: string[] = [];
	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(baseDir, entry.name, subPath);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".json")) results.push(join(dir, file));
		}
	}
	return results.sort();
}

/**
 * Text fields shown to a reader, so escaped markup in any of them is a visible
 * defect ("Dice Rolls &#038; Flagons" on a card).
 *
 * Applied here rather than in each collection path: both paths feed this merge,
 * and doing it before dedupe means two sources that differ only in encoding
 * ("Tea &#038; Tour" vs "Tea & Tour") now match instead of both being kept.
 */
const TEXT_FIELDS = [
	"title",
	"description",
	"location",
	"cost",
	"datetime",
	"source",
] as const;
const URL_FIELDS = ["link", "location_url"] as const;

function cleanEvent(event: Record<string, unknown>): Record<string, unknown> {
	const out = { ...event };
	for (const key of TEXT_FIELDS) {
		if (key in out) out[key] = cleanText(out[key]);
	}
	for (const key of URL_FIELDS) {
		if (key in out) out[key] = cleanUrl(out[key]);
	}
	if (Array.isArray(out.tags)) out.tags = out.tags.map(cleanText);
	// Stricter than the other URLs: an extension-less image URL is an
	// extraction fault rather than a real picture, and 61 of 139 were dead.
	// See isLikelyImageUrl.
	const image = cleanUrl(out.image);
	out.image = isLikelyImageUrl(image) ? image : "";
	return out;
}

const TIER_TO_VENUE: Record<string, string> = {
	aggregators: "aggregator",
	institutions: "institution",
	independents: "independent",
	open: "aggregator",
};

/**
 * Throws out events that are not in the city being published, but only from
 * the `aggregators` and `open` tiers.
 *
 * Those are the tiers where a source promoted "for Brisbane" turns out to be
 * national — musick.com.au is a country-wide gig guide, and its verified
 * listing page put 40 Sydney, Melbourne, Adelaide and Perth events into one
 * Brisbane week. An `institutions` or `independents` source is a venue's own
 * site listing its own events, so it is trusted and never geocoded: that is
 * ~2/3 of the locations not sent to the API, and this week's one exception
 * (Opera Queensland touring to Toowoomba) is a rounding error against the cost
 * of checking every venue every week.
 *
 * Only the distinct location strings are geocoded, never one call per event.
 */
async function dropOtherCities(
	events: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
	const suspect = events.filter((e) => e.venue === "aggregator");
	const centre = cityCfg.centre;
	const apiKey = process.env.GOOGLE_MAPS_API_KEY;
	if (!centre || suspect.length === 0) {
		if (!centre) {
			console.log(
				`  ⚠ no centre configured in sources/${CITY}.yml — keeping every location`,
			);
		}
		return events;
	}
	// Same shape of degradation as the dedupe classifier below: the check is an
	// improvement on top of curation, never a precondition for it, and dropping
	// is the destructive direction — so no key means keep everything.
	if (!apiKey) {
		console.log(
			"  ⚠ GOOGLE_MAPS_API_KEY unset — every aggregator location kept unchecked",
		);
		return events;
	}

	const geocode = withPlaceCache(createGoogleGeocoder(apiKey), CITY);
	const places = await geocode(
		suspect.map((e) => ((e.location as string) ?? "").trim()),
	);
	const elsewhere = findElsewhere(places, centre);
	console.log(
		`→ locality: ${geocode.stats.requested} location(s) geocoded, ` +
			`${geocode.stats.cached} from cache, ${elsewhere.size} not in ${CITY_NAME}`,
	);
	for (const [location, why] of elsewhere) {
		console.log(`    ✗ ${location} — ${why}`);
	}
	if (elsewhere.size === 0) return events;
	return events.filter(
		(e) =>
			e.venue !== "aggregator" ||
			!elsewhere.has(((e.location as string) ?? "").trim()),
	);
}

async function mergeAndDeduplicate(
	monday: Date,
): Promise<Record<string, unknown>[]> {
	const cityDir = join(DATA_ROOT, CITY);
	const allEvents: Record<string, unknown>[] = [];
	const dropped = { past: 0, later: 0, undated: 0 };

	for (const file of findJsonFiles(cityDir, "curated")) {
		try {
			const payload = JSON.parse(readFileSync(file, "utf-8")) as Record<
				string,
				unknown
			>;
			if (payload.week_start === toISODate(monday)) {
				const baseTier = ((payload.tier as string) ?? "").replace(
					/-music$/,
					"",
				);
				const venue = TIER_TO_VENUE[baseTier] ?? "aggregator";
				const events = (payload.events as Record<string, unknown>[]) ?? [];
				for (const rawEvent of events) {
					const event = cleanEvent(rawEvent);
					// The scrape path windows its own output, but the AI search
					// path never did, so finished and far-future events reached
					// the site from search only. Apply the one rule here so both
					// paths are governed identically.
					const start = (event.datetime_iso as string) || null;
					const end = (event.datetime_end_iso as string) || null;
					if (start) {
						if (isPast(start, end, WINDOW_FROM)) {
							dropped.past++;
							continue;
						}
						if (!withinWindow(start, end, WINDOW_FROM, WINDOW_TO)) {
							dropped.later++;
							continue;
						}
					} else {
						// Undated events are kept: they cannot be shown to be
						// past, and the site still renders their human date
						// string. Dropping them would lose real events on the
						// word of a missing field.
						dropped.undated++;
					}
					allEvents.push({ ...event, venue });
				}
			}
		} catch {
			// skip malformed file
		}
	}

	console.log(
		`→ window ${WINDOW_FROM}..${WINDOW_TO}: dropped ${dropped.past} past, ` +
			`${dropped.later} beyond the window; kept ${dropped.undated} undated`,
	);

	// After the merge so both collection paths are governed identically, and
	// after the window so a finished event is never paid for.
	const local = await dropOtherCities(allEvents);
	if (local.length !== allEvents.length) {
		console.log(
			`→ ${allEvents.length - local.length} event(s) dropped as not in ${CITY_NAME}`,
		);
	}

	// Deliberately not common.ts's dedupeEvents here: this merge now spans
	// many per-source scrape files plus the search results, so it gets the
	// blocking + grey-zone strategy in src/dedupe.ts. See that file's header
	// for why and what it costs.
	// The classifier is an enhancement, not a requirement: without it the
	// deterministic stage still runs and ambiguous pairs are simply kept.
	// Merging is the destructive direction, so degrading to "keep both" is the
	// safe failure — and it means a missing key can't take down curation.
	const apiKey = process.env.GOOGLE_API_KEY;
	if (!apiKey) {
		console.log(
			"  ⚠ GOOGLE_API_KEY unset — deduping deterministically only, ambiguous pairs kept",
		);
	}
	const { events, stats } = await dedupeEventsSmart(local, {
		classify: apiKey ? createGeminiPairClassifier(apiKey) : undefined,
	});
	console.log(
		`→ ${stats.input} events in, ${stats.removed} duplicate(s) removed ` +
			`(${stats.settledPairs} matched outright, ${stats.askedPairs} ambiguous pair(s) checked, ${stats.confirmedByLlm} confirmed)`,
	);
	return events;
}

function writeJson(
	events: Record<string, unknown>[],
	monday: Date,
	sunday: Date,
): string {
	const payload = {
		city: CITY_NAME,
		city_key: CITY,
		week_start: toISODate(monday),
		week_end: toISODate(sunday),
		generated_at: toISODate(new Date()),
		events,
	};
	const outPath = join(DATA_ROOT, `${CITY}.json`);
	writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
	console.log(
		`→ Written ${relative(PROJECT_ROOT, outPath)} (${events.length} events)`,
	);
	return outPath;
}

async function main(): Promise<void> {
	installUsageReporting();
	const { monday, sunday } = getWeekRange();

	if (!FORCE && alreadyCuratedThisWeek(monday)) {
		console.log(
			"→ Already curated for this week — skipping. Set FORCE=true to re-curate.",
		);
		return;
	}

	console.log(
		`Curation — ${CITY_NAME} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);
	console.log("=".repeat(50));

	console.log("→ Merging and deduplicating…");
	const events = await mergeAndDeduplicate(monday);

	if (events.length === 0) {
		throw new Error(
			"✗ No events found. Run collection.ts for each tier first.",
		);
	}

	console.log(`→ ${events.length} events total`);
	writeJson(events, monday, sunday);
	console.log("✓ Curation complete.");
}

await main();
