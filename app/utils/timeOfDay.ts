// Time-of-day bands, so "what can I do this evening" is one press.
//
// Boundaries are the ones the events themselves cluster around rather than
// even thirds of the clock: venue listings put daytime workshops and markets
// in the morning, matinees and afternoon markets from midday, and everything
// gig-shaped from 5pm. Splitting at 8/16 would have filed a 4pm matinee as
// evening and a 5pm gig as afternoon.

import type { Event } from "../types";

export const TIME_BANDS = ["morning", "afternoon", "evening"] as const;
export type TimeBand = (typeof TIME_BANDS)[number];

export const TIME_BAND_LABELS: Record<TimeBand, string> = {
	morning: "Morning",
	afternoon: "Afternoon",
	evening: "Evening",
};

/** Inclusive start hour, exclusive end hour. */
const BAND_HOURS: Record<TimeBand, [number, number]> = {
	morning: [5, 12],
	afternoon: [12, 17],
	evening: [17, 29], // wraps past midnight — a 1am set belongs to the evening
};

/**
 * Which band an event starts in, or null when it has no time at all.
 *
 * A date with no time is not midnight. Roughly a third of events carry a
 * date-only start (356 of 1031 in one Brisbane scrape), and treating those as
 * 00:00 would file every one of them as "evening" — so they match no band and
 * are kept by any filter rather than being silently binned into one.
 */
export function bandOf(event: Event): TimeBand | null {
	const iso = event.datetime_iso ?? "";
	// "2026-09-09T19:00:00" — a time is present only if the T-part is.
	const time = iso.length > 10 ? iso.slice(11, 13) : "";
	if (!/^\d{2}$/.test(time)) return null;
	const hour = Number(time);
	for (const band of TIME_BANDS) {
		const [from, to] = BAND_HOURS[band];
		if (hour >= from && hour < to) return band;
		// The evening band runs past midnight: 0-4 is the tail of 17-29.
		if (to > 24 && hour + 24 >= from && hour + 24 < to) return band;
	}
	return null;
}

/**
 * Whether an event passes the selected bands.
 *
 * No selection means no filtering. An event with no start time always passes:
 * excluding it would hide a third of the listings behind a filter that cannot
 * actually judge them, and a filter that silently drops what it cannot read is
 * worse than one that admits it.
 */
export function matchesTimeBands(event: Event, bands: TimeBand[]): boolean {
	if (bands.length === 0) return true;
	const band = bandOf(event);
	if (band === null) return true;
	return bands.includes(band);
}
