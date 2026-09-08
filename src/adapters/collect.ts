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
import { dirname, join, relative } from "node:path";
import {
	barrenSourcesPath,
	curatedPath,
	DATA_ROOT,
	fmtDate,
	getWeekRange,
	loadCityConfig,
	PROJECT_ROOT,
	requireEnv,
	SOURCES_ROOT,
	toISODate,
} from "../common.ts";
import { mapWithConcurrency } from "../providers/base.ts";
import { installUsageReporting } from "../providers/gemini.ts";
import {
	type Annotation,
	annotationKey,
	applyAnnotation,
	createGeminiAnnotator,
	previousAnnotationIndex,
	reuseAnnotation,
} from "./annotate.ts";
import { enrichFromDetailPage } from "./enrichTimes.ts";
import { withExtractionCache } from "./extractionCache.ts";
import { SourceFetcher } from "./fetch.ts";
import { createGeminiPageExtractor } from "./llmExtract.ts";
import {
	type PrepareStats,
	prepareCandidates,
	type Rejection,
} from "./normalise.ts";
import { createPageAdapter } from "./pageAdapter.ts";
import { loadSourceRegistry } from "./registry.ts";
import { closeRenderBrowser, renderFetch } from "./render.ts";
import { runAdapter } from "./runner.ts";
import type { PageExtractFn, SourceDefinition } from "./types.ts";

const CITY = requireEnv("CITY");
const GOOGLE_API_KEY = requireEnv("GOOGLE_API_KEY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);
const cityCfg = loadCityConfig(CITY);
const { monday, sunday } = getWeekRange();

// Publishing window: today through the end of next week. Starting at today
// rather than Monday means a midweek run can't resurrect events that have
// already happened; extending a week past Sunday means next week's events are
// visible early, which is harmless and keeps thin weeks from looking empty.
/**
 * Sources scraped at once. The fetcher caps per-host requests itself, and
 * every source is a different host, so this is bounded by how many LLM
 * extraction calls we want in flight rather than by politeness.
 */
const SOURCE_CONCURRENCY = 5;

const WINDOW_FROM = toISODate(new Date());
const WINDOW_TO = toISODate(new Date(sunday.getTime() + 7 * 86_400_000));

/**
 * The barren report gates whether the AI search covers a scraper source, so it
 * is written as sources complete rather than at the end: an interrupted run
 * that left no report at all is treated as "every scraper source is uncovered"
 * (safe, but it re-searches everything), and a stale one from last week is
 * ignored outright.
 */
/**
 * `names` is the contract barrenSourceNames() reads, so it stays a bare list.
 * `reasons` is additive, and exists because the bare list could not tell a
 * refused fetch from a venue with nothing on: a 403 challenge page, a rotted
 * URL, an annotation crash and a quiet week all wrote the same single line.
 * Diagnosis had to re-run the scrape to learn which it was.
 */
function writeBarren(names: string[], reasons: Map<string, string>): void {
	const path = barrenSourcesPath(CITY);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify(
			{
				week_start: toISODate(monday),
				names,
				reasons: Object.fromEntries(
					names.map((n) => [n, reasons.get(n) ?? "no reason recorded"]),
				),
			},
			null,
			2,
		),
		"utf-8",
	);
}

function writeRejections(sourceId: string, rejected: Rejection[]): void {
	if (rejected.length === 0) return;
	const dir = join(DATA_ROOT, CITY, "adapters", "rejected");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${sourceId}.json`),
		JSON.stringify({ window: [WINDOW_FROM, WINDOW_TO], rejected }, null, 2),
		"utf-8",
	);
}

/**
 * A city whose file simply doesn't exist yet is a normal state — the AI search
 * covers everything for it. Anything else (malformed YAML, an entry marked
 * scraper with no listingUrls) is a real error and must not be swallowed: a
 * silent "no scraper sources" reads identically to a working no-op run, which
 * is how a broken registry could quietly disable the whole scrape pass.
 */
function loadRegistrySafe(city: string): SourceDefinition[] {
	if (!existsSync(join(SOURCES_ROOT, `${city}.yml`))) {
		console.log(
			`→ No sources/${city}.yml — skipping scrape pass (AI search covers everything).`,
		);
		return [];
	}
	return loadSourceRegistry(city);
}

function countEvents(outPath: string): number {
	try {
		const payload = JSON.parse(readFileSync(outPath, "utf-8")) as {
			events?: unknown[];
		};
		return payload.events?.length ?? 0;
	} catch {
		return 0;
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
	extractPage: PageExtractFn,
): Promise<{
	kept: number;
	stats: PrepareStats;
	suspect: boolean;
	/** Why nothing was kept. Only meaningful when kept === 0. */
	reason: string;
}> {
	const outPath = curatedPath(CITY, "adapters", source.id);
	if (alreadyCollected(outPath)) {
		// Report what the existing file holds, not zero: returning 0 here
		// marked every source barren on any second run of the week, sending
		// the whole scrape set back to the AI search.
		const existing = countEvents(outPath);
		console.log(
			`  → [${source.id}] Already collected (${existing} events) — skipping`,
		);
		return {
			kept: existing,
			stats: {
				total: existing,
				noTitle: 0,
				noDate: 0,
				past: 0,
				later: 0,
				kept: existing,
			},
			suspect: false,
			reason: "already collected this week",
		};
	}

	const adapter = createPageAdapter(source, { fetcher, extractPage });
	const { result, candidates: raw } = await runAdapter(adapter);

	// Window-filter first so the detail-page pass only fetches for events we
	// will publish: a venue's season listing is mostly "later", and those pages
	// were being fetched for nothing.
	const first = prepareCandidates(raw, source, WINDOW_FROM, WINDOW_TO);
	writeRejections(source.id, first.rejected);

	// Listing cards print "Sat 5 Sep" where the event's own page says
	// "Saturday 05 Sep 2026, 10:30AM" — 43% of events arrived without a time
	// for that reason alone — and show a genre badge ("Experiences") where the
	// page has a real description. Deterministic and LLM-free; a time can only
	// ever be added to the day the listing already gave. See enrichTimes.ts.
	const { candidates, stats: timeStats } = await enrichFromDetailPage(
		first.prepared.map((p) => p.candidate),
		source,
		fetcher,
	);
	// Re-run on the enriched candidates: pure and cheap, and the one case where
	// a JSON-LD start moves an event out of the window is handled correctly.
	const { prepared, stats: windowStats } = prepareCandidates(
		candidates,
		source,
		WINDOW_FROM,
		WINDOW_TO,
	);
	const stats: PrepareStats = { ...first.stats, kept: windowStats.kept };

	let events: Record<string, unknown>[] = [];
	let dropped = 0;
	let reused = 0;
	if (prepared.length > 0) {
		// The publishing window is two weeks, so a scraped event is annotated at
		// least twice, and a season listing many more times, for a
		// classification that never changes between runs. Last week's file for
		// this source (still on disk — it is only overwritten below) already has
		// the answer for anything unchanged.
		const previous = previousAnnotationIndex(
			existsSync(outPath)
				? ((
						JSON.parse(readFileSync(outPath, "utf-8")) as {
							events?: Record<string, unknown>[];
						}
					).events ?? [])
				: [],
		);
		const annotationFor = new Map<number, Annotation>();
		const toAnnotate: { event: Record<string, unknown>; index: number }[] = [];
		prepared.forEach((p, i) => {
			const reusedAnnotation = reuseAnnotation(
				p.event,
				previous.get(annotationKey(p.event)),
			);
			if (reusedAnnotation) {
				annotationFor.set(i, reusedAnnotation);
				reused++;
			} else {
				toAnnotate.push({ event: p.event, index: i });
			}
		});
		if (toAnnotate.length > 0) {
			const fresh = await annotate(
				toAnnotate.map((t) => t.event),
				source.name,
			);
			for (const [i, t] of toAnnotate.entries())
				annotationFor.set(t.index, fresh[i]);
		}
		if (reused > 0) {
			console.log(
				`  → [${source.id}] ${reused}/${prepared.length} annotation(s) reused from last week`,
			);
		}
		events = prepared
			.map((p, i) => ({ event: p.event, a: annotationFor.get(i) }))
			.filter(({ a }) => {
				if (a?.drop) dropped++;
				return !a?.drop;
			})
			.map(({ event, a }) => applyAnnotation(event, a as Annotation));
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

	// "found" alone hides the thing that matters: finding 100 and keeping 1 is
	// a broken URL, not a quiet week. `past` is the red flag — a listing page
	// for upcoming events should never yield finished ones.
	if (timeStats.upgraded > 0 || timeStats.eligible > 0) {
		// Broken down by extractor, not just totalled: four of them run in
		// order, and a total alone cannot show that one has stopped matching.
		const via = Object.entries(timeStats.via)
			.filter(([, n]) => n > 0)
			.map(([name, n]) => `${name} ${n}`)
			.join(", ");
		console.log(
			`  ⏱ [${source.id}] ${timeStats.upgraded}/${timeStats.eligible} undated-time candidates got a time` +
				` (${timeStats.fetched} detail page(s) fetched${via ? `; via ${via}` : ""})`,
		);
	}
	// The ratio is the signal: 0/54 on a source whose pages plainly have copy
	// means the extractors have stopped matching, not that the venue is terse.
	if (timeStats.thin > 0) {
		console.log(
			`  ✎ [${source.id}] ${timeStats.described}/${timeStats.thin} thin descriptions filled from detail pages`,
		);
	}
	const drops = [
		stats.noDate && `${stats.noDate} undated`,
		stats.past && `${stats.past} PAST`,
		stats.later && `${stats.later} later`,
		stats.noTitle && `${stats.noTitle} untitled`,
		dropped && `${dropped} filtered`,
	].filter(Boolean);
	// Two different kinds of bad: a page whose events have all happened (wrong
	// URL), and a page that was fetched fine but yielded nothing at all
	// (extraction problem, not a quiet week).
	const archiveLike = stats.past > 0 && events.length === 0;
	const extractedNothing = result.listingsFetched > 0 && stats.total === 0;
	const suspect = archiveLike || extractedNothing;
	const flag = !result.ok ? "✗" : suspect ? "⚠" : "✓";
	console.log(
		`  ${flag} [${source.id}] ${result.listingsFetched} page(s), ` +
			`${stats.total} found → ${events.length} in window` +
			`${drops.length ? `  (${drops.join(", ")})` : ""}`,
	);
	if (extractedNothing) {
		console.log(
			`      ⚠ fetched ${result.listingsFetched} page(s) but extracted nothing — extraction problem rather than an empty listing: ${source.listingUrls.join(" ")}`,
		);
	}
	if (archiveLike) {
		console.log(
			`      ⚠ every event on this page has already happened — the listing URL is probably an archive: ${source.listingUrls.join(" ")}`,
		);
	}
	for (const err of result.errors) console.error(`      ! ${err}`);
	// Why this source produced nothing, in the order that matters: a refusal or
	// crash outranks an empty page, because they need opposite remedies.
	const reason = result.errors.length
		? result.errors.join("; ")
		: result.listingsFetched === 0
			? "no listing pages fetched"
			: archiveLike
				? `all ${stats.past} event(s) on the page have already happened — listing URL is probably an archive`
				: extractedNothing
					? `fetched ${result.listingsFetched} page(s), extracted nothing — extraction problem, not an empty listing`
					: `${stats.total} found, none inside the window`;
	return { kept: events.length, stats, suspect, reason };
}

async function main(): Promise<void> {
	installUsageReporting();
	console.log(
		`Scraping — ${cityCfg.name} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);
	const sources = loadRegistrySafe(CITY);
	if (sources.length === 0) {
		console.log("→ No scraper sources — nothing to scrape.");
		return;
	}
	console.log(`→ ${sources.length} scraper source(s)`);

	// One shared fetcher for the whole run: its per-host
	// interval and concurrency caps are instance state, so a per-source
	// instance would make the rate limiting meaningless for sources that
	// share a host.
	const fetcher = new SourceFetcher();
	/**
	 * Sources whose events only exist after JavaScript runs, fetched through a
	 * real browser. Separate instance so the browser path cannot inherit the
	 * conditional-GET behaviour that assumes a plain HTTP body, but with the
	 * same per-host politeness. Created lazily: most runs have no render
	 * sources at all and should never launch a browser.
	 */
	let renderFetcher: SourceFetcher | undefined;
	const fetcherFor = (source: SourceDefinition): SourceFetcher => {
		if (source.strategy !== "render") return fetcher;
		if (!renderFetcher) {
			renderFetcher = new SourceFetcher({ fetchImpl: renderFetch });
		}
		return renderFetcher;
	};
	// Retry-on-empty stays ON here: these are listing pages already verified to
	// yield events, so an empty result means a dropped call, not a quiet week.
	// The cache means pages the probe just extracted cost nothing.
	const extractPage = withExtractionCache(
		createGeminiPageExtractor(GOOGLE_API_KEY, { stage: "collect/extract" }),
		{ force: FORCE },
	);
	const annotate = createGeminiAnnotator(GOOGLE_API_KEY);

	let total = 0;
	const totals = { found: 0, past: 0, later: 0, undated: 0 };
	const suspects: string[] = [];
	const barren: string[] = [];
	const barrenReasons = new Map<string, string>();
	// Sources run concurrently. They are independent, and the per-host rate
	// limiting lives in the shared SourceFetcher rather than in this loop, so
	// serialising here bought nothing but wall-clock: 23 sources took as long
	// as the slowest 23 pages end to end.
	await mapWithConcurrency(sources, SOURCE_CONCURRENCY, async (source) => {
		try {
			const { kept, stats, suspect, reason } = await collectSource(
				source,
				fetcherFor(source),
				annotate,
				extractPage,
			);
			if (kept === 0) {
				barren.push(source.name);
				barrenReasons.set(source.name, reason);
				writeBarren(barren, barrenReasons);
			}
			if (suspect) suspects.push(source.id);
			total += kept;
			totals.found += stats.total;
			totals.past += stats.past;
			totals.later += stats.later;
			totals.undated += stats.noDate;
		} catch (err) {
			barren.push(source.name);
			barrenReasons.set(source.name, (err as Error).message);
			writeBarren(barren, barrenReasons);
			// runAdapter already isolates per-source failures; this catches the
			// rest (annotation blowup, unwritable path) so one bad source can't
			// end the run.
			console.error(`  ✗ [${source.id}] ${(err as Error).message}`);
		}
	});
	// Anything that produced nothing goes back to the AI search this run, so a
	// rotted listing URL degrades to search coverage instead of no coverage.
	// One browser for the whole run, so it closes once — not per source.
	await closeRenderBrowser();
	writeBarren(barren, barrenReasons);
	if (barren.length > 0) {
		console.log(
			`⚠ ${barren.length} scraper source(s) returned nothing — AI search will cover them: ${barren.join(", ")}`,
		);
	}

	console.log(
		`\n${totals.found} found → ${total} in window (${totals.found ? Math.round((100 * total) / totals.found) : 0}%)  ` +
			`— ${totals.past} past, ${totals.later} later, ${totals.undated} undated`,
	);
	if (suspects.length > 0) {
		console.log(
			`⚠ ${suspects.length} source(s) returned only past events — re-probe or demote: ${suspects.join(", ")}`,
		);
	}
	const { hits, misses } = extractPage.stats;
	if (hits + misses > 0) {
		console.log(
			`→ extraction cache: ${hits} hit(s), ${misses} miss(es)` +
				`${hits > 0 ? ` — ${Math.round((100 * hits) / (hits + misses))}% of pages cost nothing` : ""}`,
		);
	}
	console.log(
		`✓ Scrape complete — ${total} event(s) across ${sources.length} source(s) → ${relative(PROJECT_ROOT, dirname(curatedPath(CITY, "adapters", "x")))}`,
	);
}

await main();
