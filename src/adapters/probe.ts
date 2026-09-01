// Finds the real, non-SPA listing page for every source in sources/*.yml and
// promotes the ones that work to method: scraper.
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
// Usage:
//   pnpm probe-sources                     # all cities, dry run + report
//   pnpm probe-sources --city=brisbane
//   pnpm probe-sources --only=qagoma.qld.gov.au,thetivoli.com.au
//   pnpm probe-sources --apply             # write promotions back to the YAML
//   pnpm probe-sources --report-only       # re-derive report from cached results

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import yaml from "js-yaml";
import {
	DATA_ROOT,
	loadCityConfig,
	SOURCE_TIERS,
	SOURCES_ROOT,
	type SourceEntry,
	type SourceTier,
} from "../common.ts";
import { toCandidateEvent } from "./candidate.ts";
import {
	discoverFeedLinks,
	extractJsonLdBlocks,
	findEventNodes,
	jsonLdNodeToRawFields,
} from "./extract.ts";
import { SourceFetcher } from "./fetch.ts";
import { createGeminiPageExtractor } from "./llmExtract.ts";
import { stripToReadableText } from "./readableText.ts";
import type { RawCandidateFields } from "./types.ts";

// --- tuning ---------------------------------------------------------------
// These four thresholds decide who gets an LLM call. They are first-run
// guesses; the report prints the raw signals for every host so they can be
// retuned and the classification re-derived with --report-only, no refetch.
const MIN_TEXT_LENGTH = 1200; // below this a page is a shell, not a listing
const MIN_DATE_HITS = 3; // a listing page mentions dates repeatedly
// Fetching is cheap (no model call), so the probe is generous with candidate
// pages and strict about how many get extracted. Every link in the site's own
// menu is a candidate: menus are where listing pages live, and their labels
// are often things no path convention would guess ("Gig Guide", "Programme").
/** Suggested URLs fetched per source. */
const MAX_CANDIDATE_FETCHES = 6;
/** Listing URLs kept for a promoted source (a venue may list events and
 * exhibitions on separate pages, and both are worth scraping). */
const MAX_KEPT_URLS = 3;
/** Cap on extraction calls per source. */
const MAX_EVALUATIONS = 6;
const CONCURRENT_HOSTS = 6;

// Platforms that gate listings behind logins/APIs — they stay on LLM search.
const PLATFORMS =
	/eventbrite|meetup|facebook|humanitix|ticketmaster|moshtix|oztix|eventfinda|allevents|tripadvisor|feverup|songkick|bandsintown|instagram|linktr\.ee/i;


const RESULTS_PATH = join(DATA_ROOT, "_probe", "results.jsonl");

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
	venue: { name: string | null; address: string | null; suburb: string | null } | null;
	feeds: { rss: string[]; ics: string[] };
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
	via: "declared" | "llm" | "common" | "homepage";
	textLength: number;
	dateHits: number;
	jsonLdNodes: number;
	events: number | null;
	outcome: string;
}

// --- CLI ------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
	args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const has = (name: string): boolean => args.includes(`--${name}`);
const CITIES = flag("city")?.split(",") ?? ["brisbane", "goldcoast", "sunnycoast"];
const ONLY = flag("only")?.split(",").map((s) => s.trim().toLowerCase());
const LIMIT = Number(flag("limit") ?? "0");
const APPLY = has("apply");
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
function venueFromJsonLd(
	nodes: Record<string, unknown>[],
): { name: string | null; address: string | null; suburb: string | null } | null {
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
					typeof addr.addressLocality === "string" ? addr.addressLocality : null,
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

class Prober {
	constructor(
		private fetcher: SourceFetcher,
		private extractPage: ReturnType<typeof createGeminiPageExtractor>,
	) {}

	async fetchPage(
		sourceId: string,
		url: string,
		host: string,
	): Promise<Fetched | { error: string; status?: number }> {
		try {
			const listing = await this.fetcher.fetch(sourceId, url, "html");
			if (!listing.bodyPath) return { error: `no body (${listing.status})`, status: listing.status };
			if (listing.status >= 400) return { error: `HTTP ${listing.status}`, status: listing.status };
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
	): Promise<{ strategy: "jsonld" | "html"; titles: string[]; count: number } | null> {
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
			const titles = dated(page.jsonLdNodes.map(jsonLdNodeToRawFields));
			if (titles.length > 0) {
				return { strategy: "jsonld", titles: titles.slice(0, 3), count: titles.length };
			}
		}
		if (!gatePassed(page.signals)) return null;
		const text = stripToReadableText(page.body, page.url).slice(0, 24000);
		const fields = await this.extractPage(text, sourceName);
		const titles = dated(fields);
		if (titles.length === 0) return null;
		return { strategy: "html", titles: titles.slice(0, 3), count: titles.length };
	}
}

async function probeEntry(
	entry: SourceEntry,
	city: string,
	tier: SourceTier,
	prober: Prober,
	askLlm: (name: string, host: string) => Promise<string[]>,
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
		feeds: { rss: [], ics: [] },
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
	const homeOrigin = "error" in homePage ? `https://${host}` : new URL(homePage.url).origin;

	const suggested = await askLlm(entry.name, host);

	// URLs already on file first (a human or an earlier verified run put them
	// there), then whatever Gemini proposed, then the homepage as a floor —
	// small venues really do list everything on "/".
	const candidates: { url: string; via: PageAttempt["via"] }[] = [];
	const seen = new Set<string>();
	const add = (url: string, via: PageAttempt["via"]): void => {
		// Normalise www/trailing-slash variants: Gemini answers with the bare
		// host while the canonical guess uses www (or vice versa), and without
		// this the identical page is fetched and extracted twice.
		const key = url
			.replace(/^https?:\/\//, "")
			.replace(/^www\./, "")
			.replace(/\/$/, "")
			.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ url, via });
	};
	for (const url of entry.listingUrls ?? []) add(url, "declared");
	for (const url of suggested) add(url, "llm");
	// Two canonical paths as a safety net. Cheap extra candidates, verified
	// exactly like any other, and they earn their place: Gemini answered "/"
	// for The Tivoli (3 events) while /events had 63 on it.
	add(`${homeOrigin}/whats-on`, "common");
	add(`${homeOrigin}/events`, "common");

	const log: PageAttempt[] = [];
	const errors: string[] = [];
	const verified: {
		url: string;
		via: PageAttempt["via"];
		page: Fetched;
		verdict: { strategy: "jsonld" | "html"; titles: string[]; count: number };
	}[] = [];
	let best: PageSignals | null = null;
	let feeds = { rss: [] as string[], ics: [] as string[] };
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
		feeds = discoverFeedLinks(homePage.body, homePage.url);
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
			events: verdict?.count ?? 0,
			outcome: verdict
				? `${verdict.count} events via ${verdict.strategy}`
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
		verified.sort((a, b) => b.verdict.count - a.verdict.count);
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
			candidatesFound: kept.reduce((n, k) => n + k.verdict.count, 0),
			sampleTitles: top.verdict.titles,
			venue: venueFromJsonLd(top.page.jsonLdNodes),
			feeds,
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
		feeds,
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
	for (const r of results) byClass.set(r.classification, (byClass.get(r.classification) ?? 0) + 1);

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
		for (const r of scrapable.sort((a, b) => b.candidatesFound - a.candidatesFound)) {
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
		console.log(`\nNot scrapable (${notScrapable.length}) — these stay on the AI search:`);
		for (const r of notScrapable) {
			console.log(`  ${(r.host ?? "").padEnd(38)} ${r.classification}`);
		}
	}

	const noDomain = results.filter((r) => r.classification === "no-domain");
	if (noDomain.length > 0) {
		console.log(`\nNeeds a human — no domain on file (${noDomain.length}):`);
		for (const r of noDomain.slice(0, 40)) console.log(`  ${r.city}/${r.tier}: ${r.name}`);
	}
	console.log(
		`\nRaw signals for tuning: ${RESULTS_PATH}` +
			`\nRe-derive without refetching: pnpm probe-sources --report-only`,
	);
}

/** Promotes verified sources to method: scraper, in place, preserving every
 * other field and the file's header comment. */
function applyPromotions(city: string, results: ProbeResult[]): void {
	const path = join(SOURCES_ROOT, `${city}.yml`);
	const original = readFileSync(path, "utf-8");
	const header = original.slice(0, original.indexOf("\nname:") + 1);
	const cfg = loadCityConfig(city);

	const byName = new Map(
		results.filter((r) => r.city === city && r.strategy).map((r) => [r.name, r]),
	);
	let promoted = 0;
	for (const tier of SOURCE_TIERS) {
		cfg.sources[tier] = (cfg.sources[tier] ?? []).map((entry) => {
			const r = byName.get(entry.name);
			if (!r || !r.strategy) return entry;
			promoted++;
			return {
				...entry,
				method: "scraper" as const,
				homepage: r.homepage ?? entry.homepage,
				listingUrls: r.listingUrls,
				strategy: r.strategy,
				schedule: entry.schedule ?? ("weekly" as const),
				// Only ever fill venue from JSON-LD the page actually published.
				venue:
					entry.venue ??
					(r.venue
						? {
								name: r.venue.name ?? entry.name,
								address: r.venue.address,
								suburb: r.venue.suburb,
								lat: null,
								lng: null,
								aliases: [],
							}
						: undefined),
				note: `Verified by probe-sources ${r.probedAt.slice(0, 10)}: ${r.candidatesFound} dated event(s) via ${r.strategy}${r.foundVia === "llm" ? " (listing URL found by web search, then verified)" : ""}.`,
			};
		});
	}
	writeFileSync(path, `${header}\n${yaml.dump(cfg, { lineWidth: 100, noRefs: true })}`, "utf-8");
	console.log(`→ ${city}: promoted ${promoted} source(s) to method: scraper`);
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
export function createListingUrlFinder(
	apiKey: string,
): (name: string, host: string) => Promise<string[]> {
	const ai = new GoogleGenAI({ apiKey });
	return async function findListingUrls(name, host) {
		try {
			const response = await ai.models.generateContent({
				model: "gemini-3.1-flash-lite",
				contents: `Where does "${name}" (${host}) list its upcoming events?

Provide the direct URLs to their active event listing index pages on ${host}.

Requirements:
- Must show MANY events at once in a list, grid, or calendar format.
- Include the primary "What's On" or calendar page.
- If the site uses curated weekly/weekend event roundups or specific listing feeds (e.g., editorial lists or dedicated sub-categories like /exhibitions, /workshops, /whats-on), include those specific listing URLs over generic top-level site categories.
- Do NOT provide a single event page, press release, home page, generic static venue guide, or external booking platform.

Return only complete, absolute URLs — including the https:// scheme and the exact subdomain the site actually serves (e.g. https://www.${host}/whats-on rather than ${host}/whats-on). One per line, nothing else.`,
				config: {
					systemInstruction: `You locate public event LISTING index pages for a venue or organization—pages displaying multiple dated events at once. Reply with up to 4 complete absolute URLs — each including the https:// scheme and the exact subdomain the site serves — one per line, strictly ordered from most relevant to least relevant. Never return a bare path or a partial URL. Output raw plain text only: no markdown formatting, no code blocks, no numbering, no preamble, and no prose.

Rule Priority:
1. Target canonical "What's On" hubs, dynamic event feeds, or recurring editorial roundups (e.g. weekly "what's on" listicles) over static or generic top-level category pages.
2. Prefer persistent, date-filterable indexes (e.g. /whats-on, /events, /calendar, /a-list/whats-on-*) over generic landing pages (e.g. /things-to-do) whenever a dedicated events index exists.
3. Reject single-event pages, news/blog posts without an event agenda, static venue info pages, external ticket vendors, and social media.`,
					tools: [{ googleSearch: {} }],
					maxOutputTokens: 600,
				},
			});
			return [...(response.text ?? "").matchAll(/https?:\/\/[^\s<>"\')]+/g)]
				.map((m) => m[0].replace(/[.,)]+$/, ""))
				.filter((u) => normaliseHost(u)?.endsWith(host) ?? false)
				.slice(0, 4);
		} catch {
			return [];
		}
	};
}

// --- main -----------------------------------------------------------------

async function main(): Promise<void> {
	if (REPORT_ONLY) {
		const cached = loadResults();
		report(cached);
		if (APPLY) for (const city of CITIES) applyPromotions(city, cached);
		return;
	}

	const apiKey = process.env.GOOGLE_API_KEY;
	if (!apiKey) throw new Error("GOOGLE_API_KEY env var is required");

	const fetcher = new SourceFetcher();
	const extractPage = createGeminiPageExtractor(apiKey);
	const prober = new Prober(fetcher, extractPage);

	const askLlm = createListingUrlFinder(apiKey);

	const done = new Set(loadResults().map((r) => `${r.city}:${r.name}`));
	const queue: { entry: SourceEntry; city: string; tier: SourceTier }[] = [];
	for (const city of CITIES) {
		const cfg = loadCityConfig(city);
		for (const tier of SOURCE_TIERS) {
			for (const entry of cfg.sources[tier] ?? []) {
				if (done.has(`${city}:${entry.name}`)) continue;
				const host = normaliseHost(entry.domains?.[0]);
				if (ONLY && !(host && ONLY.includes(host))) continue;
				queue.push({ entry, city, tier });
			}
		}
	}
	const work = LIMIT > 0 ? queue.slice(0, LIMIT) : queue;
	console.log(
		`Probing ${work.length} source(s) across ${CITIES.join(", ")}` +
			`${done.size > 0 ? ` (${done.size} already done — --force not implemented, delete ${RESULTS_PATH} to redo)` : ""}`,
	);

	let index = 0;
	let completed = 0;
	async function worker(): Promise<void> {
		while (index < work.length) {
			const item = work[index++];
			const result = await probeEntry(item.entry, item.city, item.tier, prober, askLlm);
			appendResult(result);
			completed++;
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
				console.log(
					`· [${completed}/${work.length}] ${result.name} — not scrapable (${result.classification})`,
				);
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENT_HOSTS, work.length) }, worker),
	);

	const all = loadResults();
	report(all);
	if (APPLY) for (const city of CITIES) applyPromotions(city, all);
	else console.log("\nDry run — rerun with --apply to promote verified sources.");
}

await main();
