// What the city page's filter bar does to the event list: the predicate, the
// Saved / Picks / All split, the facets the chips are built from, and the
// date-picker and header bounds. Pure, so web and native filter identically;
// the web's React context only holds the state and calls these.
//
// Identity is a parameter (`keyOf`), not eventId: the web's saved and hidden
// sets are keyed by eventId, native's by eventHash (PLAN D6).

import { endOfMonth, startOfWeek } from "./dates.ts";
import type {
	CityData,
	DateRange,
	EventData,
	PastFilter,
	VibeKey,
} from "./schema.ts";
import { matchesQuery, queryTokens } from "./search.ts";
import {
	eventOverlapsRange,
	isTopPick,
	LOW_SCORE_THRESHOLD,
} from "./shared.ts";
import type { TagPrefs } from "./tagPrefs.ts";
import { rankByTaste, type TasteProfile } from "./taste.ts";
import { matchesTimeBands, type TimeBand } from "./timeOfDay.ts";
import { VIBE_KEYS, VIBE_LABEL_SET } from "./vibes.ts";

export interface FilterState {
	/** "All" = any category. */
	category: string;
	/** Canonical venue_name. Null = any venue. */
	venue: string | null;
	/** Overlap test: a multi-day event matches any day it runs on. */
	range: DateRange | null;
	/** ANDed. */
	tags: string[];
	/** ANDed. */
	vibes: VibeKey[];
	/** ORed. Empty = any time; any selection drops untimed events. */
	timeBands: TimeBand[];
	query: string;
	/** Lowest score still shown. Unscored events are never hidden by it. */
	minScore: number;
	past: PastFilter;
}

/** The view a first-time visitor gets, and what "Clear all" returns to. The
 * score floor is LOW_SCORE_THRESHOLD, not 0: clearing filters still hides
 * venue promotion. */
export const DEFAULT_FILTERS: FilterState = {
	category: "All",
	venue: null,
	range: null,
	tags: [],
	vibes: [],
	timeBands: [],
	query: "",
	minScore: LOW_SCORE_THRESHOLD,
	past: "no-past",
};

/** The key an event's saved/hidden state is stored under. Web: eventId; native: eventHash. */
export type KeyOf = (e: EventData) => string;

export interface FilterContext {
	/** The viewer's YYYY-MM-DD, or "" before it is known (nothing counts as
	 * past then, which keeps the server render and first client render equal). */
	today: string;
	hidden: ReadonlySet<string>;
	keyOf: KeyOf;
}

/** One definition of "something is filtering", for the active-filter strip,
 * the empty state and Clear all alike. */
export function hasActiveFilters(f: FilterState): boolean {
	return (
		f.category !== "All" ||
		f.venue !== null ||
		f.range !== null ||
		f.tags.length > 0 ||
		f.vibes.length > 0 ||
		f.timeBands.length > 0 ||
		f.query.trim().length > 0 ||
		f.minScore !== LOW_SCORE_THRESHOLD ||
		f.past !== "no-past"
	);
}

/** Ended before `today`. An event with no date at all is never past. */
export function isPast(event: EventData, today: string): boolean {
	const end = (event.datetime_end_iso || event.datetime_iso || "").slice(0, 10);
	return end ? end < today : false;
}

/**
 * The events that pass every filter, plus the ones only the score floor removed.
 *
 * The floor is applied last so `lowScored` counts exactly what it alone hid:
 * "N low-scoring events hidden" must not include events the reader's other
 * filters would have dropped anyway.
 */
export function applyFilters(
	events: readonly EventData[],
	f: FilterState,
	ctx: FilterContext,
): { filtered: EventData[]; lowScored: EventData[] } {
	// Tokenised once per call, not once per event.
	const tokens = queryTokens(f.query);
	const lowScored: EventData[] = [];
	const filtered = events.filter((event) => {
		if (!passesOtherFilters(event)) return false;
		// A missing score is not a low one: ranking can be absent (a fresh
		// scrape, a failed rank pass). Same rule meetsScoreFloor applies for the feeds.
		if (typeof event.score === "number" && event.score < f.minScore) {
			lowScored.push(event);
			return false;
		}
		return true;
	});
	return { filtered, lowScored };

	function passesOtherFilters(event: EventData): boolean {
		if (ctx.hidden.has(ctx.keyOf(event))) return false;
		if (!matchesQuery(event, tokens)) return false;
		if (f.category !== "All" && event.category !== f.category) return false;
		if (f.venue !== null && event.venue_name !== f.venue) return false;
		if (f.range && !eventOverlapsRange(event, f.range.start, f.range.end)) {
			return false;
		}
		if (
			f.tags.length > 0 &&
			!f.tags.every((tag) => (event.tags || []).includes(tag))
		) {
			return false;
		}
		if (!matchesTimeBands(event, f.timeBands)) return false;
		const past = isPast(event, ctx.today);
		if (f.past === "no-past" && past) return false;
		if (f.past === "only-past" && !past) return false;
		return f.vibes.every((key) => event[key] === true);
	}
}

/** Most picks the row shows. */
export const MAX_PICKS = 9;

/**
 * Splits the filtered list into Saved, Picks and the rest ("all events").
 *
 * A saved event lives only in Saved, so a card never renders twice. A pick
 * must score TOP_PICK_THRESHOLD or more and START inside the window: the date
 * filter is an overlap test, which would otherwise let an exhibition that
 * opened months ago sit in Picks for "Today". The window is the selected
 * range, else the published week (never "no window", which is when a
 * months-long run could sit in Picks every week).
 *
 * rankByTaste orders both Picks and the rest; an empty profile keeps the
 * incoming (pipeline) order.
 */
export function splitSections(
	filtered: readonly EventData[],
	opts: {
		starred: ReadonlySet<string>;
		keyOf: KeyOf;
		taste: TasteProfile;
		tagPrefs: TagPrefs;
		range: DateRange | null;
		weekStart: string;
		weekEnd: string;
	},
): { saved: EventData[]; picks: EventData[]; rest: EventData[] } {
	const { starred, keyOf, taste, tagPrefs } = opts;
	const start = opts.range?.start ?? opts.weekStart;
	const end = opts.range?.end ?? opts.weekEnd;
	const saved: EventData[] = [];
	const unstarred: EventData[] = [];
	const eligible: EventData[] = [];
	for (const e of filtered) {
		if (starred.has(keyOf(e))) {
			saved.push(e);
			continue;
		}
		unstarred.push(e);
		if (isTopPick(e, start, end)) eligible.push(e);
	}
	const picks = rankByTaste(eligible, taste, tagPrefs).slice(0, MAX_PICKS);
	const pickKeys = new Set(picks.map(keyOf));
	// Everything the row did not take, including eligible events beyond the nine.
	const rest = rankByTaste(
		unstarred.filter((e) => !pickKeys.has(keyOf(e))),
		taste,
		tagPrefs,
	);
	return { saved, picks, rest };
}

/** How many of the city's events are hidden. Counted over every event, not the
 * filtered list: hidden events are never in that, and this count is the only
 * sign a reader has hidden anything. */
export function hiddenCount(
	events: readonly EventData[],
	hidden: ReadonlySet<string>,
	keyOf: KeyOf,
): number {
	return events.filter((e) => hidden.has(keyOf(e))).length;
}

/**
 * The chip and picker options, from every event rather than the filtered list,
 * so a chip doesn't vanish (or the category row shrink to one pill) once it is
 * selected. On a per-category page the events are already one category, so
 * `categories` is one entry there.
 *
 * `tags` is the tag chip pool, most common first (ties alphabetical). A tag
 * spelled like a vibe is left out: the vibe chip already owns that word.
 */
export function facetCounts(events: readonly EventData[]): {
	categories: string[];
	venues: { name: string; count: number }[];
	tags: string[];
} {
	const venueCounts = new Map<string, number>();
	const tagCounts = new Map<string, number>();
	for (const e of events) {
		if (e.venue_name)
			venueCounts.set(e.venue_name, (venueCounts.get(e.venue_name) ?? 0) + 1);
		for (const tag of e.tags ?? []) {
			if (VIBE_LABEL_SET.has(tag.toLowerCase())) continue;
			tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
		}
	}
	return {
		categories: [...new Set(events.map((e) => e.category).filter(Boolean))],
		venues: [...venueCounts]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		tags: [...tagCounts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([tag]) => tag),
	};
}

/** The counts shown on the vibe and tag chips: over what is on screen now, never
 * the corpus, because a count on a chip that currently matches nothing
 * advertises results that don't exist. */
export function liveCounts(filtered: readonly EventData[]): {
	tags: Map<string, number>;
	vibes: Record<VibeKey, number>;
} {
	const tags = new Map<string, number>();
	const vibes = { intellectual: 0, creative: 0, hands_on: 0, social: 0 };
	for (const event of filtered) {
		for (const tag of event.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
		for (const key of VIBE_KEYS) if (event[key] === true) vibes[key] += 1;
	}
	return { tags, vibes };
}

/** Tag chips shown before the typeahead narrows them. Brisbane's week carries
 * ~520 distinct tags, half of them used once; the useful ones are a short head. */
export const VISIBLE_TAGS = 18;
/** Ceiling while typing: a two-letter query still matches a lot. */
export const SEARCH_TAGS = 60;

/** The tag chips to render for a typeahead query. A selected tag always stays,
 * or selecting one could push it out of view with no way to unpress it. */
export function visibleTags(
	pool: readonly string[],
	typed: string,
	active: readonly string[],
): string[] {
	const q = typed.trim().toLowerCase();
	const head = q
		? pool.filter((t) => t.includes(q)).slice(0, SEARCH_TAGS)
		: pool.slice(0, VISIBLE_TAGS);
	for (const tag of active) if (!head.includes(tag)) head.push(tag);
	return head;
}

type WeekData = Pick<
	CityData,
	"events" | "week_start" | "week_end" | "generated_at"
>;

/**
 * Bounds for the date-range picker (not the coverage the header shows).
 *
 * dateMin is the day the digest was generated, not the earliest date in the
 * data, which is a years-old exhibition opening; those still surface because
 * the date filter is an overlap test. dateMax is the latest date any event
 * runs to, capped at the end of the month coverage ends in, so one long run
 * can't stretch the picker across two years.
 */
export function dateBounds(data: WeekData): {
	dateMin: string;
	dateMax: string;
} {
	const dateMin = data.generated_at || data.week_start || "";
	const ends = data.events
		.map((e) => (e.datetime_end_iso || e.datetime_iso || "").slice(0, 10))
		.filter(Boolean)
		.sort();
	const latest = ends[ends.length - 1] ?? data.week_end ?? "";
	if (!latest) return { dateMin, dateMax: "" };
	const cap = endOfMonth(data.week_end || latest);
	return { dateMin, dateMax: latest > cap ? cap : latest };
}

/**
 * The range the header prints: from the events rather than week_start/week_end,
 * because the scrape keeps next week's events too. The start never precedes
 * the viewer's Monday (an exhibition that opened in February read as stale),
 * falling back to the digest's Monday while `today` is "" (pre-mount), so
 * server and first client render agree.
 */
export function coverage(
	data: WeekData,
	today: string,
): { weekStart: string; weekEnd: string } {
	const dates = data.events
		.map((e) => (e.datetime_iso ?? "").slice(0, 10))
		.filter(Boolean)
		.sort();
	let start = data.week_start ?? "";
	let end = data.week_end ?? "";
	if (dates.length > 0) {
		start = start && start < dates[0] ? start : dates[0];
		end = end && end > dates[dates.length - 1] ? end : dates[dates.length - 1];
	}
	const floor = today ? startOfWeek(today) : (data.week_start ?? "");
	const clamped = start < floor ? floor : start;
	return { weekStart: end && clamped > end ? end : clamped, weekEnd: end };
}
