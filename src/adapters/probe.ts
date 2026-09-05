// Finds the real, non-SPA listing page for every source in one city's
// sources/{city}.yml and promotes the ones that work to method: scraper.
//
// How it works, per source:
//
//   1. Ask Gemini (grounded in Google Search) for the URLs where this source
//      lists its events. Sites bury listings behind names no path convention
//      predicts — "Gig Guide", "Programme", "What's On This Week" — so asking
//      beats crawling and guessing, both of which kept landing on individual
//      event pages, journals and ticket-info pages.
//   2. Fetch every suggested URL (plus any already on file) and try to extract
//      events: JSON-LD, then embedded hydration JSON, then the LLM over
//      reduced page text.
//   3. Keep the URLs that actually produced dated events; drop the rest.
//
// The model only ever proposes. A URL becomes a scraper listingUrl solely
// because events came out of it here.
//
// Usage — always scoped to exactly one city, never a fleet run:
//   pnpm probe-sources --city=brisbane
//   pnpm probe-sources --city=brisbane --only=qagoma.qld.gov.au,thetivoli.com.au
//   pnpm probe-sources --city=brisbane --apply         # write promotions back to the YAML
//   pnpm probe-sources --city=brisbane --report-only   # re-derive report from cached results

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import yaml from "js-yaml";
import {
	DATA_ROOT,
	getWeekRange,
	loadCityConfig,
	SOURCE_TIERS,
	SOURCES_ROOT,
	type SourceEntry,
	type SourceTier,
	toISODate,
} from "../common.ts";
import {
	chunkArray,
	mapWithConcurrency,
	parseJsonArray,
} from "../providers/base.ts";
import {
	geminiText,
	installUsageReporting,
	reportGeminiUsage,
} from "../providers/gemini.ts";
import { toCandidateEvent } from "./candidate.ts";
import {
	extractJsonLdBlocks,
	findEventNodes,
	jsonLdNodeToRawFields,
} from "./extract.ts";
import { withExtractionCache } from "./extractionCache.ts";
import { SourceFetcher } from "./fetch.ts";
import { createGeminiPageExtractor } from "./llmExtract.ts";
import { brisbaneNaive, isPast, withinWindow } from "./normalise.ts";
import { stripToReadableText } from "./readableText.ts";
import type { PageExtractFn, RawCandidateFields } from "./types.ts";

// --- tuning ---------------------------------------------------------------
// These four thresholds decide who gets an LLM call. They are first-run
// guesses; the report prints the raw signals for every host so they can be
// retuned and the classification re-derived with --report-only, no refetch.
const MIN_TEXT_LENGTH = 1200; // below this a page is a shell, not a listing
// A page needs at least as many date strings as the promotion gate needs dated
// events, or it cannot clear that bar however well extraction goes — so
// refusing it here is free accuracy, not a compromise.
const MIN_DATE_HITS = 5; // a listing page mentions dates repeatedly
// Fetching is cheap (no model call), so the probe is generous with candidate
// pages and strict about how many get extracted. Every link in the site's own
// menu is a candidate: menus are where listing pages live, and their labels
// are often things no path convention would guess ("Gig Guide", "Programme").
/** Suggested URLs fetched per source. */
const MAX_CANDIDATE_FETCHES = 6;
/** Listing URLs kept for a promoted source (a venue may list events and
 * exhibitions on separate pages, and both are worth scraping). */
const MAX_KEPT_URLS = 3;
/**
 * Pages actually extracted per source. Candidates are already ranked (sitemap,
 * declared, model-suggested, canonical, homepage) and scored by date hits and
 * JSON-LD nodes, so the winner is near the front; evaluating six was paying
 * flash-lite to re-confirm negatives. In the runs so far the sixth candidate
 * has never been the one that verified.
 */
const MAX_EVALUATIONS = 2;
/**
 * Promotion needs two things, because they answer two different questions.
 *
 * MIN_DATED_TO_PROMOTE — "is this a listing page at all?" A magazine homepage
 * mentioning one date is not (The Urban List: 1 dated event on
 * theurbanlist.com/ was promoted under the old ≥1 rule and then scraped zero
 * every week).
 *
 * MIN_IN_WINDOW_TO_PROMOTE — "is there anything to publish?" One is enough:
 * a real venue listing page during a quiet fortnight still belongs on the
 * scrape path (Queensland Theatre's /whats-on had 5 dated, 1 upcoming).
 *
 * MAX_PAST_RATIO — archives. Galleries legitimately list finished exhibitions
 * beside current ones (UQ Art Museum: 25 past, 3 upcoming), so the ratio is
 * generous; what it catches is a page that is essentially only history
 * (doo-bop's /events: 30 dated, 30 past, 0 upcoming).
 */
const MIN_DATED_TO_PROMOTE = 3;
// Two, not one: a single in-window event is as easily an article, a stray
// heading or a venue-hire page as a real listing, and the marginal promotions
// it produced (national aggregators yielding one event a week) cost a weekly
// fetch and extraction for nothing.
const MIN_IN_WINDOW_TO_PROMOTE = 2;
const MAX_PAST_RATIO = 10;
/**
 * Sources per batched listing-URL request, and how many of those requests run
 * at once. Smaller batches keep the model's attention per source; running
 * several concurrently is what makes that affordable in wall-clock terms.
 */
// flash-lite for the bulk batched discovery; the larger model is reserved for
// the per-source second opinion, which is asked far less often.
const DISCOVERY_MODEL = "gemini-3.1-flash-lite";
const URL_BATCH_SIZE = 20;
const URL_BATCH_CONCURRENCY = 4;
const CONCURRENT_HOSTS = 6;
/** Wall-clock ceiling per source. Generous — a source legitimately fetches a
 * sitemap tree plus several pages — but finite. */
const SOURCE_TIMEOUT_MS = Number(
	process.env.PROBE_SOURCE_TIMEOUT_MS ?? 180_000,
);

// Platforms that gate listings behind logins/APIs — they stay on LLM search.
const PLATFORMS =
	/eventbrite|meetup|facebook|humanitix|ticketmaster|moshtix|oztix|eventfinda|allevents|tripadvisor|feverup|songkick|bandsintown|instagram|linktr\.ee/i;

const RESULTS_PATH = join(DATA_ROOT, "_probe", "results.jsonl");
/**
 * Listing-URL suggestions, cached by host. The discovery phase is a few
 * hundred grounded calls before any probing starts, so losing it to an
 * interrupt means paying for all of it again — and the answers do not go stale
 * within a run.
 */
const LISTING_URLS_PATH = join(DATA_ROOT, "_probe", "listing-urls.json");

function loadListingUrlCache(): Map<string, string[]> {
	try {
		return new Map(
			Object.entries(
				JSON.parse(readFileSync(LISTING_URLS_PATH, "utf-8")) as Record<
					string,
					string[]
				>,
			),
		);
	} catch {
		return new Map();
	}
}

function saveListingUrlCache(found: Map<string, string[]>): void {
	mkdirSync(dirname(LISTING_URLS_PATH), { recursive: true });
	writeFileSync(
		LISTING_URLS_PATH,
		JSON.stringify(Object.fromEntries(found), null, 2),
		"utf-8",
	);
}

// The same window the scrape pass publishes (today → end of next week), so
// probe and collect cannot disagree about which events count.
const WINDOW_FROM = toISODate(new Date());
const WINDOW_TO = toISODate(
	new Date(getWeekRange().sunday.getTime() + 7 * 86_400_000),
);

// Archive pages are the trap in "most events wins": /past-events reliably
// carries more events than the real listing, and every one of them is over.
const ARCHIVE_URL =
	/\/(past|previous|archive|history|gallery|galleries|recap|wrap-?up)/i;

type Classification =
	| "jsonld"
	| "html"
	| "spa-empty"
	| "no-events"
	| "robots-disallowed"
	| "blocked"
	| "dead"
	| "platform"
	| "no-domain";

interface PageSignals {
	url: string;
	textLength: number;
	dateHits: number;
	jsonLdEventNodes: number;
}

interface ProbeResult {
	city: string;
	tier: SourceTier;
	name: string;
	host: string | null;
	probedAt: string;
	classification: Classification;
	homepage: string | null;
	listingUrls: string[];
	strategy: "jsonld" | "html" | null;
	candidatesFound: number;
	sampleTitles: string[];
	venue: {
		name: string | null;
		address: string | null;
		suburb: string | null;
	} | null;
	foundVia: PageAttempt["via"] | null;
	signals: PageSignals | null;
	/** Every sub-page considered, and what came of it — this is the part you
	 * read when a source looks wrong and you need to know which pages were
	 * tried and what was on them. */
	attempts: PageAttempt[];
	errors: string[];
}

interface PageAttempt {
	url: string;
	via: "declared" | "sitemap" | "llm" | "common" | "homepage";
	textLength: number;
	dateHits: number;
	jsonLdNodes: number;
	events: number | null;
	/** Verdict numbers, stored structurally so --report-only can re-apply a
	 * changed promotion gate without re-fetching or re-extracting. */
	dated?: number;
	inWindow?: number;
	past?: number;
	outcome: string;
}

// --- CLI ------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
	args
		.find((a) => a.startsWith(`--${name}=`))
		?.split("=")
		.slice(1)
		.join("=");
const has = (name: string): boolean => args.includes(`--${name}`);
// Only enforced when run as a CLI — importing this module for its pure
// helpers (as probe.test.ts does) must not exit the test process.
const IS_MAIN = process.argv[1]?.endsWith("probe.ts");
const cityArg = flag("city");
if (IS_MAIN && (!cityArg || cityArg.includes(","))) {
	console.error(
		"probe-sources runs for one city at a time — pass --city=<key>, e.g. --city=brisbane.",
	);
	process.exit(1);
}
const CITIES = cityArg ? [cityArg] : [];
const ONLY = flag("only")
	?.split(",")
	.map((s) => s.trim().toLowerCase());
const LIMIT = Number(flag("limit") ?? "0");
const APPLY = has("apply");
/** Ignore both caches and re-probe everything. */
const FORCE = has("force");
/**
 * Promotions are flushed to the YAML every this many completed sources rather
 * than only at the end.
 *
 * A full three-city probe takes the better part of an hour, and writing once at
 * the end made the whole thing all-or-nothing: interrupt it — or have it die on
 * source 500 — and every verified source was lost even though the per-source
 * results were safely on disk in results.jsonl. Flushing periodically means the
 * config is never more than this many sources behind what has been proven.
 */
const APPLY_EVERY = 20;
const REPORT_ONLY = has("report-only");

// --- helpers --------------------------------------------------------------

function normaliseHost(raw: string | undefined): string | null {
	if (!raw) return null;
	return (
		raw
			.replace(/^https?:\/\//, "")
			.split("/")[0]
			.toLowerCase()
			.replace(/^www\./, "") || null
	);
}

/**
 * Host equality with a dot boundary. A bare endsWith() accepted
 * "evil-qagoma.qld.gov.au" as belonging to "qagoma.qld.gov.au", and since a
 * verified URL is written into sources/{city}.yml by --apply, that would make
 * an attacker-registered lookalike a permanent scrape target.
 */
/** www/trailing-slash-insensitive key for de-duplicating candidate URLs. */
function canonical(url: string): string {
	return url
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\/$/, "")
		.toLowerCase();
}

function isSameSite(candidate: string | null, host: string): boolean {
	if (!candidate) return false;
	return candidate === host || candidate.endsWith(`.${host}`);
}

function countDateHits(text: string): number {
	const patterns = [
		/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi,
		/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi,
		/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g,
		/\b\d{4}-\d{2}-\d{2}\b/g,
		/\b\d{1,2}\s*(am|pm)\b/gi,
	];
	return patterns.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

function gatePassed(s: PageSignals): boolean {
	return s.textLength >= MIN_TEXT_LENGTH && s.dateHits >= MIN_DATE_HITS;
}

function classifyFailure(signals: PageSignals | null): Classification {
	if (!signals) return "dead";
	if (signals.textLength < MIN_TEXT_LENGTH) return "spa-empty";
	return "no-events";
}

/** Pulls a venue address off JSON-LD when the page publishes one — real data,
 * not a model's guess, which is why venue fields are only ever filled here. */
function venueFromJsonLd(nodes: Record<string, unknown>[]): {
	name: string | null;
	address: string | null;
	suburb: string | null;
} | null {
	for (const node of nodes) {
		const loc = node.location as Record<string, unknown> | undefined;
		if (!loc) continue;
		const name = typeof loc.name === "string" ? loc.name : null;
		const addr = loc.address as Record<string, unknown> | string | undefined;
		if (typeof addr === "string") return { name, address: addr, suburb: null };
		if (addr && typeof addr === "object") {
			return {
				name,
				address:
					typeof addr.streetAddress === "string" ? addr.streetAddress : null,
				suburb:
					typeof addr.addressLocality === "string"
						? addr.addressLocality
						: null,
			};
		}
		if (name) return { name, address: null, suburb: null };
	}
	return null;
}

// --- probing --------------------------------------------------------------

interface Fetched {
	url: string;
	body: string;
	signals: PageSignals;
	jsonLdNodes: Record<string, unknown>[];
}

/**
 * Path patterns that name an events listing. Used to filter a site's own
 * sitemap — the cheap, deterministic equivalent of a `site: inurl:` search,
 * with no third-party API and no tokens. (An actual Google dork would mean
 * either a Custom Search key or fetching google.com/search, which Google's
 * robots.txt disallows and this fetcher honours.)
 */
const LISTING_PATH =
	/\/(whats[-_]?on|what-s-on|events?|event[-_]?calendar|calendar|shows?|performances?|programme?|line[-_]?up|gigs?|gig[-_]?guide|upcoming|exhibitions?|workshops?|classes|screenings?|buy[-_]?tickets|tickets?|this[-_]?week)(\/|$|\?)/i;

/**
 * Sitemap crawling limits. Generous on fetches (they are cheap HTTP and cost no
 * tokens) and generous on URLs collected before filtering, because the point is
 * to gather a lot and then filter hard.
 */
// Generous, because indexes legitimately nest: an index names a per-city
// sitemap which names the pages, so a real answer can be three hops down.
const MAX_SITEMAP_FETCHES = 14;
const MAX_SITEMAP_URLS = 8000;
const MAX_SITEMAP_CANDIDATES = 5;
/** Pages nested under a URL before it counts as that section's index. */
const MIN_DESCENDANTS_FOR_INDEX = 15;

function sitemapUrlsFromRobots(body: string): string[] {
	return [...body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
}

function locsFrom(xml: string): string[] {
	return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

/**
 * Whether a sitemap document lists other sitemaps or lists pages.
 *
 * Taken from the document's root element, per the sitemaps protocol, rather
 * than guessed from the child URLs' file extension. Guessing on ".xml" was
 * wrong on real sites: Broadsheet and My Community Diary both serve a
 * <sitemapindex> whose children are extensionless (/sitemap/brisbane), so the
 * crawler treated the index's children as pages, filtered them out, and
 * reported "0 listing candidates" while never descending at all.
 */
export function isSitemapIndex(xml: string): boolean {
	return /<sitemapindex[\s>]/i.test(xml);
}

/** A sitemap document at all, as opposed to an HTML error or challenge page
 * returned with a 200. */
function looksLikeSitemap(xml: string): boolean {
	return /<(sitemapindex|urlset)[\s>]/i.test(xml);
}

/**
 * Which sitemap child to fetch next.
 *
 * FIFO wasted the whole fetch budget on the wrong region: Broadsheet's index
 * names eleven cities, and crawling them in order spent all 14 fetches inside
 * /sitemap/melbourne — including reaching /sitemap/melbourne/events — while
 * /sitemap/brisbane was never fetched. My Community Diary's QLD sitemaps sat
 * two places past the cutoff behind NSW.
 *
 * So order by relevance to the city being probed, and push other regions to
 * the back rather than excluding them (a single-city site may name its own
 * city nowhere).
 */
const CITY_TERMS: Record<string, string[]> = {
	brisbane: ["brisbane", "qld", "queensland"],
	goldcoast: ["gold-coast", "goldcoast", "gold_coast", "qld", "queensland"],
	sunnycoast: [
		"sunshine-coast",
		"sunshinecoast",
		"sunshine_coast",
		"noosa",
		"qld",
		"queensland",
	],
};

const OTHER_REGION =
	/(melbourne|sydney|adelaide|perth|hobart|darwin|canberra|newcastle|wollongong|geelong|auckland|wellington|new-zealand|\bnsw\b|\bvic\b|\bwa\b|\bsa\b|\bnt\b|\btas\b|\bact\b)/i;

export function sitemapPriority(url: string, cityTerms: string[]): number {
	const lower = url.toLowerCase();
	let score = 0;
	if (LISTING_PATH.test(lower)) score += 4;
	if (cityTerms.some((t) => lower.includes(t))) score += 3;
	else if (OTHER_REGION.test(lower)) score -= 4;
	return score;
}

/**
 * Whether a sitemap URL is a listing index rather than one event's page.
 *
 * The test is on the LAST path segment, not the whole path. Matching anywhere
 * accepted /events/tedx-brisbane — a single event — because the path contained
 * "events"; ranking then preferred those over /events itself once relevance
 * scoring replaced the accidental protection of sorting by length.
 *
 * A listing index's last segment is either a listing word ("events",
 * "whats-on", "buy-tickets") or a short single-word category or place name
 * ("music", "Brisbane"). One event's slug is hyphenated prose.
 */
export function looksLikeIndex(path: string): boolean {
	if (ARCHIVE_URL.test(path)) return false;
	const segments = path
		.replace(/^\/|\/$/g, "")
		.split("/")
		.filter(Boolean);
	if (segments.length === 0 || segments.length > 3) return false;
	const last = segments[segments.length - 1];
	if (LISTING_PATH.test(`/${last}/`)) return true;
	// A short, unhyphenated segment under a listing path is a category or a
	// place ("/events/music", "/Queensland/Brisbane").
	return segments.length > 1 && !last.includes("-") && last.length <= 14;
}

export interface SitemapResult {
	candidates: string[];
	sitemapsFetched: number;
	urlsSeen: number;
}

/**
 * Every URL a host's sitemap offered, plus what the filter kept, written per
 * host so "0 listing candidates" can be audited: it is either genuinely a site
 * with no events index, or LISTING_PATH is too narrow. Without the dump those
 * two look identical from the log.
 */
function dumpSitemap(
	host: string,
	data: {
		sitemapsTried: string[];
		notSitemaps: string[];
		sitemapsFetched: number;
		urls: string[];
		candidates: string[];
		rejected: string[];
	},
): void {
	try {
		const dir = join(DATA_ROOT, "_probe", "sitemaps");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${host.replace(/[^a-z0-9.-]/gi, "_")}.json`),
			JSON.stringify(data, null, 2),
			"utf-8",
		);
	} catch {
		// diagnostics must never break a probe
	}
}

/**
 * Listing-page candidates taken from the site's own sitemap.
 *
 * Tried before anything is asked of a model: a sitemap is cheap HTTP, it is
 * authoritative about which pages exist (so no invented URLs and no 404s), and
 * on a well-built site it names the events index outright. Nested sitemaps are
 * followed — big sites split by content type, and the events sitemap is
 * routinely one of the children rather than the index itself.
 *
 * This is the deterministic equivalent of a `site: inurl:events` search. A real
 * Google dork would need a Custom Search key or a fetch of google.com/search,
 * which Google's robots.txt disallows and this fetcher honours.
 */
async function sitemapCandidates(
	prober: Prober,
	sourceId: string,
	host: string,
	origin: string,
	city: string,
): Promise<SitemapResult> {
	const cityTerms = CITY_TERMS[city] ?? [city];
	const robots = await prober.fetchText(sourceId, `${origin}/robots.txt`, host);
	const queue = robots ? sitemapUrlsFromRobots(robots) : [];
	if (queue.length === 0) {
		queue.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
	}

	const seen = new Set<string>();
	const candidates: string[] = [];
	// Kept for the dump: every page URL offered, and the ones the filter
	// refused, so the pattern can be audited against reality.
	const allUrls: string[] = [];
	const rejected: string[] = [];
	const tried: string[] = [...queue];
	const notSitemaps: string[] = [];
	let fetched = 0;
	let urlsSeen = 0;

	while (queue.length > 0 && fetched < MAX_SITEMAP_FETCHES) {
		// Highest-priority child next, not the oldest.
		queue.sort(
			(a, b) => sitemapPriority(b, cityTerms) - sitemapPriority(a, cityTerms),
		);
		const url = queue.shift() as string;
		if (seen.has(url) || !isSameSite(normaliseHost(url), host)) continue;
		seen.add(url);
		const xml = await prober.fetchText(sourceId, url, host);
		if (!xml || !looksLikeSitemap(xml)) {
			// A 200 carrying an HTML error or challenge page is not a sitemap;
			// counting it as fetched made "2 file(s), 0 url(s)" look like an
			// empty site rather than a failed fetch.
			notSitemaps.push(url);
			continue;
		}
		fetched++;

		// The document's own root element says whether its children are more
		// sitemaps or actual pages — no URL guessing.
		if (isSitemapIndex(xml)) {
			for (const loc of locsFrom(xml)) {
				if (seen.has(loc) || !isSameSite(normaliseHost(loc), host)) continue;
				queue.push(loc);
				tried.push(loc);
			}
			continue;
		}

		for (const loc of locsFrom(xml)) {
			if (urlsSeen >= MAX_SITEMAP_URLS) break;
			urlsSeen++;
			if (!isSameSite(normaliseHost(loc), host)) continue;
			let path: string;
			try {
				path = new URL(loc).pathname;
			} catch {
				continue;
			}
			allUrls.push(loc);
			if (looksLikeIndex(path)) candidates.push(loc);
			else rejected.push(loc);
		}
	}

	// A URL that many other sitemap URLs are nested under is an index by
	// construction, whatever it is called. This catches listings whose path is
	// a place or category rather than a keyword —
	// mycommunitydiary.com.au/Queensland/Brisbane is the parent of 862 event
	// pages, and no amount of widening LISTING_PATH would have found it without
	// also flooding every site with false positives.
	const descendants = new Map<string, number>();
	for (const url of allUrls) {
		let path: string;
		try {
			path = new URL(url).pathname.replace(/\/$/, "");
		} catch {
			continue;
		}
		const segments = path.split("/").filter(Boolean);
		// Credit every ancestor of this page, but only shallow ones: a deep
		// prefix is a detail page's neighbour, not a listing index.
		for (let depth = 1; depth <= Math.min(segments.length - 1, 2); depth++) {
			const prefix = `/${segments.slice(0, depth).join("/")}`;
			descendants.set(prefix, (descendants.get(prefix) ?? 0) + 1);
		}
	}
	for (const url of allUrls) {
		let path: string;
		try {
			path = new URL(url).pathname.replace(/\/$/, "");
		} catch {
			continue;
		}
		if (ARCHIVE_URL.test(path)) continue;
		if ((descendants.get(path) ?? 0) >= MIN_DESCENDANTS_FOR_INDEX) {
			candidates.push(url);
		}
	}

	// Rank candidates: relevant to this city first, then by how much the page
	// indexes, then shortest path. Sorting on length alone put tiny shires
	// (/Queensland/Cook, /Queensland/Weipa) ahead of /Queensland/Brisbane.
	const score = (url: string): number => {
		const path = new URL(url).pathname.replace(/\/$/, "");
		// Fan-out dominates: /Queensland/Brisbane indexes 862 pages while
		// /Queensland/Cook indexes a handful, and capping the count at 50 made
		// them tie so the shorter name won. Only cap high enough to stop one
		// enormous section drowning out city relevance entirely.
		return (
			sitemapPriority(url, cityTerms) * 10_000 +
			Math.min(descendants.get(path) ?? 0, 2000) -
			path.length / 100
		);
	};
	const unique = [...new Set(candidates)].sort((a, b) => score(b) - score(a));
	dumpSitemap(host, {
		sitemapsTried: tried,
		notSitemaps,
		sitemapsFetched: fetched,
		urls: allUrls,
		candidates: unique,
		rejected,
	});
	return {
		candidates: unique.slice(0, MAX_SITEMAP_CANDIDATES),
		sitemapsFetched: fetched,
		urlsSeen,
	};
}

class Prober {
	constructor(
		private fetcher: SourceFetcher,
		private extractPage: PageExtractFn,
	) {}

	/** Fetches a URL and returns its body as text, or null on any failure.
	 * Used for robots.txt and sitemaps, which are not pages to be signalled. */
	async fetchText(
		sourceId: string,
		url: string,
		host: string,
	): Promise<string | null> {
		const page = await this.fetchPage(sourceId, url, host);
		return "error" in page ? null : page.body;
	}

	async fetchPage(
		sourceId: string,
		url: string,
		_host: string,
	): Promise<Fetched | { error: string; status?: number }> {
		try {
			const listing = await this.fetcher.fetch(sourceId, url, "html");
			if (!listing.bodyPath)
				return { error: `no body (${listing.status})`, status: listing.status };
			if (listing.status >= 400)
				return { error: `HTTP ${listing.status}`, status: listing.status };
			const body = readFileSync(listing.bodyPath, "utf-8");
			const text = stripToReadableText(body, url);
			const jsonLdNodes = findEventNodes(extractJsonLdBlocks(body));
			return {
				url,
				body,
				jsonLdNodes,
				signals: {
					url,
					textLength: text.length,
					dateHits: countDateHits(text),
					jsonLdEventNodes: jsonLdNodes.length,
				},
			};
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	/** Does this page actually yield dated events? JSON-LD first (free), then
	 * one LLM extraction if the signal gate passes. */
	async evaluate(
		page: Fetched,
		sourceName: string,
	): Promise<{
		strategy: "jsonld" | "html";
		titles: string[];
		count: number;
		inWindow: number;
		past: number;
	} | null> {
		// A listing page earns promotion on events in the window we actually
		// publish, not on raw totals — otherwise an archive, which always has
		// more events than the current programme, wins.
		const datedEvents = (fields: RawCandidateFields[]) =>
			fields
				.map((f) =>
					toCandidateEvent(f, {
						sourceId: "probe",
						sourceUrl: page.url,
						fetchedAt: new Date().toISOString(),
						strategy: "html",
					}),
				)
				.filter((c) => c.title && c.startISO);
		const countWindow = (
			fields: RawCandidateFields[],
		): { inWindow: number; past: number } => {
			let inWindow = 0;
			let past = 0;
			for (const c of datedEvents(fields)) {
				const start = brisbaneNaive(c.startISO);
				const end = brisbaneNaive(c.endISO);
				if (isPast(start, end, WINDOW_FROM)) past++;
				else if (withinWindow(start, end, WINDOW_FROM, WINDOW_TO)) inWindow++;
			}
			return { inWindow, past };
		};
		const dated = (fields: RawCandidateFields[]): string[] =>
			fields
				.map((f) =>
					toCandidateEvent(f, {
						sourceId: "probe",
						sourceUrl: page.url,
						fetchedAt: new Date().toISOString(),
						strategy: "html",
					}),
				)
				.filter((c) => c.title && c.startISO)
				.map((c) => c.title as string);

		if (page.jsonLdNodes.length > 0) {
			const fields = page.jsonLdNodes.map(jsonLdNodeToRawFields);
			const titles = dated(fields);
			if (titles.length > 0) {
				return {
					strategy: "jsonld",
					titles: titles.slice(0, 3),
					count: titles.length,
					...countWindow(fields),
				};
			}
		}
		if (!gatePassed(page.signals)) return null;
		// One batch's worth only. Probing answers "does this page list dated
		// events?", and a listing page answers that at the top; the tail is
		// footer and related-content boilerplate. Halves the calls per page.
		const text = stripToReadableText(page.body, page.url).slice(0, 12000);
		const fields = await this.extractPage(text, sourceName);
		const titles = dated(fields);
		if (titles.length === 0) return null;
		return {
			strategy: "html",
			titles: titles.slice(0, 3),
			count: titles.length,
			...countWindow(fields),
		};
	}
}

async function probeEntry(
	entry: SourceEntry,
	city: string,
	tier: SourceTier,
	prober: Prober,
	suggestedByHost: Map<string, string[]>,
): Promise<ProbeResult> {
	const host = normaliseHost(entry.domains?.[0]);
	const base: ProbeResult = {
		city,
		tier,
		name: entry.name,
		host,
		probedAt: new Date().toISOString(),
		classification: "no-domain",
		homepage: entry.homepage ?? null,
		listingUrls: [],
		strategy: null,
		candidatesFound: 0,
		sampleTitles: [],
		venue: null,
		foundVia: null,
		signals: null,
		attempts: [],
		errors: [],
	};
	if (!host) return base;
	if (PLATFORMS.test(host)) return { ...base, classification: "platform" };

	const sourceId = `probe--${host.replace(/[^a-z0-9]+/g, "_")}`;

	// Fetch the homepage first, purely to learn the origin the site actually
	// answers on: plenty of these hosts serve only www, and canonical-path
	// candidates built from the bare host just fail to resolve. It is still
	// evaluated last, since a homepage rarely beats a real listing index.
	const homePage = await prober.fetchPage(
		sourceId,
		entry.homepage ?? `https://${host}/`,
		host,
	);
	const homeOrigin =
		"error" in homePage ? `https://${host}` : new URL(homePage.url).origin;

	const suggested = suggestedByHost.get(host) ?? [];

	// URLs already on file first (a human or an earlier verified run put them
	// there), then whatever Gemini proposed, then the homepage as a floor —
	// small venues really do list everything on "/".
	const candidates: { url: string; via: PageAttempt["via"] }[] = [];
	const seen = new Set<string>();
	const add = (url: string, via: PageAttempt["via"]): void => {
		if (ARCHIVE_URL.test(new URL(url, `https://${host}`).pathname)) return;
		// Normalise www/trailing-slash variants: Gemini answers with the bare
		// host while the canonical guess uses www (or vice versa), and without
		// this the identical page is fetched and extracted twice.
		const key = canonical(url);
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ url, via });
	};
	for (const url of entry.listingUrls ?? []) add(url, "declared");
	// The site's own sitemap goes before anything the model suggests: cheap
	// HTTP, no invented URLs, and on a well-built site it names the events
	// index outright.
	const sitemap = await sitemapCandidates(
		prober,
		sourceId,
		host,
		homeOrigin,
		city,
	);
	for (const url of sitemap.candidates) add(url, "sitemap");
	console.log(
		`    · [${entry.name.slice(0, 28)}] sitemap: ${sitemap.sitemapsFetched} file(s), ` +
			`${sitemap.urlsSeen} url(s) → ${sitemap.candidates.length} listing candidate(s)` +
			`${sitemap.candidates.length > 0 ? `: ${sitemap.candidates.join(" ")}` : ""}`,
	);
	for (const url of suggested) add(url, "llm");
	// Two canonical paths as a safety net. Cheap extra candidates, verified
	// exactly like any other, and they earn their place: Gemini answered "/"
	// for The Tivoli (3 events) while /events had 63 on it.
	add(`${homeOrigin}/whats-on`, "common");
	add(`${homeOrigin}/events`, "common");

	const log: PageAttempt[] = [];
	const errors: string[] = [];
	let verified: {
		url: string;
		via: PageAttempt["via"];
		page: Fetched;
		verdict: {
			strategy: "jsonld" | "html";
			titles: string[];
			count: number;
			inWindow: number;
			past: number;
		};
	}[] = [];
	let best: PageSignals | null = null;
	let homepageUrl = entry.homepage ?? null;
	let evaluations = 0;

	if ("error" in homePage) {
		errors.push(`${entry.homepage ?? host}: ${homePage.error}`);
		log.push({
			url: entry.homepage ?? `https://${host}/`,
			via: "homepage",
			textLength: 0,
			dateHits: 0,
			jsonLdNodes: 0,
			events: null,
			outcome: homePage.error,
		});
	} else {
		homepageUrl = homePage.url;
		best = homePage.signals;
	}

	const queue: { url: string; via: PageAttempt["via"]; page?: Fetched }[] = [
		...candidates.slice(0, MAX_CANDIDATE_FETCHES),
		...("error" in homePage
			? []
			: [{ url: homePage.url, via: "homepage" as const, page: homePage }]),
	];

	for (const { url, via, page: prefetched } of queue) {
		const page = prefetched ?? (await prober.fetchPage(sourceId, url, host));
		if ("error" in page) {
			errors.push(`${url}: ${page.error}`);
			log.push({
				url,
				via,
				textLength: 0,
				dateHits: 0,
				jsonLdNodes: 0,
				events: null,
				outcome: page.error,
			});
			continue;
		}
		if (!best || page.signals.textLength > best.textLength) best = page.signals;

		if (evaluations >= MAX_EVALUATIONS) break;
		evaluations++;
		const verdict = await prober.evaluate(page, entry.name);
		log.push({
			url: page.url,
			via,
			textLength: page.signals.textLength,
			dateHits: page.signals.dateHits,
			jsonLdNodes: page.signals.jsonLdEventNodes,
			events: verdict?.inWindow ?? 0,
			dated: verdict?.count ?? 0,
			inWindow: verdict?.inWindow ?? 0,
			past: verdict?.past ?? 0,
			outcome: verdict
				? `${verdict.inWindow} in window, ${verdict.past} past (${verdict.count} dated) via ${verdict.strategy}`
				: gatePassed(page.signals)
					? "no events extracted"
					: "below signal gate (shell or non-listing page)",
		});
		if (verdict) verified.push({ url: page.url, via, page, verdict });
	}

	if (verified.length > 0) {
		// Richest page first: a listing index carries the programme, while a
		// single event's page also extracts cleanly and would otherwise look
		// like success. Keeping a few pages is deliberate — venues commonly
		// split events and exhibitions across separate listings.
		// Promotion requires real evidence: enough dated events actually inside
		// the window we publish. The old rule was "≥1 dated event anywhere",
		// which promoted magazine homepages on a single incidental date and
		// archives on hundreds of finished ones — 15 of the 53 sources it
		// promoted went on to scrape zero.
		const qualifying = verified.filter(
			(v) =>
				v.verdict.count >= MIN_DATED_TO_PROMOTE &&
				v.verdict.inWindow >= MIN_IN_WINDOW_TO_PROMOTE &&
				v.verdict.past <= MAX_PAST_RATIO * v.verdict.inWindow,
		);
		if (qualifying.length === 0) {
			return {
				...base,
				classification: "no-events",
				homepage: homepageUrl,
				signals: best,
				attempts: log,
				errors: [
					...errors,
					`no listing page cleared the gate (needs ${MIN_DATED_TO_PROMOTE}+ dated events, ${MIN_IN_WINDOW_TO_PROMOTE}+ inside ${WINDOW_FROM}..${WINDOW_TO}, and not archive-dominated)`,
				],
			};
		}
		verified = qualifying.sort(
			(a, b) =>
				b.verdict.inWindow - a.verdict.inWindow ||
				b.verdict.count - a.verdict.count,
		);
		// Sites commonly serve the same listing at two paths (/events and
		// /whats-on both returned the identical 63 events on thetivoli.com.au).
		// Keeping both would fetch and extract the same page twice every week.
		const kept: typeof verified = [];
		const fingerprints = new Set<string>();
		for (const v of verified) {
			const fingerprint = `${v.verdict.count}|${v.verdict.titles.join("|")}`;
			if (fingerprints.has(fingerprint)) continue;
			fingerprints.add(fingerprint);
			kept.push(v);
			if (kept.length >= MAX_KEPT_URLS) break;
		}
		const top = kept[0];
		return {
			...base,
			classification: top.verdict.strategy,
			strategy: top.verdict.strategy,
			homepage: homepageUrl,
			listingUrls: kept.map((k) => k.url),
			candidatesFound: kept.reduce((n, k) => n + k.verdict.inWindow, 0),
			sampleTitles: top.verdict.titles,
			venue: venueFromJsonLd(top.page.jsonLdNodes),
			foundVia: top.via,
			signals: top.page.signals,
			attempts: log,
			errors,
		};
	}

	// Nothing produced events. Distinguish "reachable but no listing we can
	// read" from "we never got a page at all", since the fixes differ.
	const allFailed = log.every((a) => a.events === null);
	const cls: Classification = allFailed
		? errors.some((e) => /robots\.txt disallows/.test(e))
			? "robots-disallowed"
			: errors.some((e) => /HTTP 403/.test(e))
				? "blocked"
				: "dead"
		: classifyFailure(best);

	return {
		...base,
		classification: cls,
		homepage: homepageUrl,
		signals: best,
		attempts: log,
		errors,
	};
}

// --- results / report -----------------------------------------------------

function loadResults(): ProbeResult[] {
	if (!existsSync(RESULTS_PATH)) return [];
	return readFileSync(RESULTS_PATH, "utf-8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const r = JSON.parse(line) as ProbeResult;
				// Results from an older run may predate a field; default rather
				// than crash, so a long sweep is never lost to a schema change.
				return [{ ...r, attempts: r.attempts ?? [], errors: r.errors ?? [] }];
			} catch {
				return [];
			}
		});
}

function appendResult(r: ProbeResult): void {
	mkdirSync(dirname(RESULTS_PATH), { recursive: true });
	appendFileSync(RESULTS_PATH, `${JSON.stringify(r)}\n`, "utf-8");
}

function report(results: ProbeResult[]): void {
	const scrapable = results.filter((r) => r.strategy);
	const byClass = new Map<string, number>();
	for (const r of results)
		byClass.set(r.classification, (byClass.get(r.classification) ?? 0) + 1);

	console.log(`\n${"=".repeat(78)}`);
	console.log(
		`${scrapable.length} of ${results.length} probed sources are scrapable  ` +
			`(jsonld: ${scrapable.filter((r) => r.strategy === "jsonld").length}, ` +
			`html: ${scrapable.filter((r) => r.strategy === "html").length})`,
	);
	console.log("=".repeat(78));
	console.log("\nBy outcome:");
	for (const [cls, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${String(n).padStart(4)}  ${cls}`);
	}

	if (scrapable.length > 0) {
		console.log("\nScrapable sources:");
		for (const r of scrapable.sort(
			(a, b) => b.candidatesFound - a.candidatesFound,
		)) {
			console.log(
				`  ${String(r.candidatesFound).padStart(3)} ev  ${r.strategy?.padEnd(6)} ` +
					`${(r.foundVia ?? "").padEnd(8)} ${r.host}\n` +
					`         ${r.listingUrls[0]}\n` +
					`         e.g. "${r.sampleTitles[0] ?? ""}"`,
			);
		}
	}

	const notScrapable = results.filter((r) => !r.strategy && r.host);
	if (notScrapable.length > 0) {
		console.log(
			`\nNot scrapable (${notScrapable.length}) — these stay on the AI search:`,
		);
		for (const r of notScrapable) {
			console.log(`  ${(r.host ?? "").padEnd(38)} ${r.classification}`);
		}
	}

	const noDomain = results.filter((r) => r.classification === "no-domain");
	if (noDomain.length > 0) {
		console.log(`\nNeeds a human — no domain on file (${noDomain.length}):`);
		for (const r of noDomain.slice(0, 40))
			console.log(`  ${r.city}/${r.tier}: ${r.name}`);
	}
	console.log(
		`\nRaw signals for tuning: ${RESULTS_PATH}` +
			`\nRe-derive without refetching: pnpm probe-sources --report-only`,
	);
}

/** Promotes verified sources to method: scraper, in place, preserving every
 * other field and the file's header comment. */
interface Change {
	kind: "promote" | "urls" | "demote";
	name: string;
	host: string;
	before: string[];
	after: string[];
}

/** Prints exactly what is being written, so the run ends with the change it
 * made rather than only a count. */
function reportChanges(city: string, changes: Change[]): void {
	if (changes.length === 0) {
		console.log(`→ ${city}: no source changes`);
		return;
	}
	const promoted = changes.filter((c) => c.kind === "promote");
	const urls = changes.filter((c) => c.kind === "urls");
	const demoted = changes.filter((c) => c.kind === "demote");

	console.log(`\n→ ${city}: updating ${changes.length} source(s)`);
	if (promoted.length > 0) {
		console.log(`\n  llm → scraper (${promoted.length}):`);
		for (const c of promoted) {
			console.log(`    + ${c.name}  (${c.host})`);
			for (const u of c.after) console.log(`        ${u}`);
		}
	}
	if (urls.length > 0) {
		console.log(`\n  listing URLs changed (${urls.length}):`);
		for (const c of urls) {
			console.log(`    ~ ${c.name}  (${c.host})`);
			for (const u of c.before.filter((u) => !c.after.includes(u))) {
				console.log(`        - ${u}`);
			}
			for (const u of c.after.filter((u) => !c.before.includes(u))) {
				console.log(`        + ${u}`);
			}
		}
	}
	if (demoted.length > 0) {
		console.log(`\n  scraper → llm, no longer verifiable (${demoted.length}):`);
		for (const c of demoted) {
			console.log(`    - ${c.name}  (${c.host})`);
			for (const u of c.before) console.log(`        was: ${u}`);
		}
	}
}

function applyPromotions(
	city: string,
	results: ProbeResult[],
	verbose = false,
): void {
	const path = join(SOURCES_ROOT, `${city}.yml`);
	const original = readFileSync(path, "utf-8");
	const header = original.slice(0, original.indexOf("\nname:") + 1);
	const cfg = loadCityConfig(city);

	// Keyed by host, not name: names repeat in the source lists (the same venue
	// twice, or two venues sharing a name), so a name key could write one
	// source's verified listing URL into a different source's entry — and the
	// weekly run would then scrape the wrong site under the wrong name.
	const byHost = new Map(
		results
			.filter((r) => r.city === city && r.strategy && r.host)
			.map((r) => [r.host as string, r]),
	);
	// Every host this run actually looked at, so demotion only touches sources
	// that were re-checked rather than everything not in the promoted set.
	const probedHosts = new Set(
		results
			.filter((r) => r.city === city && r.host)
			.map((r) => r.host as string),
	);
	let promoted = 0;
	let demoted = 0;
	const changes: Change[] = [];
	for (const tier of SOURCE_TIERS) {
		cfg.sources[tier] = (cfg.sources[tier] ?? []).map((entry) => {
			const host = normaliseHost(entry.domains?.[0]) ?? "";
			const r = byHost.get(host);
			if (!r?.strategy) {
				// Demote anything this run probed and could not verify. Without
				// this applyPromotions could only ever add, so a source promoted
				// under an older, looser gate stayed a scraper for ever even
				// once it had been shown to yield nothing.
				if (entry.method === "scraper" && probedHosts.has(host)) {
					demoted++;
					changes.push({
						kind: "demote",
						name: entry.name,
						host,
						before: entry.listingUrls ?? [],
						after: [],
					});
					return {
						...entry,
						method: "llm" as const,
						note: `Demoted by probe-sources ${new Date().toISOString().slice(0, 10)}: no listing page cleared the promotion gate.`,
					};
				}
				return entry;
			}
			promoted++;
			const before = entry.listingUrls ?? [];
			const sameUrls =
				before.length === r.listingUrls.length &&
				before.every((u, i) => u === r.listingUrls[i]);
			if (entry.method !== "scraper") {
				changes.push({
					kind: "promote",
					name: entry.name,
					host,
					before,
					after: r.listingUrls,
				});
			} else if (!sameUrls) {
				changes.push({
					kind: "urls",
					name: entry.name,
					host,
					before,
					after: r.listingUrls,
				});
			}
			return {
				...entry,
				method: "scraper" as const,
				homepage: r.homepage ?? entry.homepage,
				listingUrls: r.listingUrls,
				strategy: r.strategy,
				// Only ever fill venue from JSON-LD the page actually published.
				venue:
					entry.venue ??
					(r.venue
						? {
								name: r.venue.name ?? entry.name,
								address: r.venue.address,
								suburb: r.venue.suburb,
							}
						: undefined),
				note: `Verified by probe-sources ${r.probedAt.slice(0, 10)}: ${r.candidatesFound} dated event(s) via ${r.strategy}${r.foundVia === "llm" ? " (listing URL found by web search, then verified)" : ""}.`,
			};
		});
	}
	// header already ends in a newline; adding another accretes a blank line
	// on every run, so the rewrite is not idempotent.
	writeFileSync(
		path,
		`${header.replace(/\n+$/, "\n")}\n${yaml.dump(cfg, { lineWidth: 100, noRefs: true })}`,
		"utf-8",
	);
	if (verbose) reportChanges(city, changes);
	console.log(
		`→ ${city}: ${promoted} source(s) now method: scraper, ${demoted} demoted to method: llm`,
	);
}

// --- Gemini listing-URL discovery ----------------------------------------

/**
 * Asks Gemini, with Google Search grounding, where a source publishes its
 * event listings. This is the primary way listing URLs are found: most of
 * these sites bury the page somewhere no path convention would guess.
 *
 * The answer is never trusted — every URL it returns is fetched and has to
 * produce dated events before anything is promoted. Answers pointing off the
 * source's own domain are dropped outright.
 */
const LISTING_SYSTEM = `You locate public event LISTING index pages for venues and organizations — pages displaying multiple dated events at once.

Rule Priority:
1. Target canonical "What's On" hubs, dynamic event feeds, or recurring editorial roundups (e.g. weekly "what's on" listicles) over static or generic top-level category pages.
2. Prefer persistent, date-filterable indexes (e.g. /whats-on, /events, /calendar, /gig-guide, /programme) over generic landing pages (e.g. /things-to-do) whenever a dedicated events index exists.
3. Reject single-event pages, news/blog posts without an event agenda, static venue info pages, archives of past events, external ticket vendors, and social media.

You are given a JSON array of sources, each with an index "i", a "name", a "host" and an empty "listingUrls". Fill in listingUrls for each: 1 to 3 complete absolute URLs (including the https:// scheme and the exact subdomain the site serves), most relevant first, all on that source's own host. Use an empty array if you do not know one.

Return ONLY a compact JSON array of {"i": <index>, "listingUrls": [...]} — no markdown, no code fences, no prose.`;

export interface ListingUrlRequest {
	name: string;
	host: string;
}

/**
 * Asks Gemini, grounded in Google Search, where each source lists its events —
 * a batch at a time.
 *
 * Batched rather than one call per source: Brisbane alone has ~135 sources, and
 * a call each is slow enough to dominate the run. The model is filling blanks
 * in a JSON array, which is a shape it handles well, and the index is echoed
 * back because names repeat across the source lists and so can't be the key.
 *
 * The answers are never trusted. Every URL returned is fetched and has to
 * yield MIN_IN_WINDOW_TO_PROMOTE dated events inside the publishing window
 * before its source is promoted, and off-host answers are dropped outright.
 */
export interface ListingUrlFinder {
	batch(sources: ListingUrlRequest[]): Promise<Map<string, string[]>>;
}

function createListingUrlFinder(apiKey: string): ListingUrlFinder {
	const ai = new GoogleGenAI({ apiKey });

	async function fillBatch(
		batch: ListingUrlRequest[],
		out: Map<string, string[]>,
	): Promise<void> {
		const payload = batch.map((s, i) => ({
			i,
			name: s.name,
			host: s.host,
			listingUrls: [] as string[],
		}));
		const text = await geminiText(ai, {
			stage: "probe/discover-urls",
			model: DISCOVERY_MODEL,
			contents: JSON.stringify(payload),
			systemInstruction: LISTING_SYSTEM,
			search: true,
			maxOutputTokens: 8000,
		});
		for (const row of parseJsonArray<Record<string, unknown>>(text)) {
			const i = row.i;
			if (typeof i !== "number" || !batch[i]) continue;
			const host = batch[i].host;
			const urls = Array.isArray(row.listingUrls) ? row.listingUrls : [];
			out.set(
				host,
				urls
					.filter((u): u is string => typeof u === "string")
					.map((u) => u.trim().replace(/[.,)]+$/, ""))
					.filter((u) => isSameSite(normaliseHost(u), host))
					.slice(0, 3),
			);
		}
	}

	return {
		async batch(sources) {
			const found = FORCE ? new Map<string, string[]>() : loadListingUrlCache();
			const todo = sources.filter((s) => !found.has(s.host));
			const cached = sources.length - todo.length;
			if (todo.length === 0) {
				console.log(
					`Listing URLs: all ${cached} host(s) already cached — no discovery calls needed.`,
				);
				return found;
			}
			console.log(
				`Listing URLs: asking for ${todo.length} host(s)` +
					`${cached > 0 ? ` (${cached} already cached)` : ""}…`,
			);
			const groups = chunkArray(todo, URL_BATCH_SIZE);
			let done = 0;
			// The batches are independent, so run several at once: serially this
			// phase took ~28 minutes for 439 hosts.
			await mapWithConcurrency(groups, URL_BATCH_CONCURRENCY, async (group) => {
				try {
					await fillBatch(group, found);
				} catch (err) {
					console.error(
						`  ⚠ [listing-urls] batch of ${group.length} failed: ${(err as Error).message}`,
					);
				}
				done++;
				// Flushed per batch, not at the end: an interrupt during
				// discovery should cost one batch, not the whole phase.
				saveListingUrlCache(found);
				console.log(
					`  → listing URLs: ${found.size} answered (${done}/${groups.length} batches)`,
				);
			});
			return found;
		},
	};
}

// --- main -----------------------------------------------------------------

async function main(): Promise<void> {
	installUsageReporting();
	if (REPORT_ONLY) {
		const cached = loadResults();
		report(cached);
		if (APPLY) {
			for (const city of CITIES) applyPromotions(city, cached, true);
		}
		return;
	}

	const apiKey = process.env.GOOGLE_API_KEY;
	if (!apiKey) throw new Error("GOOGLE_API_KEY env var is required");

	const fetcher = new SourceFetcher();
	// Probe-mode: one batch per page, no retry-on-empty (most candidates
	// genuinely have no events), and cached by page content so a resumed or
	// repeated probe — and the collect run right after it — pay nothing for a
	// page already seen.
	const extractPage = withExtractionCache(
		createGeminiPageExtractor(apiKey, {
			retryOnEmpty: false,
			maxBatches: 1,
			stage: "probe/extract",
		}),
		{ force: FORCE },
	);
	const prober = new Prober(fetcher, extractPage);

	const findListingUrls = createListingUrlFinder(apiKey);

	// Keyed by city + tier + host + name: names repeat across tiers (the same
	// venue listed twice) and a bare name key silently skipped the second one.
	const resumeKey = (
		city: string,
		tier: string,
		host: string | null,
		name: string,
	): string => `${city}|${tier}|${host ?? ""}|${name}`;
	const done = FORCE
		? new Set<string>()
		: new Set(
				loadResults().map((r) => resumeKey(r.city, r.tier, r.host, r.name)),
			);
	const queue: { entry: SourceEntry; city: string; tier: SourceTier }[] = [];
	for (const city of CITIES) {
		const cfg = loadCityConfig(city);
		for (const tier of SOURCE_TIERS) {
			for (const entry of cfg.sources[tier] ?? []) {
				const host = normaliseHost(entry.domains?.[0]);
				if (done.has(resumeKey(city, tier, host, entry.name))) continue;
				if (ONLY && !(host && ONLY.includes(host))) continue;
				queue.push({ entry, city, tier });
			}
		}
	}
	const work = LIMIT > 0 ? queue.slice(0, LIMIT) : queue;
	console.log(
		`Probing ${work.length} source(s) across ${CITIES.join(", ")}` +
			`${done.size > 0 ? ` (resuming: ${done.size} already probed — pass --force to redo)` : ""}`,
	);

	const probeable = work
		.map((w) => ({
			name: w.entry.name,
			host: normaliseHost(w.entry.domains?.[0]),
		}))
		.filter((r): r is { name: string; host: string } => Boolean(r.host))
		.filter((r) => !PLATFORMS.test(r.host));
	const byHost = new Map<string, { name: string; host: string }>();
	for (const r of probeable) if (!byHost.has(r.host)) byHost.set(r.host, r);

	// Two passes, so the model is only asked about hosts the free paths could
	// not solve.
	//
	// Pass 1 uses declared URLs, the site's own sitemap, the two canonical
	// paths and the homepage — all cheap HTTP, no tokens. Pass 2 batches a
	// grounded request for whatever is left. Asking up front for every host
	// meant paying for hosts whose sitemap named the answer outright.
	const suggestedByHost = new Map<string, string[]>();

	let index = 0;
	let completed = 0;

	/**
	 * One source must never be able to hang a 421-source crawl.
	 *
	 * A full Brisbane run stalled on its last source and exited 13 with
	 * "unsettled top-level await": every other source had finished, but a
	 * promise inside that one never settled, so the process could neither
	 * finish nor fail. The fetch layer has its own request timeouts, which is
	 * exactly why this needs to sit above them — the hang was in something they
	 * do not cover.
	 */
	async function probeWithTimeout(item: {
		entry: SourceEntry;
		city: string;
		tier: SourceTier;
	}): Promise<ProbeResult | null> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), SOURCE_TIMEOUT_MS);
		});
		try {
			return await Promise.race([
				probeEntry(item.entry, item.city, item.tier, prober, suggestedByHost),
				timeout,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	// Serialised: applyPromotions reads the YAML, rewrites it whole, and the
	// workers run concurrently, so two overlapping flushes would lose one of
	// their sets of edits.
	let flushing: Promise<void> = Promise.resolve();
	function flushPromotions(verbose = false): Promise<void> {
		flushing = flushing.then(() => {
			const soFar = loadResults();
			for (const city of CITIES) applyPromotions(city, soFar, verbose);
		});
		return flushing;
	}
	async function worker(): Promise<void> {
		while (index < work.length) {
			const item = work[index++];
			// Logged before the work starts, not after: when a source hangs, the
			// last line printed is the only clue to which one it was.
			const startedAt = Date.now();
			console.log(
				`  … [${completed + 1}/${work.length}] ${item.entry.name.slice(0, 44)}`,
			);
			const timedOut = await probeWithTimeout(item);
			const result: ProbeResult =
				timedOut ??
				({
					city: item.city,
					tier: item.tier,
					name: item.entry.name,
					host: normaliseHost(item.entry.domains?.[0]),
					probedAt: new Date().toISOString(),
					classification: "dead",
					homepage: item.entry.homepage ?? null,
					listingUrls: [],
					strategy: null,
					candidatesFound: 0,
					sampleTitles: [],
					venue: null,
					foundVia: null,
					signals: null,
					attempts: [],
					errors: [
						`timed out after ${Math.round((Date.now() - startedAt) / 1000)}s — recorded as dead so the run can finish`,
					],
				} satisfies ProbeResult);
			appendResult(result);
			completed++;
			if (APPLY && completed % APPLY_EVERY === 0) await flushPromotions();
			// Only what worked: the listing URLs that actually produced events,
			// and whether the source is scrapable. Failed candidates are still
			// recorded in results.jsonl for debugging a specific source.
			if (result.strategy) {
				console.log(
					`✓ [${completed}/${work.length}] ${result.name} — scrapable (${result.strategy}, ${result.candidatesFound} events)`,
				);
				for (const a of result.attempts) {
					if (a.events) console.log(`      ${a.url}  →  ${a.events} events`);
				}
			} else {
				// Spell out the consequence: these are not dropped, they stay on
				// the AI-search path, which is the whole point of the two-path
				// design. Only a source that was already a scraper changes.
				const fate =
					result.classification === "no-domain"
						? "no domain on file"
						: `${result.classification} → stays on AI search`;
				console.log(`· [${completed}/${work.length}] ${result.name} — ${fate}`);
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENT_HOSTS, work.length) }, worker),
	);

	// Pass 2: only the sources the free paths left unverified.
	const unresolved = new Map<string, { name: string; host: string }>();
	for (const r of loadResults()) {
		if (r.strategy || !r.host || !CITIES.includes(r.city)) continue;
		if (PLATFORMS.test(r.host)) continue;
		if (!unresolved.has(r.host)) {
			unresolved.set(r.host, { name: r.name, host: r.host });
		}
	}
	if (unresolved.size > 0) {
		console.log(
			`\nPass 2: ${unresolved.size} source(s) unresolved by sitemap/canonical paths — asking the model.`,
		);
		const asked = await findListingUrls.batch([...unresolved.values()]);
		const retry = work.filter((w) => {
			const host = normaliseHost(w.entry.domains?.[0]);
			return Boolean(host && asked.get(host)?.length);
		});
		if (retry.length > 0) {
			let n = 0;
			await mapWithConcurrency(retry, CONCURRENT_HOSTS, async (item) => {
				const result = await probeEntry(
					item.entry,
					item.city,
					item.tier,
					prober,
					asked,
				);
				appendResult(result);
				n++;
				console.log(
					result.strategy
						? `✓ [pass2 ${n}/${retry.length}] ${result.name} — scrapable (${result.strategy}, ${result.candidatesFound} events)`
						: `· [pass2 ${n}/${retry.length}] ${result.name} — ${result.classification}`,
				);
			});
		}
	}

	// The final flush is the verbose one: applyPromotions is idempotent, so a
	// second pass would report no changes at all. Incremental flushes stay
	// quiet and only this one prints the source-by-source diff.
	if (APPLY) await flushPromotions(true);
	else {
		console.log("\nDry run — rerun with --apply to promote verified sources.");
	}
	report(loadResults());
}

// Guarded so the pure helpers above can be imported by tests without the
// module running a whole probe as an import side effect.
if (IS_MAIN) {
	await main();
	// Exit explicitly. Everything this script needed to write has been written
	// by now, and an abandoned fetch left pending by the per-source timeout
	// would otherwise keep the process alive or trip Node's unsettled-await
	// exit code.
	reportGeminiUsage();
	process.exit(0);
}
