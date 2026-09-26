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
//
// This module never prints: every line the old script printed is captured as
// a {level, text} log entry on the result it returns, in the exact order it
// would have been emitted. cli/collectScraped.ts replays them — that's what
// keeps stdout byte-identical while letting the stage be called without a
// terminal attached (D15/D19, PLAN §2.6).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toISODate } from "@dothingslol/core/shared";
import {
	type EnrichStats,
	enrichFromDetailPage,
	type PageExtractFn,
	type ScrapeResult,
	SourceFetcher,
	scrape,
} from "@dothingslol/scraper";
import { closeRenderBrowser, renderFetch } from "@dothingslol/scraper/render";
import { mapWithConcurrency } from "@dothingslol/utils/concurrency";
import { addDays } from "@dothingslol/utils/tz";
import type { RunContext } from "../config/context.js";
import {
	barrenSourcesPath,
	curatedPath,
	DATA_ROOT,
	SOURCES_ROOT,
} from "../config/paths.js";
import { loadSourceRegistry } from "../config/registry.js";
import type { SourceDefinition } from "../config/sourceTypes.js";
import { withExtractionCache } from "../io/fileCache.js";
import { createHttpCacheStore } from "../io/httpCache.js";
import {
	type Annotation,
	annotationKey,
	applyAnnotation,
	createGeminiAnnotator,
	previousAnnotationIndex,
	reuseAnnotation,
} from "./annotate.js";
import { createGeminiPageExtractor } from "./extract.js";
import {
	councilEventUrl,
	type PrepareStats,
	prepareCandidates,
	type Rejection,
} from "./normalise.js";

type LogLine = { level: "log" | "error"; text: string };

export interface CollectScrapedOptions {
	/** `--only=id1,id2`: scrape just those source ids (the curated filenames). */
	only?: string[];
}

export interface SourceScrapeResult {
	sourceId: string;
	sourceName: string;
	kept: number;
	stats: PrepareStats;
	suspect: boolean;
	/** Why nothing was kept. Only meaningful when kept === 0. */
	reason: string;
	error?: Error;
	log: LogLine[];
}

export interface CollectScrapedResult {
	sources: SourceScrapeResult[];
	/** True when `sources/{city}.yml` doesn't exist yet — a normal state. */
	noRegistry: boolean;
	barren: string[];
	/** null: a partial (--only) run with no current report to merge into — the
	 * report was left absent rather than replaced with a lossy subset. */
	partialRunNoReport: boolean;
	totals: {
		found: number;
		kept: number;
		past: number;
		later: number;
		undated: number;
	};
	suspects: string[];
	cacheHits: number;
	cacheMisses: number;
	log: LogLine[];
}

/**
 * The barren report gates whether the AI search covers a scraper source, so it
 * is written as sources complete rather than at the end: an interrupted run
 * that left no report at all is treated as "every scraper source is uncovered"
 * (safe, but it re-searches everything), and a stale one from last week is
 * ignored outright.
 *
 * `reasons` is additive, and exists because the bare `names` list could not
 * tell a refused fetch from a venue with nothing on: a 403 challenge page, a
 * rotted URL, an annotation crash and a quiet week all wrote the same single
 * line. Diagnosis had to re-run the scrape to learn which it was.
 */
function writeBarrenReport(
	city: string,
	weekStart: string,
	names: string[],
	reasons: Map<string, string>,
): void {
	const path = barrenSourcesPath(city);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify(
			{
				week_start: weekStart,
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

/**
 * A partial (--only) run must not replace the barren report with its own
 * subset: every source missing from `names` reads as "the scrape covered it",
 * so a barren source outside the subset would silently lose its AI-search
 * fallback. Partial runs start from this week's report minus the sources they
 * re-check. With no current report there is nothing to merge into, and
 * writing a partial one would be exactly that failure — so this returns null
 * and the run leaves the report absent, which the reader treats as "all
 * uncovered".
 */
function priorBarren(
	city: string,
	weekStart: string,
	rechecked: Set<string>,
): { names: string[]; reasons: Map<string, string> } | null {
	try {
		const prior = JSON.parse(
			readFileSync(barrenSourcesPath(city), "utf-8"),
		) as {
			week_start?: string;
			names?: string[];
			reasons?: Record<string, string>;
		};
		if (prior.week_start !== weekStart) return null;
		const names = (prior.names ?? []).filter((n) => !rechecked.has(n));
		return {
			names,
			reasons: new Map(
				names.map((n) => [n, prior.reasons?.[n] ?? "no reason recorded"]),
			),
		};
	} catch {
		return null;
	}
}

function writeRejections(
	city: string,
	windowFrom: string,
	windowTo: string,
	sourceId: string,
	rejected: Rejection[],
): void {
	if (rejected.length === 0) return;
	const dir = join(DATA_ROOT, city, "adapters", "rejected");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${sourceId}.json`),
		JSON.stringify({ window: [windowFrom, windowTo], rejected }, null, 2),
		"utf-8",
	);
}

/**
 * A city whose file simply doesn't exist yet is a normal state — the AI
 * search covers everything for it. Anything else (malformed YAML, an entry
 * marked scraper with no listingUrls) is a real error and must not be
 * swallowed: a silent "no scraper sources" reads identically to a working
 * no-op run, which is how a broken registry could quietly disable the whole
 * scrape pass.
 */
function loadRegistrySafe(city: string): SourceDefinition[] | null {
	if (!existsSync(join(SOURCES_ROOT, `${city}.yml`))) return null;
	return loadSourceRegistry(city);
}

/**
 * One source's fetch outcome across its listing pages. A refusal and a fetch
 * that never completed are both errors here — they need opposite remedies to
 * an empty page, and both must reach barren.json's reasons by name.
 */
function summarise(results: ScrapeResult[]): {
	ok: boolean;
	listingsFetched: number;
	errors: string[];
} {
	const errors: string[] = [];
	for (const r of results) {
		if (r.fetch.status === "failed")
			errors.push(`fetch ${r.url}: ${r.fetch.error}`);
		if (r.fetch.status === "blocked")
			errors.push(`extract ${r.url}: ${r.fetch.error}`);
	}
	return {
		ok: errors.length === 0,
		listingsFetched: results.filter((r) => r.fetch.status !== "failed").length,
		errors,
	};
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

function alreadyCollected(
	outPath: string,
	weekStart: string,
	force: boolean,
): boolean {
	if (force || !existsSync(outPath)) return false;
	try {
		const payload = JSON.parse(readFileSync(outPath, "utf-8")) as Record<
			string,
			unknown
		>;
		return payload.week_start === weekStart;
	} catch {
		return false;
	}
}

async function collectSource(
	ctx: RunContext,
	source: SourceDefinition,
	fetcher: SourceFetcher,
	annotate: ReturnType<typeof createGeminiAnnotator>,
	extractPage: PageExtractFn,
	windowFrom: string,
	windowTo: string,
	listingConcurrency: number,
): Promise<{
	kept: number;
	stats: PrepareStats;
	suspect: boolean;
	reason: string;
	log: LogLine[];
}> {
	const city = ctx.city;
	const weekStart = toISODate(ctx.week.monday, ctx.cityConfig.timezone);
	const weekEnd = toISODate(ctx.week.sunday, ctx.cityConfig.timezone);
	const log: LogLine[] = [];
	const outPath = curatedPath(city, "adapters", source.id);
	if (alreadyCollected(outPath, weekStart, ctx.force)) {
		// Report what the existing file holds, not zero: returning 0 here
		// marked every source barren on any second run of the week, sending
		// the whole scrape set back to the AI search.
		const existing = countEvents(outPath);
		log.push({
			level: "log",
			text: `  → [${source.id}] Already collected (${existing} events) — skipping`,
		});
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
			log,
		};
	}

	const results = await mapWithConcurrency(
		source.listingUrls,
		listingConcurrency,
		(url) =>
			scrape(url, {
				strategy: source.strategy,
				fetcher,
				fallback: extractPage,
				timeZone: source.timeZone,
				linkRewriter: councilEventUrl,
				source,
			}),
	);
	const result = summarise(results);
	const raw = results.flatMap((r) => r.candidates);

	// Window-filter first so the detail-page pass only fetches for events we
	// will publish: a venue's season listing is mostly "later", and those
	// pages were being fetched for nothing.
	const first = prepareCandidates(
		raw,
		source,
		windowFrom,
		windowTo,
		source.timeZone,
	);
	writeRejections(city, windowFrom, windowTo, source.id, first.rejected);

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
	// Re-run on the enriched candidates: pure and cheap, and the one case
	// where a JSON-LD start moves an event out of the window is handled
	// correctly.
	const { prepared, stats: windowStats } = prepareCandidates(
		candidates,
		source,
		windowFrom,
		windowTo,
		source.timeZone,
	);
	const stats: PrepareStats = { ...first.stats, kept: windowStats.kept };

	let events: Record<string, unknown>[] = [];
	let dropped = 0;
	let reused = 0;
	if (prepared.length > 0) {
		// The publishing window is two weeks, so a scraped event is annotated
		// at least twice, and a season listing many more times, for a
		// classification that never changes between runs. Last week's file for
		// this source (still on disk — it is only overwritten below) already
		// has the answer for anything unchanged.
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
			log.push({
				level: "log",
				text: `  → [${source.id}] ${reused}/${prepared.length} annotation(s) reused from last week`,
			});
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
		city_key: city,
		provider: "adapters",
		// The original sources/{city}.yml tier, so curate.ts's existing
		// TIER_TO_VENUE map classifies these with no special-casing.
		tier: source.sourceTier,
		source_id: source.id,
		week_start: weekStart,
		week_end: weekEnd,
		events,
	};
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

	logTimeAndThinStats(log, source.id, timeStats);

	const drops = [
		stats.noDate && `${stats.noDate} undated`,
		stats.past && `${stats.past} PAST`,
		stats.later && `${stats.later} later`,
		stats.noTitle && `${stats.noTitle} untitled`,
		dropped && `${dropped} filtered`,
	].filter(Boolean);
	// Two different kinds of bad: a page whose events have all happened
	// (wrong URL), and a page that was fetched fine but yielded nothing at all
	// (extraction problem, not a quiet week).
	const archiveLike = stats.past > 0 && events.length === 0;
	const extractedNothing = result.listingsFetched > 0 && stats.total === 0;
	const suspect = archiveLike || extractedNothing;
	const flag = !result.ok ? "✗" : suspect ? "⚠" : "✓";
	log.push({
		level: "log",
		text:
			`  ${flag} [${source.id}] ${result.listingsFetched} page(s), ` +
			`${stats.total} found → ${events.length} in window` +
			`${drops.length ? `  (${drops.join(", ")})` : ""}`,
	});
	if (extractedNothing) {
		log.push({
			level: "log",
			text: `      ⚠ fetched ${result.listingsFetched} page(s) but extracted nothing — extraction problem rather than an empty listing: ${source.listingUrls.join(" ")}`,
		});
	}
	if (archiveLike) {
		log.push({
			level: "log",
			text: `      ⚠ every event on this page has already happened — the listing URL is probably an archive: ${source.listingUrls.join(" ")}`,
		});
	}
	for (const err of result.errors)
		log.push({ level: "error", text: `      ! ${err}` });
	// Why this source produced nothing, in the order that matters: a refusal
	// or crash outranks an empty page, because they need opposite remedies.
	const reason = result.errors.length
		? result.errors.join("; ")
		: result.listingsFetched === 0
			? "no listing pages fetched"
			: archiveLike
				? `all ${stats.past} event(s) on the page have already happened — listing URL is probably an archive`
				: extractedNothing
					? `fetched ${result.listingsFetched} page(s), extracted nothing — extraction problem, not an empty listing`
					: `${stats.total} found, none inside the window`;
	return { kept: events.length, stats, suspect, reason, log };
}

function logTimeAndThinStats(
	log: LogLine[],
	sourceId: string,
	timeStats: EnrichStats,
): void {
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
		log.push({
			level: "log",
			text: `  ⏱ [${sourceId}] ${timeStats.upgraded}/${timeStats.eligible} undated-time candidates got a time (${timeStats.fetched} detail page(s) fetched${via ? `; via ${via}` : ""})`,
		});
	}
	// The ratio is the signal: 0/54 on a source whose pages plainly have copy
	// means the extractors have stopped matching, not that the venue is terse.
	if (timeStats.thin > 0) {
		log.push({
			level: "log",
			text: `  ✎ [${sourceId}] ${timeStats.described}/${timeStats.thin} thin descriptions filled from detail pages`,
		});
	}
}

export async function collectScraped(
	ctx: RunContext,
	opts: CollectScrapedOptions = {},
): Promise<CollectScrapedResult> {
	const city = ctx.city;
	const cfg = ctx.config;
	const weekStart = toISODate(ctx.week.monday, ctx.cityConfig.timezone);
	const windowFrom = toISODate(new Date(), ctx.cityConfig.timezone);
	const windowTo = addDays(
		toISODate(ctx.week.sunday, ctx.cityConfig.timezone),
		cfg.publish.windowDaysAfterWeek,
	);
	const listingConcurrency = 2;
	const log: LogLine[] = [];

	const registry = loadRegistrySafe(city);
	if (registry === null) {
		log.push({
			level: "log",
			text: `→ No sources/${city}.yml — skipping scrape pass (AI search covers everything).`,
		});
		return {
			sources: [],
			noRegistry: true,
			barren: [],
			partialRunNoReport: false,
			totals: { found: 0, kept: 0, past: 0, later: 0, undated: 0 },
			suspects: [],
			cacheHits: 0,
			cacheMisses: 0,
			log,
		};
	}
	const only = opts.only;
	const sources = only ? registry.filter((s) => only.includes(s.id)) : registry;
	if (only) {
		const unknown = only.filter((id) => !registry.some((s) => s.id === id));
		if (unknown.length > 0) {
			throw new Error(
				`--only: no scraper source with id ${unknown.join(", ")}. Known ids: ${registry.map((s) => s.id).join(", ")}`,
			);
		}
	}
	if (sources.length === 0) {
		return {
			sources: [],
			noRegistry: false,
			barren: [],
			partialRunNoReport: false,
			totals: { found: 0, kept: 0, past: 0, later: 0, undated: 0 },
			suspects: [],
			cacheHits: 0,
			cacheMisses: 0,
			log,
		};
	}

	// One shared fetcher for the whole run: its per-host interval and
	// concurrency caps are instance state, so a per-source instance would
	// make the rate limiting meaningless for sources that share a host.
	const store = createHttpCacheStore();
	const fetcherOpts = {
		store,
		minIntervalMs: cfg.scrape.perHost.minIntervalMs,
		maxConcurrencyPerHost: cfg.scrape.perHost.maxConcurrency,
		maxRetries: cfg.scrape.retries.max,
		baseBackoffMs: cfg.scrape.retries.baseBackoffMs,
	};
	const fetcher = new SourceFetcher(fetcherOpts);
	// Sources whose events only exist after JavaScript runs, fetched through a
	// real browser. Separate instance so the browser path cannot inherit the
	// conditional-GET behaviour that assumes a plain HTTP body, but with the
	// same per-host politeness. Created lazily: most runs have no render
	// sources at all and should never launch a browser.
	let renderFetcher: SourceFetcher | undefined;
	const fetcherFor = (source: SourceDefinition): SourceFetcher => {
		if (source.strategy !== "render") return fetcher;
		if (!renderFetcher)
			renderFetcher = new SourceFetcher({
				...fetcherOpts,
				fetchImpl: renderFetch,
			});
		return renderFetcher;
	};
	// Retry-on-empty stays ON here: these are listing pages already verified
	// to yield events, so an empty result means a dropped call, not a quiet
	// week. The cache means pages the probe just extracted cost nothing.
	const extractPage = withExtractionCache(
		createGeminiPageExtractor({ stage: "collect/extract" }),
		{
			force: ctx.force,
		},
	);
	const annotate = createGeminiAnnotator();

	let total = 0;
	const totals = { found: 0, past: 0, later: 0, undated: 0 };
	const suspects: string[] = [];
	const base = only
		? priorBarren(city, weekStart, new Set(sources.map((s) => s.name)))
		: undefined;
	const barren: string[] = base?.names ?? [];
	const barrenReasons = base?.reasons ?? new Map<string, string>();
	// null = partial run with no current report to merge into: write nothing.
	const partialRunNoReport = base === null;
	const writeBarren = partialRunNoReport
		? () => {}
		: (names: string[], reasons: Map<string, string>) =>
				writeBarrenReport(city, weekStart, names, reasons);

	const sourceResults: SourceScrapeResult[] = new Array(sources.length);
	// Sources run concurrently. They are independent, and the per-host rate
	// limiting lives in the shared SourceFetcher rather than in this loop, so
	// serialising here bought nothing but wall-clock: 23 sources took as long
	// as the slowest 23 pages end to end.
	await mapWithConcurrency(
		sources,
		cfg.stages.collectAdapters.concurrency,
		async (source, i) => {
			try {
				const {
					kept,
					stats,
					suspect,
					reason,
					log: sourceLog,
				} = await collectSource(
					ctx,
					source,
					fetcherFor(source),
					annotate,
					extractPage,
					windowFrom,
					windowTo,
					listingConcurrency,
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
				sourceResults[i] = {
					sourceId: source.id,
					sourceName: source.name,
					kept,
					stats,
					suspect,
					reason,
					log: sourceLog,
				};
			} catch (err) {
				barren.push(source.name);
				barrenReasons.set(source.name, (err as Error).message);
				writeBarren(barren, barrenReasons);
				// runAdapter already isolates per-source failures; this catches
				// the rest (annotation blowup, unwritable path) so one bad
				// source can't end the run.
				sourceResults[i] = {
					sourceId: source.id,
					sourceName: source.name,
					kept: 0,
					stats: {
						total: 0,
						noTitle: 0,
						noDate: 0,
						past: 0,
						later: 0,
						kept: 0,
					},
					suspect: false,
					reason: (err as Error).message,
					error: err as Error,
					log: [
						{
							level: "error",
							text: `  ✗ [${source.id}] ${(err as Error).message}`,
						},
					],
				};
			}
		},
	);
	// Anything that produced nothing goes back to the AI search this run, so a
	// rotted listing URL degrades to search coverage instead of no coverage.
	// One browser for the whole run, so it closes once — not per source.
	await closeRenderBrowser();
	writeBarren(barren, barrenReasons);

	return {
		sources: sourceResults,
		noRegistry: false,
		barren,
		partialRunNoReport,
		totals: {
			found: totals.found,
			kept: total,
			past: totals.past,
			later: totals.later,
			undated: totals.undated,
		},
		suspects,
		cacheHits: extractPage.stats.hits,
		cacheMisses: extractPage.stats.misses,
		log,
	};
}
