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
		first(la) === first(lb)
	);
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

/** More complete = more fields a reader actually benefits from. */
export function completeness(event: Record<string, unknown>): number {
	const str = (k: string): string =>
		typeof event[k] === "string" ? (event[k] as string) : "";
	let score = 0;
	if (str("image")) score += 2;
	if (str("location")) score += 2;
	if (str("link")) score += 2;
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
						if (venuesAgree(events[i], events[j])) {
							settled.push(i < j ? [i, j] : [j, i]);
						} else {
							candidates.push(i < j ? [i, j] : [j, i]);
						}
					} else if (sim >= MAYBE_MIN && sim < AUTO_MATCH) {
						candidates.push(i < j ? [i, j] : [j, i]);
					}
					continue;
				}
				// Adjacent days are never auto-merged: a genuinely recurring event
				// runs on consecutive nights with the identical title, and
				// collapsing those would lose a real event. But a strong title
				// match across midnight is exactly the all-day/late-night drift
				// case, so it goes to the model rather than being dropped
				// silently by the same-day similarity band.
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

export async function dedupeEventsSmart(
	events: Record<string, unknown>[],
	opts: { classify?: PairClassifyFn } = {},
): Promise<{ events: Record<string, unknown>[]; stats: DedupeStats }> {
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
	return {
		events: output,
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
