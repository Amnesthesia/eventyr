// Cross-source deduplication for the merged week (curate.ts calls this).
//
// STRATEGY — three stages, cheapest first, so the LLM only ever sees the
// genuinely ambiguous minority:
//
//   Stage 0 (blocking, free). Events are bucketed by calendar date. Nothing
//   is ever compared across buckets, so the comparison count scales with
//   events-per-day, not with corpus size — this is what keeps the whole thing
//   affordable now that scraped venue listings make the merged set several
//   times bigger. A ±1-day neighbour window is included when pairing, because
//   a late-night event can land either side of midnight depending on whether
//   a source published a start time at all.
//
//   Stage 1 (deterministic, free). Within a bucket, the existing
//   title-matching rules from common.ts (exact / prefix / Dice > 0.85) settle
//   the obvious duplicates — the same show found by two providers, or by a
//   scrape and a search. This is the pre-existing behaviour and catches the
//   large majority.
//
//   Stage 2 (LLM, bounded). Pairs that stage 1 left unmerged but that still
//   look related — Dice similarity inside [MAYBE_MIN, AUTO_MATCH] — are the
//   grey zone: "Jazz Night" vs "Jazz Night ft. The Quartet", or the same
//   gig titled differently by venue and ticketer. Only these are batched to
//   the model, ~30 pairs per call, with a tiny JSON in/out. Unrelated events
//   on the same day score near zero and never reach it.
//
//   Survivor choice. Confirmed duplicates are grouped (union-find) and one
//   event is kept per group: the most complete record (image, location,
//   description, tags, price), tie-broken by original order so the result is
//   deterministic. Completeness rather than provenance — a scraped listing
//   usually wins on facts anyway, and completeness generalises to
//   provider-vs-provider duplicates too.

import {
	diceSimilarity,
	fingerprintEvent,
	isDuplicateEvent,
} from "./common.ts";

/** Above this, common.ts already treats the titles as the same event. */
const AUTO_MATCH = 0.85;
/** Below this, same-day titles are unrelated often enough that asking is waste. */
const MAYBE_MIN = 0.45;
/** Pairs per LLM call. */
export const PAIR_BATCH_SIZE = 30;
/**
 * Guard against a pathological single-day bucket (a festival dumping hundreds
 * of same-day sessions) turning stage 2 into an O(n²) token bill.
 *
 * Sized from a real run: one city-week of 400 events produced 449 ambiguous
 * pairs, so the original 400 was already truncating live data. At ~30 pairs
 * per call this ceiling is ~66 small calls — still bounded, and the cap now
 * warns when it bites rather than silently dropping comparisons.
 */
const MAX_PAIRS = 2000;

export interface CandidatePair {
	a: Record<string, unknown>;
	b: Record<string, unknown>;
}

/** Decides, for each pair, whether the two records are the same real event.
 * Injectable so tests never touch the network — same pattern as PageExtractFn
 * and Fetcher in src/adapters/types.ts. */
export type PairClassifyFn = (pairs: CandidatePair[]) => Promise<boolean[]>;

/**
 * Whether two records plausibly name the same place. Unknown on either side
 * counts as agreement — the AI-search path often has only a suburb, and
 * refusing to merge on a missing field would leave obvious duplicates.
 */
function venuesAgree(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	const norm = (e: Record<string, unknown>): string =>
		typeof e.location === "string"
			? e.location
					.toLowerCase()
					.replace(/[^a-z0-9 ]/g, " ")
					.replace(/\s+/g, " ")
					.trim()
			: "";
	const la = norm(a);
	const lb = norm(b);
	if (!la || !lb) return true;
	if (la === lb) return true;
	// One is usually a longer form of the other ("The Triffid" vs "The
	// Triffid, Newstead").
	const first = (v: string): string => v.split(" ").slice(0, 2).join(" ");
	return (
		la.includes(lb) ||
		lb.includes(la) ||
		diceSimilarity(la, lb) > 0.6 ||
		first(la) === first(lb) ||
		acronymMatch(la, lb)
	);
}

/**
 * Whether one venue string is the other's acronym.
 *
 * Venues are named in full by one source and by initials by another, and no
 * amount of string similarity connects them: "Queensland Performing Arts
 * Centre, South Brisbane" against "Playhouse, QPAC" scores 0.10. Measured on a
 * real duplicate — "Strong is the new pretty" appeared three times on the same
 * date because every pair of its venue spellings looked unrelated, so all
 * three went to the classifier, which is told to answer false when venues
 * differ.
 *
 * Three letters minimum: two-letter initialisms collide constantly.
 */
export function acronymMatch(la: string, lb: string): boolean {
	const tokens = (v: string): string[] =>
		v.split(" ").filter((w) => w.length >= 3);
	for (const [long, short] of [
		[la, lb],
		[lb, la],
	]) {
		const words = tokens(long);
		const candidates = new Set(tokens(short));
		if (candidates.size === 0) continue;
		// Prefixes, not the whole string: the acronym covers the venue's name
		// and the source usually appends a suburb after it. "queensland
		// performing arts centre south brisbane" initialises to "qpacsb", which
		// matches nothing — the answer is in its first four words.
		let acronym = "";
		for (const word of words) {
			acronym += word[0];
			if (acronym.length >= 3 && candidates.has(acronym)) return true;
		}
	}
	return false;
}

/**
 * Whether a title is specific enough that two same-date events sharing it are
 * one event, whatever their venue strings say.
 *
 * The venue check exists for generic names — "Trivia Night" at Netherworld and
 * at the Junk Bar really are two events. But it also blocked genuine
 * duplicates whose sources spell the venue differently: "Strong is the new
 * pretty" was published three times on one date as South Bank Parklands, as
 * Queensland Performing Arts Centre and as Playhouse/QPAC, and no pair of
 * those looked alike.
 *
 * Four words is the line because that is what separates a programme title from
 * a category label. Every generic collision in the data so far is one or two
 * words ("trivia night", "life drawing", "open mic", "live music").
 */
export function isDistinctiveTitle(normalisedTitle: string): boolean {
	const words = normalisedTitle.split(/\s+/).filter(Boolean);
	return words.length >= 4;
}

function dateKey(event: Record<string, unknown>): string {
	return fingerprintEvent(event).date;
}

function shiftDate(key: string, days: number): string {
	if (!key) return "";
	const d = new Date(`${key}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return "";
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

class DisjointSet {
	private parent: number[];
	constructor(size: number) {
		this.parent = Array.from({ length: size }, (_, i) => i);
	}
	find(i: number): number {
		while (this.parent[i] !== i) {
			this.parent[i] = this.parent[this.parent[i]];
			i = this.parent[i];
		}
		return i;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
	}
}

/**
 * Whether an event's link points at the event rather than at a site root.
 *
 * A bare domain is the shape a search summary produces when it knows the
 * venue but not the listing. Note it does NOT mean "low quality" on its own —
 * 117 of 1588 events legitimately carry a venue homepage because that is all
 * their listing offered — so this only ever breaks a tie between two records
 * of the same event.
 */
export function hasSpecificLink(event: Record<string, unknown>): boolean {
	const link = typeof event.link === "string" ? event.link.trim() : "";
	if (!link) return false;
	try {
		const { pathname, search } = new URL(link);
		return pathname.replace(/\/+$/, "") !== "" || search !== "";
	} catch {
		return false;
	}
}

/** More complete = more fields a reader actually benefits from. */
export function completeness(event: Record<string, unknown>): number {
	const str = (k: string): string =>
		typeof event[k] === "string" ? (event[k] as string) : "";
	let score = 0;
	if (str("image")) score += 2;
	if (str("location")) score += 2;
	// A link to the event itself beats a link to the venue's front door: a
	// search summary that only knows "it's on at eventbrite.com.au" is a
	// weaker record than a scrape carrying /e/the-silence-paradox-...
	if (str("link")) score += hasSpecificLink(event) ? 2 : 1;
	const description = str("description");
	if (description) score += 1;
	if (description.length > 120) score += 1;
	if (Array.isArray(event.tags) && event.tags.length > 0) score += 1;
	const cost = str("cost");
	if (cost && cost !== "See link") score += 1;
	if (str("datetime_iso").length > 10) score += 1; // has a time, not just a date
	return score;
}

/**
 * Builds the grey-zone pairs stage 2 has to adjudicate, and the groups
 * stage 1 already settled. Pure — no LLM, no IO — so it can be tested and so
 * the caller can see the pair count before paying for anything.
 */
export function planDedupe(events: Record<string, unknown>[]): {
	settled: [number, number][];
	candidates: [number, number][];
} {
	const buckets = new Map<string, number[]>();
	events.forEach((event, i) => {
		const key = dateKey(event);
		const list = buckets.get(key);
		if (list) list.push(i);
		else buckets.set(key, [i]);
	});

	const settled: [number, number][] = [];
	const candidates: [number, number][] = [];
	const seen = new Set<string>();

	for (const [key, indices] of buckets) {
		// Compare a bucket against itself and its next-day neighbour only.
		const neighbours = [...indices, ...(buckets.get(shiftDate(key, 1)) ?? [])];
		for (let x = 0; x < indices.length; x++) {
			for (const j of neighbours) {
				const i = indices[x];
				if (i === j) continue;
				// Order the key rather than skipping i > j. Array position
				// carries no date ordering (events are concatenated per file),
				// so skipping on index dropped every cross-day pair whose
				// earlier-day event happened to sit later in the array — about
				// a third of them, silently.
				const pairKey = i < j ? `${i}:${j}` : `${j}:${i}`;
				if (seen.has(pairKey)) continue;
				seen.add(pairKey);

				const fpA = fingerprintEvent(events[i]);
				const fpB = fingerprintEvent(events[j]);
				const sameDay = fpA.date === fpB.date;
				const sim = diceSimilarity(fpA.title, fpB.title);

				if (sameDay) {
					if (isDuplicateEvent(fpA, fpB)) {
						// Titles match, but a matching title at two different
						// venues is two different events ("Trivia Night" at
						// Netherworld and at the Junk Bar). isDuplicateEvent
						// never sees the venue, so ask rather than assume.
						if (
							venuesAgree(events[i], events[j]) ||
							isDistinctiveTitle(fpA.title)
						) {
							settled.push(i < j ? [i, j] : [j, i]);
						} else {
							candidates.push(i < j ? [i, j] : [j, i]);
						}
					} else if (sim >= MAYBE_MIN && sim < AUTO_MATCH) {
						candidates.push(i < j ? [i, j] : [j, i]);
					}
					continue;
				}
				// Adjacent days are never auto-merged on title alone: a genuinely
				// recurring event runs on consecutive nights with the identical
				// title, and collapsing those would lose a real event.
				//
				// One exception, and it cannot lose a real event. When the title
				// and venue agree and exactly one of the pair has no
				// event-specific link, that record is a search summary that
				// guessed the date — not a second night. Merging keeps the record
				// that has a real listing URL and drops the guess.
				//
				// This closes a hole between the two stages. The ±1-day window
				// exists for midnight drift, but stage 1 requires equal dates and
				// the classifier prompt is told "different dates ⇒ different
				// events", so before this a cross-midnight pair could never merge
				// however identical it was — measured on "The Silence Paradox",
				// listed twice at the same venue on consecutive days, one record
				// linking only to eventbrite.com.au.
				if (
					sim >= AUTO_MATCH &&
					venuesAgree(events[i], events[j]) &&
					hasSpecificLink(events[i]) !== hasSpecificLink(events[j])
				) {
					settled.push(i < j ? [i, j] : [j, i]);
					continue;
				}
				if (sim >= MAYBE_MIN) candidates.push(i < j ? [i, j] : [j, i]);
			}
		}
	}
	if (candidates.length > MAX_PAIRS) {
		console.warn(
			`  ⚠ [dedupe] ${candidates.length} ambiguous pairs exceeds the ${MAX_PAIRS} cap — ${candidates.length - MAX_PAIRS} will not be checked`,
		);
	}
	return { settled, candidates: candidates.slice(0, MAX_PAIRS) };
}

export interface DedupeStats {
	input: number;
	settledPairs: number;
	askedPairs: number;
	confirmedByLlm: number;
	removed: number;
	output: number;
}

/** One duplicate group: which input indices were merged, and which survived. */
export interface DedupeGroup {
	members: number[];
	survivor: number;
}

export async function dedupeEventsSmart(
	events: Record<string, unknown>[],
	opts: { classify?: PairClassifyFn } = {},
): Promise<{
	events: Record<string, unknown>[];
	stats: DedupeStats;
	groups: DedupeGroup[];
}> {
	const { settled, candidates } = planDedupe(events);
	const ds = new DisjointSet(events.length);
	for (const [i, j] of settled) ds.union(i, j);

	let confirmedByLlm = 0;
	if (candidates.length > 0 && opts.classify) {
		const verdicts = await opts.classify(
			candidates.map(([i, j]) => ({ a: events[i], b: events[j] })),
		);
		candidates.forEach(([i, j], k) => {
			if (verdicts[k]) {
				ds.union(i, j);
				confirmedByLlm++;
			}
		});
	}

	// Keep the most complete record per group; ties break on original order,
	// so the output is stable across runs.
	const best = new Map<number, number>();
	events.forEach((_, i) => {
		const root = ds.find(i);
		const current = best.get(root);
		if (current === undefined) {
			best.set(root, i);
			return;
		}
		if (completeness(events[i]) > completeness(events[current])) {
			best.set(root, i);
		}
	});

	const keep = new Set(best.values());
	const output = events.filter((_, i) => keep.has(i));
	// Groups are exposed so the caller can see what was merged with what — which
	// provider's find survived, and which judgement fields the survivor should
	// inherit — without re-deriving the union-find.
	const members = new Map<number, number[]>();
	events.forEach((_, i) => {
		const root = ds.find(i);
		const list = members.get(root);
		if (list) list.push(i);
		else members.set(root, [i]);
	});
	const groups: DedupeGroup[] = [...members.entries()].map(([root, list]) => ({
		members: list,
		survivor: best.get(root) as number,
	}));
	return {
		events: output,
		groups,
		stats: {
			input: events.length,
			settledPairs: settled.length,
			askedPairs: candidates.length,
			confirmedByLlm,
			removed: events.length - output.length,
			output: output.length,
		},
	};
}
