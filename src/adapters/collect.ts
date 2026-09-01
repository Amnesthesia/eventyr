// Scrape pass: runs every method:scraper source in sources/{city}.yml
// through the deterministic fetch/extract path and writes one annotated,
// pipeline-shaped JSON file per source. Runs BEFORE the AI search
// (src/collection.ts), which now only has to cover what isn't scrapable —
// scraped sources are physically absent from sources/{city}.yml, so no
// runtime exclusion is needed anywhere.
//
// One file per source (not one combined file) so a single failing source can
// be retried on its own; curate.ts's findJsonFiles picks up every *.json
// under any curated/ dir with no registration.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import {
	barrenSourcesPath,
	curatedPath,
	fmtDate,
	getWeekRange,
	loadCityConfig,
	PROJECT_ROOT,
	requireEnv,
	toISODate,
} from "../common.ts";
import { applyAnnotation, createGeminiAnnotator } from "./annotate.ts";
import { SourceFetcher } from "./fetch.ts";
import { createGeminiPageExtractor } from "./llmExtract.ts";
import { prepareCandidates } from "./normalise.ts";
import { createPageAdapter } from "./pageAdapter.ts";
import { loadSourceRegistry } from "./registry.ts";
import { runAdapter } from "./runner.ts";
import type { SourceDefinition } from "./types.ts";

const CITY = requireEnv("CITY");
const GOOGLE_API_KEY = requireEnv("GOOGLE_API_KEY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);
const cityCfg = loadCityConfig(CITY);
const { monday, sunday } = getWeekRange();

/** A city with no registry yet is a normal state, not an error — the AI
 * search simply covers everything for it. */
function loadRegistrySafe(city: string): SourceDefinition[] {
	try {
		return loadSourceRegistry(city);
	} catch {
		console.log(
			`→ No scraper sources for ${city} — skipping scrape pass (AI search covers everything).`,
		);
		return [];
	}
}

function alreadyCollected(outPath: string): boolean {
	if (FORCE || !existsSync(outPath)) return false;
	try {
		const payload = JSON.parse(readFileSync(outPath, "utf-8")) as Record<
			string,
			unknown
		>;
		return payload.week_start === toISODate(monday);
	} catch {
		return false;
	}
}

async function collectSource(
	source: SourceDefinition,
	fetcher: SourceFetcher,
	annotate: ReturnType<typeof createGeminiAnnotator>,
	extractPage: ReturnType<typeof createGeminiPageExtractor>,
): Promise<number> {
	const outPath = curatedPath(CITY, "adapters", source.id);
	if (alreadyCollected(outPath)) {
		console.log(`  → [${source.id}] Already collected — skipping`);
		return 0;
	}

	const adapter = createPageAdapter(source, { fetcher, extractPage });
	const { result, candidates } = await runAdapter(adapter);

	const { prepared, stats } = prepareCandidates(
		candidates,
		source,
		toISODate(monday),
		toISODate(sunday),
	);

	let events: Record<string, unknown>[] = [];
	let dropped = 0;
	if (prepared.length > 0) {
		const annotations = await annotate(
			prepared.map((p) => p.event),
			source.name,
		);
		events = prepared
			.map((p, i) => ({ event: p.event, a: annotations[i] }))
			.filter(({ a }) => {
				if (a?.drop) dropped++;
				return !a?.drop;
			})
			.map(({ event, a }) => applyAnnotation(event, a));
	}

	const payload = {
		city_key: CITY,
		provider: "adapters",
		// The original sources/{city}.yml tier, so curate.ts's existing
		// TIER_TO_VENUE map classifies these with no special-casing.
		tier: source.sourceTier,
		source_id: source.id,
		week_start: toISODate(monday),
		week_end: toISODate(sunday),
		events,
	};
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

	const flag = result.ok ? "✓" : "✗";
	const detail = [
		`${result.listingsFetched} listing(s)`,
		`${stats.total} candidate(s)`,
		`${events.length} kept`,
	];
	const drops = [
		stats.noTitle && `${stats.noTitle} no title`,
		stats.noDate && `${stats.noDate} no date`,
		stats.outsideWeek && `${stats.outsideWeek} outside week`,
		dropped && `${dropped} filtered`,
	].filter(Boolean);
	console.log(
		`  ${flag} [${source.id}] ${detail.join("  ")}${drops.length ? `  (dropped: ${drops.join(", ")})` : ""}`,
	);
	for (const err of result.errors) console.error(`      ! ${err}`);
	return events.length;
}

async function main(): Promise<void> {
	console.log(
		`Scraping — ${cityCfg.name} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);
	const sources = loadRegistrySafe(CITY);
	if (sources.length === 0) {
		console.log("→ No scraper sources — nothing to scrape.");
		return;
	}
	console.log(`→ ${sources.length} scraper source(s)`);

	// One shared fetcher for the whole run: its robots cache, per-host
	// interval and concurrency caps are instance state, so a per-source
	// instance would make the rate limiting meaningless for sources that
	// share a host.
	const fetcher = new SourceFetcher();
	const extractPage = createGeminiPageExtractor(GOOGLE_API_KEY);
	const annotate = createGeminiAnnotator(GOOGLE_API_KEY);

	let total = 0;
	const barren: string[] = [];
	for (const source of sources) {
		try {
			const n = await collectSource(source, fetcher, annotate, extractPage);
			if (n === 0) barren.push(source.name);
			total += n;
		} catch (err) {
			barren.push(source.name);
			// runAdapter already isolates per-source failures; this catches the
			// rest (annotation blowup, unwritable path) so one bad source can't
			// end the run.
			console.error(`  ✗ [${source.id}] ${(err as Error).message}`);
		}
	}
	// Anything that produced nothing goes back to the AI search this run, so a
	// rotted listing URL degrades to search coverage instead of no coverage.
	const barrenPath = barrenSourcesPath(CITY);
	mkdirSync(dirname(barrenPath), { recursive: true });
	writeFileSync(barrenPath, JSON.stringify(barren, null, 2), "utf-8");
	if (barren.length > 0) {
		console.log(
			`⚠ ${barren.length} scraper source(s) returned nothing — AI search will cover them: ${barren.join(", ")}`,
		);
	}

	console.log(
		`✓ Scrape complete — ${total} event(s) across ${sources.length} source(s) → ${relative(PROJECT_ROOT, dirname(curatedPath(CITY, "adapters", "x")))}`,
	);
}

await main();
