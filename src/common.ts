import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_ROOT = resolve(__dirname, "..");
// Overridable so tests can point the on-disk caches at a scratch directory
// instead of writing into the repo's real data dir.
export const DATA_ROOT =
	process.env.EVENTYR_DATA_ROOT ?? join(PROJECT_ROOT, "data");
export const SOURCES_ROOT = join(PROJECT_ROOT, "sources");

// Values shared with the browser bundle live in shared.ts, which must stay
// free of node: imports — importing this file from app/ code drags node:fs
// into Vite and fails the build. Re-exported here so pipeline modules keep
// importing everything from common.ts.
export {
	byScoreThenSoonest,
	CATEGORIES,
	CATEGORY_EMOJI,
	type Category,
	type CostLocale,
	DEFAULT_COST_LOCALE,
	eventHash,
	eventPath,
	eventSlug,
	isLikelyImageUrl,
	KEY_TO_SLUG,
	normaliseCurrency,
	normaliseText,
	SITE_URL,
	slugify,
	TOP_PICK_THRESHOLD,
} from "./shared.ts";

export const INTERESTS = `
WANT:
  - Intellectually stimulating talks, lectures, salons, workshops, panels, and debates focused on science, philosophy, psychology, technology, systems thinking, futurism, culture, design, history, AI, human behavior, or creativity
  - Events that attract curious, thoughtful, open-minded, creative, adventurous, or intellectually engaged people rather than purely corporate audiences
  - Community-oriented recurring events where people naturally talk before/after: book clubs, philosophy groups, writing circles, language exchanges, discussion salons, coworking socials, maker spaces, creative communities
  - Creative or hands-on workshops: photography, writing, pottery, drawing, music, woodworking, craft, electronics, robotics, fermentation, gardening, maker/hacker culture
  - Live experiences with strong atmosphere or artistic value: indie music, jazz, folk, intimate gigs, theatre (fringe, immersive, experimental, and mainstream), art exhibitions, experimental performances, film screenings, comedy nights and stand-up
  - Outdoor and adventure-oriented social events like hiking groups, trail running, climbing, scuba/freediving, paragliding, camping, adventure travel, nature excursions
  - Wellness-oriented events only if grounded and socially authentic: yoga, breathwork, meditation, sauna, movement workshops — avoid overly commercial or cult-like spirituality
  - Free or low-cost local community events preferred

PREFER:
  - Smaller events over massive crowds
  - Events where conversation between strangers is natural
  - Events with recurring communities or regular attendees
  - Authentic subcultures over polished corporate experiences
  - Mixed-age crowds with thoughtful or interesting people
  - Events that feel exploratory, creative, intellectually alive, or inspiring

SKIP ENTIRELY — do not include:
  - Spectator sports of any kind (rugby, cricket, football, racing, etc.)
  - Generic corporate networking events or recruitment / career expos
  - "Business opportunity" seminars, MLMs, hustle culture, crypto hype, or sales funnels
  - Ultra-touristy events designed mainly for Instagram/photos
  - Generic nightclub events or heavy drinking culture
  - Influencer-style wellness events with little substance
  - Online-only events unless strongly tied to the local community
`;

export const SOURCE_TIERS = [
	"aggregators",
	"institutions",
	"independents",
] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];

/**
 * One event source, in whichever of the two ways we can collect from it:
 *
 *  - method: "scraper" — we know its real listing URL and fetch/parse it
 *    ourselves (src/adapters/). Deterministic, cheap, exact.
 *  - method: "llm" — we don't (SPA, no usable listing page, login-walled
 *    platform), so an LLM web search covers it instead.
 *
 * Both live in the same per-city file grouped under the same tiers, so
 * there's one source of truth per city and flipping a source from search to
 * scrape is a one-field edit rather than a move between files.
 */
export interface SourceEntry {
	name: string;
	method: "llm" | "scraper";
	/** Hostnames this source owns, incl. aliases/redirect targets. */
	domains?: string[];
	// --- scraper-only, ignored for method: "llm" ---
	/** Stable slug; also names the scraped output file. */
	id?: string;
	homepage?: string;
	/** Verified listing pages to fetch. Required when method is "scraper". */
	listingUrls?: string[];
	/**
	 * Which extraction path actually worked when this source was last probed.
	 * Descriptive only — pageAdapter re-decides per page at fetch time
	 * (JSON-LD, then embedded hydration JSON, then the LLM over page text),
	 * so this never switches behaviour. Only the two values the adapter can
	 * actually produce are allowed.
	 */
	strategy?: "jsonld" | "html";
	venue?: {
		name?: string | null;
		address?: string | null;
		suburb?: string | null;
	};
	note?: string;
}

export interface CityConfig {
	name: string;
	timezone?: string;
	/**
	 * Where the city is, and how far out still counts as being in it. Used to
	 * throw out events that a national source listed under this city (see
	 * src/locality.ts). Optional: without it the locality check is skipped and
	 * every event is kept, so an unconfigured city degrades rather than breaks.
	 */
	centre?: { lat: number; lng: number; radiusKm: number };
	/**
	 * How this city's prices are written. Defaults to en-AU/AUD
	 * (DEFAULT_COST_LOCALE); a city outside Australia has to set both, and
	 * curate copies them into data/{city}.json for the browser.
	 */
	locale?: string;
	currency?: string;
	sources: Record<SourceTier, SourceEntry[]>;
}

export function loadCityConfig(cityKey: string): CityConfig {
	const sourcesPath = join(SOURCES_ROOT, `${cityKey}.yml`);
	let raw: string;
	try {
		raw = readFileSync(sourcesPath, "utf-8");
	} catch {
		throw new Error(
			`Unknown city '${cityKey}'. No file at ${sourcesPath}. Run src/add_city.ts to add it.`,
		);
	}
	const cfg = yaml.load(raw) as CityConfig;
	for (const tier of SOURCE_TIERS) {
		for (const entry of cfg.sources?.[tier] ?? []) {
			if (entry.method !== "llm" && entry.method !== "scraper") {
				throw new Error(
					`${sourcesPath}: source "${entry.name}" has invalid method ${JSON.stringify(entry.method)} (expected "llm" or "scraper")`,
				);
			}
		}
	}
	return cfg;
}

/** Where collect-adapters records scraper sources that produced nothing, so
 * the AI search can cover for them. */
export function barrenSourcesPath(city: string): string {
	return join(DATA_ROOT, city, "adapters", "barren.json");
}

/**
 * Which scraper sources produced nothing in this week's scrape pass.
 *
 * Returns null when there is no report for the current week — meaning the
 * scrape pass has not run, or died before reporting. That is deliberately
 * distinct from "an empty list": the caller then treats every scraper source
 * as uncovered and hands them all to the search. Failing the other way (the
 * scrape crashes, no report is written, and the search skips those sources
 * because they are marked `scraper`) drops them from BOTH paths at once and
 * still exits green — which is how a whole city's coverage could silently
 * disappear.
 */
function barrenSourceNames(
	city: string,
	weekStart: string,
): Set<string> | null {
	try {
		const report = JSON.parse(
			readFileSync(barrenSourcesPath(city), "utf-8"),
		) as { week_start?: string; names?: string[] };
		if (report.week_start !== weekStart) return null;
		return new Set(report.names ?? []);
	} catch {
		return null;
	}
}

/**
 * Sources in a tier still collected by LLM web search, rendered back into the
 * "Name (domain)" prose the search prompts are built from.
 *
 * Includes scraper sources whose last scrape returned nothing: a listing URL
 * that rots (site redesign, a WAF that starts blocking us) would otherwise
 * drop that source to zero coverage silently, since promotion removes it from
 * the search list. Falling back costs one source's worth of search budget;
 * not falling back costs the venue entirely.
 */
export function llmSourceStrings(
	cfg: CityConfig,
	tier: string,
	cityKey?: string,
): string[] {
	const entries = cfg.sources?.[tier as SourceTier] ?? [];
	const barren = cityKey
		? barrenSourceNames(cityKey, toISODate(getWeekRange().monday))
		: new Set<string>();
	return entries
		.filter((e) => e.method === "llm" || barren === null || barren.has(e.name))
		.map((e) => (e.domains?.[0] ? `${e.name} (${e.domains[0]})` : e.name));
}

/** Every scraper-backed source across all tiers, paired with its tier. */
export function scraperSources(
	cfg: CityConfig,
): { entry: SourceEntry; tier: SourceTier }[] {
	const out: { entry: SourceEntry; tier: SourceTier }[] = [];
	for (const tier of SOURCE_TIERS) {
		for (const entry of cfg.sources?.[tier] ?? []) {
			if (entry.method === "scraper") out.push({ entry, tier });
		}
	}
	return out;
}

/**
 * The Monday–Sunday week the digest is for, in host local time (the workflow
 * pins TZ=Australia/Brisbane).
 *
 * Sunday belongs to the *coming* week on purpose: the digest runs Sunday
 * morning for the week starting tomorrow, so the cron schedule depends on this
 * branch. Every other day maps to the week already under way.
 */
export function getWeekRange(today = new Date()): {
	monday: Date;
	sunday: Date;
} {
	today = new Date(today);
	today.setHours(0, 0, 0, 0);
	// JS getDay(): 0=Sun, 1=Mon...6=Sat.
	const day = today.getDay();
	const daysToMonday = day === 0 ? 1 : 1 - day;
	const monday = new Date(today);
	monday.setDate(today.getDate() + daysToMonday);
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	return { monday, sunday };
}

export function fmtDate(d: Date): string {
	// e.g. "12 May 2025"
	return d.toLocaleDateString("en-AU", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

export function toISODate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) throw new Error(`${name} env var is required`);
	return val;
}

export function curatedPath(
	city: string,
	provider: string,
	tier: string,
): string {
	return join(DATA_ROOT, city, provider, "curated", `${tier}.json`);
}

// Adapter framework paths (see src/adapters/) — raw fetch bodies are
// persisted per source as both a debugging artifact and a source of test
// fixtures; the cache file tracks ETag/Last-Modified per URL for
// conditional GET.
export function adapterRawDir(sourceId: string): string {
	return join(DATA_ROOT, "_raw", sourceId);
}

export function adapterCachePath(sourceId: string): string {
	return join(DATA_ROOT, "_cache", `${sourceId}.json`);
}

export interface EventFingerprint {
	title: string;
	date: string;
}

export function diceSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const getBigrams = (s: string): Map<string, number> => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const bg = s.slice(i, i + 2);
			m.set(bg, (m.get(bg) ?? 0) + 1);
		}
		return m;
	};
	const aMap = getBigrams(a);
	const bMap = getBigrams(b);
	let inter = 0;
	for (const [bg, count] of aMap) {
		inter += Math.min(count, bMap.get(bg) ?? 0);
	}
	return (2 * inter) / (a.length + b.length - 2);
}

function normalizeTitle(title: string): string {
	return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export function fingerprintEvent(
	event: Record<string, unknown>,
): EventFingerprint {
	return {
		title: normalizeTitle((event.title as string) ?? ""),
		date: (
			(event.datetime_iso as string) ??
			(event.datetime as string) ??
			""
		).slice(0, 10),
	};
}

// The same event often shows up once bare ("Board Game Weekly Meetup") and
// once with a venue suffix from a different source ("Board Game Weekly
// Meetup @ Vault Games Brisbane City") — a straight Dice comparison
// undercounts these because the extra suffix dominates the bigram overlap.
// Catch that case with a prefix/containment check before falling back to
// fuzzy matching for typos/reordering.
function titlesMatch(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a))) {
		return true;
	}
	return diceSimilarity(a, b) > 0.85;
}

export function isDuplicateEvent(
	a: EventFingerprint,
	b: EventFingerprint,
): boolean {
	// Both dates must be known and equal. Treating a missing date as
	// "matches anything" let one undated artifact swallow every event whose
	// title it prefixed: ["Live Music" (no date), "Live Music at The Triffid"
	// (3 Sep), "Live Music Sundays" (7 Sep)] collapsed to just the artifact,
	// because the fingerprint scan keeps the first occurrence. Keeping a
	// duplicate is recoverable; deleting a real event is not.
	if (!a.date || !b.date || a.date !== b.date) return false;
	return titlesMatch(a.title, b.title);
}

export function dedupeEvents(
	events: Record<string, unknown>[],
): Record<string, unknown>[] {
	const seen: EventFingerprint[] = [];
	const unique: Record<string, unknown>[] = [];
	for (const event of events) {
		const fp = fingerprintEvent(event);
		if (!seen.some((s) => isDuplicateEvent(fp, s))) {
			unique.push(event);
			seen.push(fp);
		}
	}
	return unique;
}
