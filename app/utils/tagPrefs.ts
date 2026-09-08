// Explicit tag preferences: tags the reader has said they want more of, and
// tags they have said they do not want.
//
// Distinct from taste.ts, which *infers* preference from behaviour — what got
// bookmarked, shared or calendared. Both feed the same ordering, but they are
// different kinds of claim and must not be stored together:
//
//   - taste.ts holds counts. More bookmarks of a tag means a stronger signal,
//     and the profile is normalised against its own maxima.
//   - this holds intent, which has no magnitude. "Not interested in raffles"
//     is not a count of anything, and it should not be diluted by how many
//     raffle events happen to exist this week.
//
// Intent also has to beat inference. Someone who bookmarks a lot of live music
// but marks "karaoke" unwanted has said something the counts cannot express,
// and the counts must not out-vote it — hence the tier ordering below rather
// than a bigger number added to the same score.

import type { Event } from "../types";

/** 1 = more of this, -1 = less of this. Absent = no opinion. */
export type TagPrefs = Record<string, 1 | -1>;

const KEY = "eventyr:tag-prefs";

export function loadTagPrefs(): TagPrefs {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// Stored values are read back from a place the user can edit; keep only
		// the two the rest of this file knows how to mean.
		const out: TagPrefs = {};
		for (const [tag, value] of Object.entries(parsed)) {
			if (value === 1 || value === -1) out[tag] = value;
		}
		return out;
	} catch {
		return {};
	}
}

export function saveTagPrefs(prefs: TagPrefs): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(prefs));
	} catch {
		// Private mode or storage disabled: still works for this view.
	}
}

/** Cycles one tag: no opinion → wanted → unwanted → no opinion. Mirrors the
 * vibe filter's tri-state, which readers here already use. */
export function cycleTagPref(prefs: TagPrefs, tag: string): TagPrefs {
	const next = { ...prefs };
	if (next[tag] === 1) next[tag] = -1;
	else if (next[tag] === -1) delete next[tag];
	else next[tag] = 1;
	return next;
}

/**
 * Which band an event sorts into: 1 wanted, 0 no opinion, -1 unwanted.
 *
 * A tier rather than a score adjustment because the ask is absolute — wanted
 * tags sort FIRST and unwanted sort LAST — and any additive bonus can be
 * out-voted by a high enough score. An unwanted event scoring 9 would still
 * lead the list, which is exactly what marking it unwanted was meant to stop.
 *
 * Unwanted wins ties with wanted: if a reader has said no to "raffle", an
 * event that is both a raffle and live music is still a raffle. Suppressing
 * something they asked to see less of is the error they can correct; showing
 * it near the top is the one that reads as the setting being ignored.
 */
export function prefTier(event: Event, prefs: TagPrefs): -1 | 0 | 1 {
	let tier: -1 | 0 | 1 = 0;
	for (const tag of event.tags ?? []) {
		const pref = prefs[tag];
		if (pref === -1) return -1;
		if (pref === 1) tier = 1;
	}
	return tier;
}

/** Whether any opinion has been expressed at all — lets callers skip the work
 * and keep the pipeline's own ordering untouched for most readers. */
export function hasTagPrefs(prefs: TagPrefs): boolean {
	for (const _ in prefs) return true;
	return false;
}
