// A taste profile built from what this browser singles out — bookmarking,
// sharing or calendaring an event — used to order Top Picks and the swipe deck
// personally instead of identically for everyone.
//
// Counts are written when the event is acted on rather than derived from the
// starred set on read, because data/{city}.json is rewritten weekly: an event
// starred three weeks ago is gone from cityData.events, so its tags, vibes and
// category are unrecoverable later. Counting up front keeps the taste after the
// event ages out.

import type { EventData } from "./schema.ts";
import { hasTagPrefs, prefTier, type TagPrefs } from "./tagPrefs.ts";
import { tagWeight } from "./tagSpecificity.ts";
import { vibesOf } from "./vibes.ts";

/** tag/vibe/category key -> how many bookmarked events carried it. */
export type TasteProfile = Record<string, number>;

/** Score points a perfect taste match is worth.
 *
 * With TOP_PICK_THRESHOLD at 7, a 7 that matches on all three fronts reaches 11
 * and so outranks an unmatched 10 — that is the whole point of this file. A
 * single shared tag is worth about half a point and changes nothing. The
 * threshold gate still keeps anything mediocre out of the running. */
const MAX_BOOST = 4;

/** Counted interactions before any personalisation happens. After one, every
 * group max is 1, so any shared tag scores full weight — a single save must not
 * rewrite the whole picks row. */
const MIN_SIGNAL = 3;

/** Above 1, so each extra match is worth more than the last. Every event in the
 * data carries 3 or 4 tags, so a tag target of 3 is the most reliably reachable
 * and the curve makes breadth pay:
 *
 *   tags matched at full weight   1      2      3
 *   tag group weight              0.19   0.54   1.00
 *
 * Linear weighting made one match worth a third of a perfect one, which is how
 * a merely adjacent event displaces a genuinely on-taste one. */
const CURVE = 1.5;

/** Each signal's share of the boost, and how many matches count as perfect for
 * it. Shares track resolution: tags are sharpest (316 distinct values in
 * Brisbane), the four vibes are coarser but not redundant (449 of 453 events
 * set at least one, most set one or two), and category is bluntest at six
 * values — once you have saved anything, a category match is nearly free. */
const GROUPS = [
	{ prefix: "tag:", share: 0.55, target: 3 },
	{ prefix: "vibe:", share: 0.25, target: 2 },
	{ prefix: "cat:", share: 0.2, target: 1 },
] as const;

/** The profile keys an event contributes to. The one place that knows the
 * prefixes, so bumpTaste and tasteBoost cannot disagree about them. Prefixed
 * because a tag would otherwise be able to collide with a category or a vibe. */
export function eventKeys(event: EventData): string[] {
	const keys = (event.tags ?? []).map((tag) => `tag:${tag}`);
	for (const vibe of vibesOf(event)) keys.push(`vibe:${vibe}`);
	if (event.category) keys.push(`cat:${event.category}`);
	return keys;
}

/** Add `delta` to every key this event carries. Unbookmarking passes -1, so the
 * profile can shrink as well as grow. Keys that reach 0 are removed rather than
 * kept at zero, which keeps the record from growing without bound. */
export function bumpTaste(
	prev: TasteProfile,
	event: EventData,
	delta: number,
): TasteProfile {
	const next = { ...prev };
	for (const key of eventKeys(event)) {
		const count = (next[key] ?? 0) + delta;
		if (count > 0) {
			next[key] = count;
		} else {
			delete next[key];
		}
	}
	return next;
}

/** Marks a "not interested" as a counted interaction without pretending a
 * category was disliked — mirrors STATED_SIGNAL_KEY below. Incremented by 1
 * per dislike, decremented by 1 on undo, regardless of tag weights, so
 * disliking three generic-tagged events still reaches MIN_SIGNAL. */
const DISLIKE_SIGNAL_KEY = "cat:__disliked__";

/**
 * Weight `delta` (default -1, a dislike; +1 undoes one) into every tag this
 * event carries, scaled by how specific that tag is.
 *
 * Only `tag:` keys move — not vibes or category. A like says "more like this
 * in every dimension"; a dislike says "not this specific thing", and a vibe
 * or category is too coarse to say that safely (disliking one loud gig must
 * not read as "less Concert / Music" outright). A tag on nearly every event
 * (low weight) still erodes its group over many dislikes; a tag unique to
 * this event (weight 1) takes the full hit on its own.
 */
export function bumpDislike(
	prev: TasteProfile,
	event: EventData,
	weights: Record<string, number>,
	delta: -1 | 1 = -1,
): TasteProfile {
	const next = { ...prev };
	for (const tag of event.tags ?? []) {
		const key = `tag:${tag}`;
		const count = (next[key] ?? 0) + delta * tagWeight(tag, weights);
		// Weighted deltas rarely land exactly on zero; a small epsilon keeps a
		// fully-undone dislike from leaving a dead 1e-16 entry behind.
		if (Math.abs(count) > 1e-9) {
			next[key] = count;
		} else {
			delete next[key];
		}
	}
	const signal = (next[DISLIKE_SIGNAL_KEY] ?? 0) - delta;
	if (signal > 0) {
		next[DISLIKE_SIGNAL_KEY] = signal;
	} else {
		delete next[DISLIKE_SIGNAL_KEY];
	}
	return next;
}

/** Highest count per group, plus the number of counted interactions.
 *
 * Each group is normalised against its own maximum: a category is counted on
 * every single bookmark while any one tag is not, so a shared maximum would let
 * category counts dominate and flatten every tag weight to near zero. */
function groupStats(taste: TasteProfile): { maxes: number[]; saves: number } {
	const maxes = GROUPS.map(() => 0);
	let saves = 0;
	for (const [key, count] of Object.entries(taste)) {
		for (let i = 0; i < GROUPS.length; i++) {
			if (!key.startsWith(GROUPS[i].prefix)) continue;
			// Synthetic markers (cat:__stated__, cat:__disliked__) carry no real
			// category identity — letting one stand in as "the" category
			// maximum flattened every genuine category match toward zero. abs()
			// because a tag: count can now be negative (a dislike).
			if (!key.includes("__") && Math.abs(count) > maxes[i]) {
				maxes[i] = Math.abs(count);
			}
			// cat: is written exactly once per bookmark or dislike, so its total
			// is the honest number of counted interactions — the only group of
			// which that is true.
			if (GROUPS[i].prefix === "cat:") saves += Math.abs(count);
		}
	}
	return { maxes, saves };
}

/**
 * The profile actually used for scoring: what behaviour inferred, plus what the
 * reader stated outright.
 *
 * Stated preferences were previously only a sort tier, so the profile itself
 * never learned from them — the taste readout kept saying "not personalised"
 * however many tags you had rated. A rating is a deliberate signal and the
 * strongest one available, so it enters at the group's full weight rather than
 * as one more bookmark, and an unwanted tag is removed outright rather than
 * merely outweighed.
 *
 * MIN_SIGNAL is satisfied by ratings too: it exists so a single accidental
 * bookmark cannot rewrite the picks row, and deliberately rating tags in a
 * preferences pane is not an accident.
 */
export function effectiveTaste(
	taste: TasteProfile,
	prefs: TagPrefs,
): TasteProfile {
	if (!hasTagPrefs(prefs)) return taste;
	const next = { ...taste };
	// At least 1, so ratings work from a standing start with no bookmarks.
	const { maxes } = groupStats(taste);
	const tagMax = Math.max(1, maxes[0] ?? 0);
	for (const [tag, pref] of Object.entries(prefs)) {
		const key = `tag:${tag}`;
		if (pref === 1) next[key] = tagMax;
		else delete next[key];
	}
	// cat: is what groupStats counts as an interaction, so a reader who has
	// only ever rated tags still clears MIN_SIGNAL and gets personalised order.
	const rated = Object.values(prefs).filter((v) => v === 1).length;
	if (rated > 0) {
		next[STATED_SIGNAL_KEY] = Math.max(
			next[STATED_SIGNAL_KEY] ?? 0,
			MIN_SIGNAL,
		);
	}
	return next;
}

/** Carries the "this reader has expressed intent" signal into groupStats
 * without pretending a category was bookmarked. Prefixed as a category
 * because that is the group groupStats counts interactions from, and named so
 * it cannot collide with a real one. */
const STATED_SIGNAL_KEY = "cat:__stated__";

/** How well an event matches the profile, in score points (-MAX_BOOST..MAX_BOOST).
 * Negative when the event leans toward disliked tags. */
export function tasteBoost(event: EventData, taste: TasteProfile): number {
	const { maxes, saves } = groupStats(taste);
	if (saves < MIN_SIGNAL) return 0;
	const keys = eventKeys(event);
	let weight = 0;
	for (let i = 0; i < GROUPS.length; i++) {
		const { prefix, share, target } = GROUPS[i];
		const max = maxes[i];
		if (!max) continue;
		let matched = 0;
		for (const key of keys) {
			if (key.startsWith(prefix)) matched += (taste[key] ?? 0) / max;
		}
		// Only the tag: group can go negative (a dislike); clamp to [-1, 1]
		// before curving so several stacked dislikes can't overshoot it, and
		// apply CURVE with the sign preserved — a bare negative base raised to
		// a fractional power (CURVE = 1.5) is NaN.
		const ratio = Math.max(-1, Math.min(1, matched / target));
		weight += share * Math.sign(ratio) * Math.abs(ratio) ** CURVE;
	}
	return Math.max(-MAX_BOOST, Math.min(MAX_BOOST, MAX_BOOST * weight));
}

/** Events ordered by score plus taste boost, highest first.
 *
 * Explicit tag preferences come first and are absolute: wanted tags sort ahead
 * of everything, unwanted behind everything, and only within a band does the
 * score-plus-boost ordering apply. A stated preference has to beat an inferred
 * one — an additive bonus would let a high enough score float an event the
 * reader has explicitly asked to see less of back to the top, which reads as
 * the setting being ignored. See tagPrefs.ts.
 *
 * Stable: ties keep the incoming order, which is already score-desc then
 * soonest-first from the pipeline, so an empty profile is a no-op. */
export function rankByTaste(
	events: EventData[],
	taste: TasteProfile,
	prefs: TagPrefs = {},
): EventData[] {
	const usePrefs = hasTagPrefs(prefs);
	// Ratings feed the profile as well as the tier, so within a band an event
	// matching two wanted tags outranks one matching a single wanted tag.
	const profile = effectiveTaste(taste, prefs);
	return events
		.map((event, index) => ({
			event,
			index,
			tier: usePrefs ? prefTier(event, prefs) : 0,
			rank: (event.score || 0) + tasteBoost(event, profile),
		}))
		.sort((a, b) => b.tier - a.tier || b.rank - a.rank || a.index - b.index)
		.map((entry) => entry.event);
}

// ---------------------------------------------------------------------------
// Debugging
// ---------------------------------------------------------------------------

/** Print the profile and what it did to the picks row.
 *
 * Deliberately always on, not behind a flag: the whole feature is invisible by
 * design — a reordered row looks like no feature at all — so the only way to
 * tell a working profile from a broken one is to read it. */
export function logTasteProfile(taste: TasteProfile, picks: EventData[]): void {
	const { maxes, saves } = groupStats(taste);
	const entries = Object.entries(taste).sort((a, b) => b[1] - a[1]);
	const dislikes = Object.entries(taste).filter(
		([key, count]) => key.startsWith("tag:") && count < 0,
	).length;
	console.groupCollapsed(
		`%c[taste]%c ${saves} interaction${saves === 1 ? "" : "s"}, ${entries.length} signal${entries.length === 1 ? "" : "s"}${dislikes ? `, ${dislikes} disliked tag${dislikes === 1 ? "" : "s"}` : ""}${saves < MIN_SIGNAL ? ` — picks NOT personalised, needs ${MIN_SIGNAL}` : ""}`,
		"font-weight:bold",
		"font-weight:normal",
	);
	if (entries.length) {
		console.table(
			entries.map(([key, count]) => {
				const i = GROUPS.findIndex((g) => key.startsWith(g.prefix));
				const group = GROUPS[i];
				return {
					signal: key,
					count,
					// What this one key contributes on its own, before the
					// per-group target and the curve are applied.
					"weight in group": group
						? +(count / (maxes[i] || 1)).toFixed(2)
						: "?",
					"group share": group ? group.share : "?",
				};
			}),
		);
	} else {
		console.log("No profile yet. Bookmark, share or calendar an event.");
	}
	console.log(
		"Picks, in the order shown:",
		picks.map((e, i) => ({
			"#": i + 1,
			score: e.score,
			boost: +tasteBoost(e, taste).toFixed(2),
			ranked: +((e.score || 0) + tasteBoost(e, taste)).toFixed(2),
			category: e.category,
			tags: (e.tags ?? []).join(", "),
			title: e.title,
		})),
	);
	console.log("Raw profile (stored as 'eventyr:taste'):", taste);
	console.groupEnd();
}
