// Why is a source not on the scrape path? Answered offline, from evidence
// already on disk — no network, no model, no cost.
//
// This exists because `method: llm` was being read as a verdict ("this site
// cannot be scraped") when it is really four different states wearing one
// label:
//
//   - never looked at          (76% of them, when this was written)
//   - looked at the wrong page (every candidate was a 404 on a guessed path)
//   - read the right page badly (rich page, 0 events extracted)
//   - genuinely nothing there  (every date on the page is in the past)
//
// Those need opposite remedies, and collapsing them hides a coverage bug
// behind a plausible-looking number. So each source gets exactly one cause
// plus the evidence for it, and the report prints ratios rather than totals.
//
// Everything here is derived from data/_probe/results.jsonl (per-attempt
// signals probe already persists) and the bodies in data/_raw, so a threshold
// can be re-tuned for free and the whole run is reproducible offline.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	adapterRawDir,
	DATA_ROOT,
	isSameSite,
	loadCityConfig,
	loadYieldLedger,
	normaliseHost,
	SOURCE_TIERS,
	SOURCES_ROOT,
	type SourceEntry,
	type SourceTier,
} from "../common.ts";

/** Mirrors the rows probe.ts appends to results.jsonl. Declared structurally
 * rather than imported because probe.ts is a CLI with top-level side effects;
 * only the fields triage reads are listed. */
interface ProbeAttempt {
	url: string;
	via: string;
	textLength: number;
	dateHits: number;
	jsonLdNodes: number;
	events: number | null;
	dated?: number;
	inWindow?: number;
	past?: number;
	outcome: string;
}

interface ProbeRow {
	city: string;
	tier: SourceTier;
	name: string;
	host: string | null;
	probedAt: string;
	classification: string;
	attempts: ProbeAttempt[];
	errors: string[];
	signals: { url: string; textLength: number; dateHits: number } | null;
}

/**
 * Causes, most actionable first. One per source: the first rule that matches
 * wins, so the order below is the priority order and the cheapest remedy is
 * always reported over a more speculative one.
 */
export const CAUSES = [
	"unprobed",
	"no-domain",
	"robots-disallowed",
	"feed-available",
	"platform-hosted",
	"embed-only",
	"bot-wall",
	"unapplied",
	"gate-only",
	"archive-only",
	"starved",
	"read-badly",
	"sub-threshold",
	"wrong-page",
	"dead",
	"platform",
	"scraped-already",
	"unexplained",
] as const;

export type Cause = (typeof CAUSES)[number];

/** What each cause means and what to do about it — printed with the report so
 * the next action needs no re-derivation. */
const REMEDY: Record<Cause, string> = {
	unprobed: "run probe-sources for this city",
	"no-domain": "needs a human: no domain in the YAML entry",
	// Historical only: probe no longer performs a robots permission check, so
	// rows carrying this classification predate that and are worth re-probing.
	"robots-disallowed": "stale verdict — re-probe, robots is no longer checked",
	"bot-wall": "no feed and the HTML is walled — render once to find a path",
	"feed-available": "read the event API the page advertises",
	"platform-hosted":
		"hosting signature only — measured as mostly dormant, do not chase",
	"embed-only": "follow the widget iframe to its own data",
	unapplied: "probe verified it; the promotion was never written to the YAML",
	"gate-only": "promotion gate rejected a real listing page",
	"archive-only": "every date is past — verified negative, not a failure",
	starved: "more ranked candidates than MAX_EVALUATIONS allows",
	"read-badly": "page has content and dates; extraction produced nothing",
	"sub-threshold": "just under MIN_TEXT_LENGTH — arbitrary cutoff casualty",
	"wrong-page": "never fetched a real listing; only guessed paths 404'd",
	dead: "DNS/timeout — likely genuinely gone",
	platform: "ticketing platform, excluded by regex",
	"scraped-already": "on the scrape path",
	unexplained: "needs the model pass (Phase 2)",
};

// --- thresholds -----------------------------------------------------------
// Kept here rather than imported from probe.ts so triage can re-derive
// against a *different* value than the one a past run used — that is the
// whole point of being offline.

/** probe.ts MIN_TEXT_LENGTH. */
const MIN_TEXT_LENGTH = 1200;
/** Within this fraction of the cutoff, a rejection is the cutoff's fault
 * rather than the page's. crowbar 1164 / milani 1192 vs a 1200 gate. */
const SUB_THRESHOLD_BAND = 0.25;
/** probe.ts MIN_DATED_TO_PROMOTE / MIN_IN_WINDOW_TO_PROMOTE. */
const MIN_DATED = 3;
const MIN_IN_WINDOW = 2;
/** probe.ts MAX_EVALUATIONS — pages actually extracted per source. */
const MAX_EVALUATIONS = 2;
/** A page this long with this many date mentions plainly had content, so
 * extracting zero from it is an extraction failure, not an empty listing. */
const RICH_TEXT = 3000;
const RICH_DATE_HITS = 5;

/** Feed and API signatures, matched against a cached body. Each one is a
 * *deterministic* access path — a URL we can fetch and parse without a model.
 * The wp-json entry deliberately matches the API root and not a plugin path:
 * guessing `tribe/events/v1` across 24 hosts scored 1/24, while asking
 * `/wp-json/` for its own route list found Modern Events Calendar on two of
 * the same hosts. Ask the root; never guess the plugin. */
const FEED_SIGNATURES: [label: string, pattern: RegExp][] = [
	["events-calendar", /wp-json\/tribe\/events/i],
	["modern-events-calendar", /wp-json\/mec\/|wp\/v2\/mec-events/i],
	["wp-json", /\/wp-json\//i],
	["squarespace", /squarespace|static1\.squarespace\.com/i],
	["wix", /wix\.com|wixstatic/i],
	["ical", /\.ics\b|\?ical=1|text\/calendar|webcal:/i],
	["rss", /rel=["']alternate["'][^>]+type=["']application\/rss/i],
];

/** Widget hosts whose iframe carries the venue's own listing. Distinct from
 * the `platform` exclusion: an embed on a venue's page is that venue's data,
 * not a city-wide aggregator account. */
/**
 * Signatures that evidence an actual event API, as opposed to evidencing which
 * platform built the site.
 *
 * The distinction is measured, not assumed. Eight byron sources flagged
 * "squarespace" were checked against their real collection paths (taken from
 * probe's cached sitemaps rather than guessed): every one returned
 * `upcoming: 0`. Several had genuine events collections behind them — 30, 25
 * and 19 *past* events — i.e. dormant halls and galleries, not extraction
 * failures.
 *
 * That matters because promoting them would be worse than leaving them alone:
 * a feed reporting nothing marks the source barren, and llmSourceStrings()
 * hands a barren source straight back to the AI search — so we would buy a
 * weekly fetch to arrive exactly where we started. A hosting signature is a
 * lead, not a finding.
 */
const EVENT_API_SIGNATURES = new Set([
	"events-calendar",
	"modern-events-calendar",
	"ical",
]);

const EMBED_HOSTS =
	/<iframe[^>]+src=["'][^"']*(humanitix|eventbrite|bandsintown|tockify|songkick|ticketspice|trybooking)/i;

/** A shell that only tells a browser to come back. Every bot-walled host in
 * the byron list serves one of these for *every* URL, including robots.txt. */
const RELOAD_SHELL =
	/<meta[^>]+http-equiv=["']refresh["']|location\.reload\(\)|window\.location\s*=\s*window\.location/i;

export interface TriageEntry {
	city: string;
	tier: SourceTier;
	name: string;
	host: string | null;
	method: SourceEntry["method"];
	cause: Cause;
	remedy: string;
	/** The specific evidence that chose this cause — a host, a URL, a count.
	 * Named so the next action needs no re-derivation. */
	evidence: string;
	classification: string | null;
	bestDated: number;
	bestInWindow: number;
	bestPast: number;
	/** Deterministic access paths found in the cached bodies, if any. */
	feeds: string[];
}

// --- cached-body inspection ----------------------------------------------

/** Every cached body for a source id, newest first. Probe stores its own
 * fetches under a `probe--<host>` id, collect under the source slug, so both
 * spellings are tried. */
function cachedBodies(sourceIds: string[]): string[] {
	const paths: string[] = [];
	for (const id of sourceIds) {
		const dir = adapterRawDir(id);
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir).sort().reverse()) paths.push(join(dir, f));
	}
	return paths;
}

/** ponytail: reads at most this many bodies per source and this many bytes of
 * each. The signatures we look for live in <head> or in a script tag near it,
 * and one source has 291 MB of cached pages. Raise both if a signature is
 * ever found to sit past the cap. */
const MAX_BODIES_PER_SOURCE = 4;
const MAX_BODY_BYTES = 512 * 1024;

interface BodyEvidence {
	feeds: string[];
	hasEmbed: boolean;
	/** Same body served for every distinct URL — the bot-wall signature. */
	uniformBody: boolean;
	reloadShell: boolean;
	bodiesRead: number;
}

function inspectBodies(sourceIds: string[]): BodyEvidence {
	const out: BodyEvidence = {
		feeds: [],
		hasEmbed: false,
		uniformBody: false,
		reloadShell: false,
		bodiesRead: 0,
	};
	const sizes = new Set<number>();
	const feeds = new Set<string>();
	const paths = cachedBodies(sourceIds).slice(0, MAX_BODIES_PER_SOURCE);
	for (const p of paths) {
		let html: string;
		try {
			html = readFileSync(p, "utf-8").slice(0, MAX_BODY_BYTES);
		} catch {
			continue;
		}
		out.bodiesRead++;
		sizes.add(html.length);
		for (const [label, pattern] of FEED_SIGNATURES) {
			if (pattern.test(html)) feeds.add(label);
		}
		if (EMBED_HOSTS.test(html)) out.hasEmbed = true;
		if (RELOAD_SHELL.test(html)) out.reloadShell = true;
	}
	// Byte-identical responses to different URLs (robots.txt included) mean the
	// server is answering the fetcher, not the request.
	out.uniformBody = out.bodiesRead >= 2 && sizes.size === 1;
	out.feeds = [...feeds];
	return out;
}

// --- cause assignment -----------------------------------------------------

const SUCCESS = new Set(["html", "jsonld"]);

function bestAttempt(row: ProbeRow): ProbeAttempt | null {
	const dated = row.attempts.filter((a) => (a.dated ?? 0) > 0);
	if (dated.length) {
		return dated.reduce((a, b) => ((b.dated ?? 0) > (a.dated ?? 0) ? b : a));
	}
	return row.attempts[0] ?? null;
}

/** True when every attempt failed before a page was ever read. */
function neverReachedAPage(row: ProbeRow): boolean {
	if (!row.attempts.length) return false;
	return row.attempts.every(
		(a) =>
			a.textLength === 0 ||
			/HTTP \d|ENOTFOUND|ECONN|timed out|Redirected/i.test(a.outcome),
	);
}

export function assignCause(
	entry: SourceEntry,
	row: ProbeRow | null,
	body: BodyEvidence,
): { cause: Cause; evidence: string } {
	if (entry.method === "scraper") {
		return { cause: "scraped-already", evidence: "method: scraper" };
	}
	if (!entry.domains?.length) {
		return { cause: "no-domain", evidence: "no domains in YAML entry" };
	}
	if (!row) {
		return {
			cause: "unprobed",
			evidence: `${entry.domains[0]} absent from results.jsonl`,
		};
	}

	const c = row.classification;
	if (c === "robots-disallowed") {
		return {
			cause: "robots-disallowed",
			evidence: "verdict predates dropping the robots check",
		};
	}
	if (c === "platform") {
		return { cause: "platform", evidence: "excluded as a ticketing platform" };
	}
	if (SUCCESS.has(c)) {
		// Probe cleared it but the YAML still says llm, so the promotion was
		// never written (--apply omitted, or a later discover-sources run
		// overwrote the entry). Free coverage sitting on the floor: the remedy
		// is re-running probe with --apply, not touching any threshold.
		return {
			cause: "unapplied",
			evidence: `probe verified as ${c}, YAML still llm`,
		};
	}

	// A deterministic access path outranks every other remedy — including a bot
	// wall. beachhotel.com.au serves a 76-character JS-reload shell for every
	// HTML URL *and* publishes wp-json/tribe with 384 upcoming events over
	// plain curl. Checking the wall first would send a browser after data we
	// can already fetch, weekly, forever.
	const eventApis = body.feeds.filter((f) => EVENT_API_SIGNATURES.has(f));
	if (eventApis.length) {
		return { cause: "feed-available", evidence: eventApis.join(", ") };
	}
	if (body.hasEmbed) {
		return { cause: "embed-only", evidence: "events in a widget iframe" };
	}

	const blocked403 = row.errors.some((e) => /HTTP 403/.test(e));
	if (
		blocked403 ||
		body.uniformBody ||
		(c === "spa-empty" && body.reloadShell)
	) {
		const why = blocked403
			? "HTTP 403"
			: body.uniformBody
				? "identical body for every URL"
				: "JS-reload shell";
		return { cause: "bot-wall", evidence: why };
	}

	const best = bestAttempt(row);
	const dated = best?.dated ?? 0;
	const inWindow = best?.inWindow ?? 0;
	const past = best?.past ?? 0;

	if (dated > 0) {
		// The page did yield events. Which of the two gate questions failed?
		if (dated >= MIN_DATED && inWindow < MIN_IN_WINDOW && dated > past) {
			return {
				cause: "gate-only",
				evidence: `${dated} dated, ${inWindow} in window, ${past} past`,
			};
		}
		if (past >= dated) {
			return {
				cause: "archive-only",
				evidence: `${dated} dated, all ${past} past`,
			};
		}
		return {
			cause: "gate-only",
			evidence: `${dated} dated, ${inWindow} in window (below gate)`,
		};
	}

	if (c === "dead" || neverReachedAPage(row)) {
		return { cause: "dead", evidence: row.errors[0]?.slice(0, 80) ?? c };
	}

	// Nothing extracted. Was the page worth extracting from?
	const rich = row.attempts.find(
		(a) => a.textLength >= RICH_TEXT && a.dateHits >= RICH_DATE_HITS,
	);
	if (rich) {
		return {
			cause: "read-badly",
			evidence: `${rich.url} — ${rich.textLength} chars, ${rich.dateHits} date hits, 0 events`,
		};
	}
	const nearMiss = row.attempts.find(
		(a) =>
			a.textLength > 0 &&
			a.textLength < MIN_TEXT_LENGTH &&
			a.textLength >= MIN_TEXT_LENGTH * (1 - SUB_THRESHOLD_BAND),
	);
	if (nearMiss) {
		return {
			cause: "sub-threshold",
			evidence: `${nearMiss.textLength} chars vs ${MIN_TEXT_LENGTH} cutoff`,
		};
	}
	if (row.attempts.every((a) => /HTTP 404/.test(a.outcome))) {
		return {
			cause: "wrong-page",
			evidence: `${row.attempts.length} attempts, all 404`,
		};
	}
	if (row.attempts.length > MAX_EVALUATIONS) {
		return {
			cause: "starved",
			evidence: `${row.attempts.length} candidates, ${MAX_EVALUATIONS} evaluated`,
		};
	}
	// A hosting signature is the weakest evidence there is, so it only speaks
	// once every page-quality cause has declined to.
	if (body.feeds.length) {
		return { cause: "platform-hosted", evidence: body.feeds.join(", ") };
	}
	return { cause: "unexplained", evidence: `classification ${c}` };
}

// --- driver ---------------------------------------------------------------

function loadProbeRows(): ProbeRow[] {
	const path = join(DATA_ROOT, "_probe", "results.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as ProbeRow);
}

/** Latest probe row per city+host. Probe appends, so the file holds every
 * historical attempt; only the most recent verdict is current. */
function latestByHost(rows: ProbeRow[]): Map<string, ProbeRow> {
	const out = new Map<string, ProbeRow>();
	for (const r of rows) {
		if (!r.host) continue;
		const key = `${r.city}|${r.host}`;
		const prev = out.get(key);
		if (!prev || r.probedAt > prev.probedAt) out.set(key, r);
	}
	return out;
}

/** Probe files its own fetches under `probe--<host with dots replaced>`; the
 * collect path uses the source's own slug. Both are tried. */
function candidateSourceIds(entry: SourceEntry): string[] {
	const ids: string[] = [];
	if (entry.id) ids.push(entry.id);
	for (const d of entry.domains ?? []) {
		ids.push(`probe--${d.replace(/[^a-z0-9]/gi, "_")}`);
		ids.push(d.replace(/[^a-z0-9]/gi, "_"));
	}
	return ids;
}

function cityKeys(): string[] {
	return readdirSync(SOURCES_ROOT)
		.filter((f) => f.endsWith(".yml"))
		.map((f) => f.replace(/\.yml$/, ""));
}

export function runTriage(cities: string[]): TriageEntry[] {
	const byHost = latestByHost(loadProbeRows());
	const out: TriageEntry[] = [];
	for (const city of cities) {
		const cfg = loadCityConfig(city);
		for (const tier of SOURCE_TIERS) {
			for (const entry of cfg.sources?.[tier] ?? []) {
				const host = entry.domains?.[0] ?? null;
				const row = host ? (byHost.get(`${city}|${host}`) ?? null) : null;
				const body =
					entry.method === "scraper"
						? {
								feeds: [],
								hasEmbed: false,
								uniformBody: false,
								reloadShell: false,
								bodiesRead: 0,
							}
						: inspectBodies(candidateSourceIds(entry));
				const { cause, evidence } = assignCause(entry, row, body);
				const best = row ? bestAttempt(row) : null;
				out.push({
					city,
					tier,
					name: entry.name,
					host,
					method: entry.method,
					cause,
					remedy: REMEDY[cause],
					evidence,
					classification: row?.classification ?? null,
					bestDated: best?.dated ?? 0,
					bestInWindow: best?.inWindow ?? 0,
					bestPast: best?.past ?? 0,
					feeds: body.feeds,
				});
			}
		}
	}
	return out;
}

function report(entries: TriageEntry[]): void {
	const failing = entries.filter((e) => e.cause !== "scraped-already");
	const scraped = entries.length - failing.length;
	const byCause = new Map<Cause, TriageEntry[]>();
	for (const e of failing) {
		const list = byCause.get(e.cause) ?? [];
		list.push(e);
		byCause.set(e.cause, list);
	}

	console.log(
		`\n${entries.length} sources · ${scraped} on the scrape path (${((scraped / entries.length) * 100).toFixed(1)}%) · ${failing.length} not\n`,
	);
	for (const cause of CAUSES) {
		const list = byCause.get(cause);
		if (!list?.length) continue;
		const pct = ((list.length / failing.length) * 100).toFixed(1);
		console.log(
			`${cause.padEnd(20)} ${String(list.length).padStart(4)}  ${pct.padStart(5)}%  ${REMEDY[cause]}`,
		);
		// Name the suspects: the identifier plus the input that triggered it.
		for (const e of list.slice(0, 3)) {
			console.log(`  · ${(e.host ?? e.name).padEnd(34)} ${e.evidence}`);
		}
		if (list.length > 3) console.log(`  · … and ${list.length - 3} more`);
	}

	const fixable =
		(byCause.get("feed-available")?.length ?? 0) +
		(byCause.get("unapplied")?.length ?? 0) +
		(byCause.get("gate-only")?.length ?? 0) +
		(byCause.get("embed-only")?.length ?? 0) +
		(byCause.get("sub-threshold")?.length ?? 0) +
		(byCause.get("read-badly")?.length ?? 0);
	console.log(
		`\n${fixable} of ${failing.length} are ours to fix (feed/gate/embed/threshold/extraction), ` +
			`${byCause.get("unprobed")?.length ?? 0} were never probed, ` +
			`${(byCause.get("dead")?.length ?? 0) + (byCause.get("no-domain")?.length ?? 0)} are genuinely out of reach.`,
	);
}

// --- render candidates ----------------------------------------------------
//
// Which walled sources are worth spending a browser on.
//
// A render is ~6s and a browser is the most expensive rung we have, so it must
// not be pointed at pages that would yield nothing. The post-render gate
// (promote only on extracted events) stops a bad source being *kept*, but it
// still pays for the render to find out. This scores each candidate from
// evidence already on disk — no network, no model — so the expensive pass runs
// against a shortlist instead of a bucket.
//
// The problem these signals solve: for the 80 hosts serving one wall page to
// every URL, the cached body tells us nothing at all about the real site. So
// the evidence has to come from somewhere the wall does not reach:
//
//   1. The host's own sitemap. Walls guard HTML; robots.txt and sitemap.xml
//      are usually still served, and a sitemap listing /events/... paths is
//      near-proof the venue publishes events. probe already caches 784 of
//      these.
//   2. What the AI search has actually found there. source-yield.json records
//      the hosts search produced real events from. A walled host that search
//      keeps finding events on definitely has them.
//
// Absence of evidence is reported as `unknown` rather than as "no", because
// these signals are one-directional: a missing sitemap means we cannot tell,
// not that the site is empty.

export interface RenderCandidate {
	city: string;
	host: string;
	name: string;
	/** Event-shaped URLs in the host's own sitemap. */
	sitemapListingUrls: number;
	sitemapTotalUrls: number;
	/** Weeks the AI search produced an event from this host. */
	searchWeeksHit: number;
	evidence: string;
	verdict: "worth-rendering" | "unknown" | "skip";
}

/**
 * Paths that name an events listing. A local copy of probe's LISTING_PATH
 * rather than an import: probe.ts is a CLI with top-level await and
 * argv-reading side effects, and importing it here made looksLikeIndex throw
 * on every call — swallowed by the per-URL catch below, so every sitemap
 * silently scored zero event URLs. Same reason the thresholds above are local.
 */
const LISTING_PATH =
	/\/(whats[-_]?on|what-s-on|events?|event[-_]?calendar|calendar|shows?|performances?|programme?|line[-_]?up|gigs?|gig[-_]?guide|upcoming|exhibitions?|workshops?|classes|screenings?|buy[-_]?tickets|tickets?|this[-_]?week)(\/|$|\?)/i;

/**
 * Event vocabulary beyond probe's LISTING_PATH, used only to decide whether a
 * browser is worth spending. Wider on purpose: a false positive costs one ~6s
 * render, a false negative loses the venue for good, so this errs towards
 * rendering. act1theatre.com.au was being skipped on a sitemap containing
 * /next-production and /book-tickets, neither of which the listing-path regex
 * matches.
 */
const EVENT_WORDS =
	/\/(production|concert|season|recital|performance|festival|market|tour|comedy|quiz|trivia|gig|show|book[-_]?tickets|line[-_]?up|programme?)/i;

/** A dated slug (/2026/09/..., /2026-concert-series) is event content too. */
const DATED_SLUG = /\/(19|20)\d{2}([-/]|$)/;

/**
 * Sitemaps of sites that were never configured. Wix and Squarespace ship
 * placeholder collections, and observatorytheatre.com's entire sitemap is
 * /product-page/i-m-a-product-1..11 — there is genuinely nothing behind it,
 * which is the one case where an absent listing really is proof of absence.
 */
const PLACEHOLDER_SITEMAP = /i-m-a-product|copy-of-|lorem-ipsum|coming-soon/i;

function sitemapEvidence(host: string): {
	listing: number;
	total: number;
	placeholder: boolean;
} {
	const path = join(DATA_ROOT, "_probe", "sitemaps", `${host}.json`);
	if (!existsSync(path)) return { listing: -1, total: -1, placeholder: false };
	try {
		const dump = JSON.parse(readFileSync(path, "utf-8")) as { urls?: string[] };
		const urls = dump.urls ?? [];
		let listing = 0;
		let placeholder = 0;
		for (const u of urls) {
			try {
				const path = new URL(u).pathname;
				if (PLACEHOLDER_SITEMAP.test(path)) placeholder++;
				if (
					LISTING_PATH.test(path) ||
					EVENT_WORDS.test(path) ||
					DATED_SLUG.test(path)
				) {
					listing++;
				}
			} catch {
				// A malformed URL in a third-party sitemap is not worth raising.
			}
		}
		return {
			listing,
			total: urls.length,
			// Half the map being template junk means the site was never filled in.
			placeholder: placeholder * 2 >= urls.length && urls.length > 0,
		};
	} catch {
		return { listing: -1, total: -1, placeholder: false };
	}
}

function searchWeeksHit(city: string, host: string): number {
	const ledger = loadYieldLedger(city);
	if (!ledger) return -1;
	const normalised = normaliseHost(host);
	for (const [key, value] of Object.entries(ledger.sources ?? {})) {
		if (normalised && isSameSite(normalised, key)) {
			return value.weeksHit?.length ?? 0;
		}
	}
	return 0;
}

export function renderCandidates(entries: TriageEntry[]): RenderCandidate[] {
	const out: RenderCandidate[] = [];
	for (const e of entries) {
		// Only the buckets a browser could plausibly change. `dead` is excluded:
		// a DNS failure or refused connection is not something rendering fixes.
		if (!["bot-wall", "unexplained", "sub-threshold"].includes(e.cause)) {
			continue;
		}
		if (!e.host) continue;
		const sm = sitemapEvidence(e.host);
		const hits = searchWeeksHit(e.city, e.host);

		const reasons: string[] = [];
		if (sm.listing > 0) {
			reasons.push(`${sm.listing} event-shaped URL(s) in its sitemap`);
		}
		if (hits > 0)
			reasons.push(`AI search found events here in ${hits} week(s)`);

		let verdict: RenderCandidate["verdict"];
		if (reasons.length > 0) {
			verdict = "worth-rendering";
		} else if (sm.placeholder) {
			// The only defensible skip: a sitemap that is mostly template
			// placeholders was never filled in, so there is nothing to render.
			// A merely keyword-free sitemap is NOT proof — /next-production and
			// /book-tickets are real listings that no keyword list caught.
			verdict = "skip";
			reasons.push(
				`sitemap is mostly unconfigured template pages (${sm.total} URL(s)) — site was never filled in`,
			);
		} else {
			verdict = "unknown";
			reasons.push(
				sm.total > 0
					? `sitemap has ${sm.total} URL(s), none obviously event-shaped — render to find out`
					: sm.total === 0
						? "sitemap served but empty"
						: "no sitemap cached — cannot tell without looking",
			);
		}
		out.push({
			city: e.city,
			host: e.host,
			name: e.name,
			sitemapListingUrls: sm.listing,
			sitemapTotalUrls: sm.total,
			searchWeeksHit: hits,
			evidence: reasons.join("; "),
			verdict,
		});
	}
	// Best evidence first, so a capped run renders the most promising hosts.
	const rank = { "worth-rendering": 0, unknown: 1, skip: 2 };
	return out.sort(
		(a, b) =>
			rank[a.verdict] - rank[b.verdict] ||
			b.sitemapListingUrls - a.sitemapListingUrls ||
			b.searchWeeksHit - a.searchWeeksHit,
	);
}

// Entrypoint last: every const above must be initialised before this runs.
// Appending code after it put the regexes in the temporal dead zone, and the
// per-URL catch swallowed the ReferenceError on every sitemap URL.
if (process.argv[1]?.endsWith("triage.ts")) {
	const cityArg = process.argv.slice(2).find((a) => a.startsWith("--city="));
	const cities = cityArg ? [cityArg.split("=")[1]] : cityKeys();
	const entries = runTriage(cities);
	const outPath = join(DATA_ROOT, "_probe", "triage.json");
	writeFileSync(outPath, `${JSON.stringify(entries, null, 2)}\n`);

	if (process.argv.includes("--render-candidates")) {
		const cands = renderCandidates(entries);
		const path = join(DATA_ROOT, "_probe", "render-candidates.json");
		writeFileSync(path, `${JSON.stringify(cands, null, 2)}\n`);
		const by = { "worth-rendering": 0, unknown: 0, skip: 0 };
		for (const c of cands) by[c.verdict]++;
		console.log(
			`\n${cands.length} walled source(s) a browser could change:\n` +
				`  ${by["worth-rendering"]} worth rendering · ${by.unknown} unknown · ${by.skip} skip\n`,
		);
		for (const c of cands.filter((x) => x.verdict === "worth-rendering")) {
			console.log(`  + ${c.host.padEnd(34)} ${c.evidence}`);
		}
		console.log(`\n→ ${path}`);
	} else {
		report(entries);
		console.log(`\n→ ${outPath}`);
	}
}
