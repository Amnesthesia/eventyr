// Gives every event a canonical `venue_name`, so the site can list everything
// at one venue and "QAG" and "Queensland Art Gallery" are one venue, not two.
//
// There was no venue field to filter on: `event.venue` is the source tier
// (curate.ts), and the real venue exists only inside the free-text `location`
// ("GOMA, Stanley Place, South Bank"). Its first comma segment is the raw
// venue — a good key on its own (Brisbane: "South Bank Parklands" 32 events,
// "Museum of Brisbane" 20), but no string rule connects an acronym to its full
// name or knows that "WeekendNotes Brisbane" is a website, not a place.
// Coordinates cannot settle it either: GOMA, QAG and the State Library share
// an address.
//
// Resolution, cheapest first, each raw string once ever:
//   1. `venue.aliases` in sources/{city}.yml — the manual override, checked
//      before the cache so a wrong merge is fixed by one YAML line.
//   2. data/{city}/venues.json — every earlier answer, committed like
//      locations.json.
//   3. Deterministic rules: same normalised name as a known venue, acronym of
//      a known venue (acronymMatch, shared with dedupe), or the bare city name
//      (not a venue).
//   4. Gemini for the remainder, constrained to indices into the lists it was
//      sent. The model proposes which names are the same place; code picks the
//      display name (the spelling with the most events), so a name never
//      depends on the model's phrasing.
//
// Standalone stage after curate rather than inside it, so it can also run
// over already-published data with no re-curation.

import "./llmBootstrap.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ask, parseJsonArray } from "@dothingslol/llm";
import { chunkArray } from "@dothingslol/utils/concurrency";
import {
	DATA_ROOT,
	loadCityConfig,
	requireEnv,
	SOURCE_TIERS,
} from "./common.ts";
import { acronymMatch } from "./dedupe.ts";
import { installUsageReporting } from "./io/usage.ts";

// Not flash-lite: on the first Gold Coast run it merged "Mudgeeraba Studio"
// into "Benowa Studio" despite the prompt's branch rule. Every answer is
// cached for good, so the bigger model is paid once per venue name.
const VENUE_MODEL = "gemini-3.5-flash";
/** Bump when the prompt, model or rawVenue changes: cached answers were
 * answers to them. */
export const VENUE_PROMPT_VERSION = 5;
/** Matching is cross-item reasoning, so batches stay small enough to keep
 * every name in view. The steady-state week has fewer new names than this. */
const BATCH_SIZE = 40;

/** Raw venue string ⇒ canonical name, or null for "not a venue". */
export interface VenueCache {
	prompt_version: number;
	map: Record<string, string | null>;
}

/** The model's verdict on one new name, keyed by the index it was sent. */
export interface VenueJudgement {
	i: number;
	/** Index into the known-venue list, when it is one of those. */
	known: number | null;
	/** Index of an earlier name in the same batch that is the same place. */
	same_as: number | null;
	not_venue: boolean;
}

/** Injectable so tests never touch the network — same pattern as
 * PairClassifyFn in dedupe.ts. Null means the call failed, which is not the
 * same as "every name is new". */
export type VenueClassifyFn = (
	known: string[],
	batch: { name: string; sample: string }[],
) => Promise<VenueJudgement[] | null>;

export interface VenueStats {
	raw: number;
	venues: number;
	alias: number;
	cached: number;
	rule: number;
	model: number;
	notVenue: number;
	/** Names the model was not asked about or failed on: used as-is this run,
	 * not cached, asked again next run. */
	unresolved: number;
}

/** A floor or unit, not a place: "Level 1, 36 Scarborough Street" named its
 * venue "Level 1" and the model then merged it with "Level 5". */
const FLOOR_SEGMENT = /^(level|lvl|floor|shop|suite|unit)\s*\d+[a-z]?$/i;

/** First comma (or "·") segment of a location string, skipping a leading
 * floor/unit. "" when there is none. */
export function rawVenue(location: unknown): string {
	if (typeof location !== "string") return "";
	const segments = location
		.split(/[,·]/)
		.map((s) => s.trim())
		.filter(Boolean);
	return segments.find((s) => !FLOOR_SEGMENT.test(s)) ?? segments[0] ?? "";
}

/** Two names carrying different numbers are different places, whatever the
 * model says ("Level 5" is not "Level 1", "Studio 56" is not "Studio 5").
 * A number on one side only is no evidence either way ("HOTA Gallery 2"). */
export function numbersConflict(a: string, b: string): boolean {
	const nums = (v: string): string => (v.match(/\d+/g) ?? []).join(" ");
	const na = nums(a);
	const nb = nums(b);
	return na !== "" && nb !== "" && na !== nb;
}

/** Comparison key: case, punctuation and a leading "the" never distinguish
 * two venues. */
export function venueKey(name: string): string {
	return name
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^the /, "");
}

/** alias key ⇒ canonical, from every `venue.aliases` in the city's sources. */
export function aliasMap(
	entries: { venue?: { name?: string | null; aliases?: string[] } }[],
): Map<string, string> {
	const out = new Map<string, string>();
	for (const entry of entries) {
		const name = entry.venue?.name;
		if (!name) continue;
		for (const alias of entry.venue?.aliases ?? []) {
			out.set(venueKey(alias), name);
		}
	}
	return out;
}

/** Deterministic match against the venues already known. Undefined = no
 * rule applies, null = not a venue. */
function ruleMatch(
	raw: string,
	known: string[],
	cityKey: string,
): string | null | undefined {
	const key = venueKey(raw);
	if (!key || key === cityKey) return null;
	for (const k of known) if (venueKey(k) === key) return k;
	for (const k of known) if (acronymMatch(key, venueKey(k))) return k;
	return undefined;
}

export async function resolveVenues(opts: {
	/** Raw venue ⇒ how many events carry it (decides display names). */
	counts: Map<string, number>;
	/** A full location string per raw venue, as context for the model. */
	samples: Map<string, string>;
	cache: VenueCache;
	cityName: string;
	aliases: Map<string, string>;
	classify?: VenueClassifyFn;
	/** Called after each model batch lands, to flush the cache. */
	onBatch?: (cache: VenueCache) => void;
}): Promise<{
	resolved: Map<string, string | null>;
	stats: VenueStats;
	/** [raw, canonical] for every merge and rename made this run. */
	merges: [string, string][];
}> {
	const { counts, samples, cache, aliases, classify } = opts;
	const cityKey = venueKey(opts.cityName);
	const resolved = new Map<string, string | null>();
	const stats: VenueStats = {
		raw: counts.size,
		venues: 0,
		alias: 0,
		cached: 0,
		rule: 0,
		model: 0,
		notVenue: 0,
		unresolved: 0,
	};
	const aliasTargets = new Set(aliases.values());
	const known = new Set<string>(aliasTargets);
	for (const v of Object.values(cache.map)) if (v) known.add(v);
	/** Raws resolved this run, for the merge report. */
	const fresh: string[] = [];
	const renames: [string, string][] = [];

	/**
	 * Records raw ⇒ canonical. When the raw is the canonical minus trailing
	 * words, the venue takes the shorter name: the most frequent spelling is
	 * often the noisiest ("HOTA Lake Precinct", "Miami Marketta (18+)",
	 * "Currumbin Wildlife Sanctuary events" all won their groups on the first
	 * Gold Coast run). A word-boundary prefix, not any substring, or "Art
	 * Gallery" would rename "Ipswich Art Gallery". An acronym never qualifies,
	 * and an alias target is never renamed — it is the manual override.
	 */
	const assign = (raw: string, canonical: string | null): void => {
		let name = canonical && numbersConflict(raw, canonical) ? raw : canonical;
		const rawKey = venueKey(raw);
		if (
			name &&
			rawKey &&
			!aliasTargets.has(name) &&
			venueKey(name).startsWith(`${rawKey} `)
		) {
			for (const [k, v] of Object.entries(cache.map)) {
				if (v === name) cache.map[k] = raw;
			}
			for (const [k, v] of resolved) if (v === name) resolved.set(k, raw);
			known.delete(name);
			renames.push([name, raw]);
			name = raw;
		}
		resolved.set(raw, name);
		cache.map[raw] = name;
		if (name) known.add(name);
		fresh.push(raw);
	};

	// Most events first, so the common spelling becomes the canonical one and
	// the rare variants match against it.
	const raws = [...counts.keys()].sort(
		(a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b),
	);
	const pending: string[] = [];
	for (const raw of raws) {
		const alias = aliases.get(venueKey(raw));
		if (alias) {
			resolved.set(raw, alias);
			fresh.push(raw);
			stats.alias++;
			continue;
		}
		if (raw in cache.map) {
			resolved.set(raw, cache.map[raw]);
			stats.cached++;
			continue;
		}
		const rule = ruleMatch(raw, [...known], cityKey);
		if (rule !== undefined) {
			assign(raw, rule);
			stats.rule++;
			continue;
		}
		pending.push(raw);
	}

	// Serial on purpose: each batch is matched against the venues the previous
	// batches created, which is what lets "QAG" in batch 1 absorb "Queensland
	// Art Gallery" in batch 3. Only the first run over a city has more than one
	// batch.
	for (const batch of classify ? chunkArray(pending, BATCH_SIZE) : []) {
		const knownList = [...known];
		const judgements = await classify?.(
			knownList,
			batch.map((name) => ({ name, sample: samples.get(name) ?? name })),
		);
		if (!judgements) continue;
		// Validate before trusting: an index outside what was sent, or a
		// same_as pointing forward/at itself, is ignored rather than guessed.
		const byIndex = new Map<number, VenueJudgement>();
		for (const j of judgements) {
			if (Number.isInteger(j?.i) && j.i >= 0 && j.i < batch.length) {
				byIndex.set(j.i, j);
			}
		}
		const valid = (n: number | null, below: number): n is number =>
			Number.isInteger(n) && (n as number) >= 0 && (n as number) < below;
		for (const [i, raw] of batch.entries()) {
			const j = byIndex.get(i);
			if (!j) continue;
			stats.model++;
			if (j.not_venue === true) {
				assign(raw, null);
			} else if (valid(j.known, knownList.length)) {
				// An earlier item in this batch may have renamed the known venue
				// since the list was sent.
				assign(raw, currentName(knownList[j.known]));
			} else if (valid(j.same_as, i) && resolved.has(batch[j.same_as])) {
				// Earlier in the batch = more events (sorted above), so the
				// group's first member already holds the display name.
				assign(raw, resolved.get(batch[j.same_as]) ?? null);
			} else {
				assign(raw, raw);
			}
		}
		opts.onBatch?.(cache);
	}

	/** Where a renamed canonical went. */
	function currentName(name: string): string {
		let n = name;
		for (const [from, to] of renames) if (from === n) n = to;
		return n;
	}

	for (const raw of pending) {
		if (resolved.has(raw)) continue;
		// Failed to look, not "nothing there": used as its own name, never
		// cached, so the next run asks again.
		resolved.set(raw, raw);
		stats.unresolved++;
	}
	// A renamed canonical is usually also a fresh raw, so key by pair.
	const mergeMap = new Map<string, [string, string]>();
	for (const raw of fresh) {
		const v = resolved.get(raw);
		if (v && v !== raw) mergeMap.set(`${raw}\0${v}`, [raw, v]);
	}
	for (const [from, to] of renames) {
		mergeMap.set(`${from}\0${currentName(to)}`, [from, currentName(to)]);
	}
	const merges = [...mergeMap.values()];
	const names = new Set<string>();
	for (const v of resolved.values()) {
		if (v === null) stats.notVenue++;
		else names.add(v);
	}
	stats.venues = names.size;
	return { resolved, stats, merges };
}

const SYSTEM_PROMPT = `You match venue names for a city's event listings. You are given KNOWN venues (already canonical) and NEW names, each list numbered from 0, each NEW name with the full location string it came from. Every index you return is a plain JSON integer.

For every NEW name, return one object:
- "i": its index.
- "known": the index of the KNOWN venue that is the same physical place, else null.
- "same_as": the index of an EARLIER new name (lower index) that is the same physical place, else null.
- "not_venue": true when the name is not a physical venue at all: a bare city/suburb/region name, "Multiple locations", "Various", "Online", "TBA", or a website/ticketing/organiser brand rather than a place (e.g. "WeekendNotes Brisbane"). Otherwise false.

Same place means the same building or site under a different spelling, abbreviation or acronym ("QAG" = "Queensland Art Gallery", "The Tivoli" = "Tivoli Theatre"). Neighbouring or related institutions are DIFFERENT places (GOMA and QAG are different; a library and the museum next door are different). A branch in a different suburb is a different place, and a name covering several branches ("Benowa and Mudgeeraba Studios") is not the same place as one of them. When unsure, answer null — a missed merge is harmless, a wrong one hides events.

Return ONLY a compact JSON array. No markdown, no commentary.`;

function buildUser(
	cityName: string,
	known: string[],
	batch: { name: string; sample: string }[],
): string {
	const knownLines = known.map((k, i) => `${i}: ${k}`).join("\n") || "(none)";
	const newLines = batch
		.map((b, i) =>
			b.sample === b.name
				? `${i}: ${b.name}`
				: `${i}: ${b.name} — "${b.sample}"`,
		)
		.join("\n");
	return `City: ${cityName}\n\nKNOWN:\n${knownLines}\n\nNEW:\n${newLines}`;
}

/** Tolerates "3" and "K3" as well as 3 — the model drifts toward labels. */
function toIndex(v: unknown): number | null {
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const n = Number(v.replace(/^K/i, ""));
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function geminiClassifier(cityName: string): VenueClassifyFn {
	return async (known, batch) => {
		// An empty answer to a non-empty batch is a failure, not "all new":
		// retried once, then reported as failed so nothing is cached from it.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const raw = await ask(buildUser(cityName, known, batch), {
					provider: "gemini",
					model: VENUE_MODEL,
					stage: "venues",
					system: SYSTEM_PROMPT,
					maxOutputTokens: 4096,
					temperature: 0,
					json: true,
					thinking: "off",
				});
				const parsed = parseJsonArray<Record<string, unknown>>(raw, "venues");
				if (parsed.length > 0) {
					return parsed.map((p) => ({
						i: toIndex(p.i) ?? -1,
						known: toIndex(p.known),
						same_as: toIndex(p.same_as),
						not_venue: p.not_venue === true,
					}));
				}
				console.warn(
					`  ⚠ venue batch unparsable (attempt ${attempt + 1}): ${raw.slice(0, 200)} … ${raw.slice(-120)}`,
				);
			} catch (err) {
				console.warn(`  ⚠ venue batch failed: ${(err as Error).message}`);
			}
		}
		return null;
	};
}

export function venueCachePath(city: string): string {
	return join(DATA_ROOT, city, "venues.json");
}

function loadCache(path: string): VenueCache {
	try {
		const c = JSON.parse(readFileSync(path, "utf-8")) as VenueCache;
		if (c.prompt_version === VENUE_PROMPT_VERSION && c.map) return c;
		console.log("  cache prompt version changed — re-resolving every venue");
	} catch {
		// no cache yet
	}
	return { prompt_version: VENUE_PROMPT_VERSION, map: {} };
}

function writeCache(path: string, cache: VenueCache): void {
	mkdirSync(dirname(path), { recursive: true });
	const sorted = Object.fromEntries(
		Object.entries(cache.map).sort(([a], [b]) => a.localeCompare(b)),
	);
	writeFileSync(
		path,
		`${JSON.stringify({ ...cache, map: sorted }, null, 2)}\n`,
		"utf-8",
	);
}

async function main(): Promise<void> {
	installUsageReporting();
	const city = requireEnv("CITY");
	const jsonPath = join(DATA_ROOT, `${city}.json`);
	if (!existsSync(jsonPath)) {
		throw new Error(`✗ ${jsonPath} not found — run curate.ts first.`);
	}
	const payload = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<
		string,
		unknown
	>;
	const events = (payload.events as Record<string, unknown>[]) ?? [];
	const cfg = loadCityConfig(city);

	const counts = new Map<string, number>();
	const samples = new Map<string, string>();
	for (const e of events) {
		const raw = rawVenue(e.location);
		if (!raw) continue;
		counts.set(raw, (counts.get(raw) ?? 0) + 1);
		if (!samples.has(raw)) samples.set(raw, String(e.location).trim());
	}

	const apiKey = process.env.GOOGLE_API_KEY;
	if (!apiKey) {
		console.log(
			"  ⚠ GOOGLE_API_KEY unset — rules only, unmatched names used as-is",
		);
	}
	const cachePath = venueCachePath(city);
	const cache = loadCache(cachePath);
	const { resolved, stats, merges } = await resolveVenues({
		counts,
		samples,
		cache,
		cityName: cfg.name,
		aliases: aliasMap(SOURCE_TIERS.flatMap((t) => cfg.sources?.[t] ?? [])),
		classify: apiKey ? geminiClassifier(cfg.name) : undefined,
		onBatch: (c) => writeCache(cachePath, c),
	});
	writeCache(cachePath, cache);

	for (const e of events) {
		const raw = rawVenue(e.location);
		e.venue_name = raw ? (resolved.get(raw) ?? null) : null;
	}
	writeFileSync(jsonPath, JSON.stringify({ ...payload, events }, null, 2));

	const named = events.filter((e) => e.venue_name).length;
	console.log(
		`→ venues: ${stats.raw} raw → ${stats.venues} venues ` +
			`(${stats.alias} alias, ${stats.cached} cached, ${stats.rule} rule, ` +
			`${stats.model} model, ${stats.notVenue} not a venue, ${stats.unresolved} unresolved); ` +
			`${named}/${events.length} events named`,
	);
	for (const [raw, canonical] of merges) {
		console.log(`    "${raw}" ⇒ "${canonical}"`);
	}
}

if (process.argv[1]?.endsWith("venues.ts")) await main();
