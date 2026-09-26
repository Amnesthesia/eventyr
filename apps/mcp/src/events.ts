// Orchestrates one get_events call: resolve the timeframe/date to a file
// plan, fetch just those files, merge, filter by category, sort, and cap.

import {
	availableDatesFor,
	type CityIndexEntry,
	type CompactEvent,
	type DayFile,
	dayFileUrl,
	fetchFile,
	type WeekFile,
	weekFileUrl,
} from "./dothingsClient.ts";
import {
	resolveExplicitDate,
	resolveTimeframe,
	type Timeframe,
} from "./resolveTimeframe.ts";

// Matches the zod schema's own max(100) in tools.ts — the default must never
// exceed what a caller is allowed to explicitly ask for, or omitting the
// param silently returns more than passing max_results=100 would.
const DEFAULT_MAX_RESULTS = 100;

/** Events that actually start inside the requested window rank above ones
 * merely overlapping it. A day file lists every event running that day, so a
 * multi-year exhibition sorts above everything that starts today on a plain
 * `start` sort and eats the whole max_results cap — measured on brisbane
 * 2026-09-17: 0 of the 30 returned events started that day, with 153 hidden.
 * Nothing is dropped here, the ongoing ones just sort after. */
export function sortForWindow<T extends { start: string }>(
	events: T[],
	windowStart: string,
	windowEnd: string,
): T[] {
	const startsInWindow = (e: T) => {
		const day = e.start.slice(0, 10);
		return day >= windowStart && day <= windowEnd;
	};
	return [...events].sort(
		(a, b) =>
			Number(startsInWindow(b)) - Number(startsInWindow(a)) ||
			a.start.localeCompare(b.start),
	);
}

export interface EventsResult {
	available: true;
	city: string;
	city_key: string;
	timezone: string;
	data_as_of: string;
	resolved: string;
	events: CompactEvent[];
	total_matched: number;
	more_available: number;
}

export interface UnavailableResult {
	available: false;
	city: string;
	city_key: string;
	reason: string;
}

export interface GetEventsOptions {
	timeframe?: Timeframe;
	date?: string;
	category?: string;
	maxResults?: number;
}

export async function gatherEvents(
	entry: CityIndexEntry,
	cityToday: string,
	opts: GetEventsOptions,
): Promise<EventsResult | UnavailableResult> {
	const availableDates = availableDatesFor(entry);
	const plan = opts.date
		? resolveExplicitDate(opts.date, cityToday, availableDates)
		: resolveTimeframe(
				// biome-ignore lint/style/noNonNullAssertion: tools.ts already enforced exactly one of timeframe/date
				opts.timeframe!,
				cityToday,
				availableDates,
				Boolean(entry.week),
			);

	if (plan.kind === "unavailable") {
		return {
			available: false,
			city: entry.city,
			city_key: entry.city_key,
			reason: plan.reason,
		};
	}

	let events: CompactEvent[];
	let resolved: string;
	let windowStart: string;
	let windowEnd: string;

	if (plan.kind === "day") {
		const file = await fetchFile<DayFile>(dayFileUrl(entry, plan.date));
		events = file.events;
		resolved = plan.date;
		windowStart = plan.date;
		windowEnd = plan.date;
	} else if (plan.kind === "days") {
		const files = await Promise.all(
			plan.dates.map((d) => fetchFile<DayFile>(dayFileUrl(entry, d))),
		);
		// A multi-day event (an exhibition spanning both weekend days) appears in
		// each day file it covers — dedupe by id so it doesn't double up here.
		events = [
			...new Map(files.flatMap((f) => f.events).map((e) => [e.id, e])).values(),
		];
		resolved = plan.dates.join(",");
		windowStart = plan.dates[0];
		windowEnd = plan.dates[plan.dates.length - 1];
	} else {
		const url = weekFileUrl(entry, opts.category);
		if (!url) {
			return {
				available: false,
				city: entry.city,
				city_key: entry.city_key,
				reason: "this week's file has not been published yet",
			};
		}
		const file = await fetchFile<WeekFile>(url);
		events = file.events;
		resolved = `week-${file.week_start}`;
		windowStart = file.week_start;
		windowEnd = file.week_end;
	}

	if (opts.category)
		events = events.filter((e) => e.category === opts.category);
	events = sortForWindow(events, windowStart, windowEnd);

	const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
	const capped = events.slice(0, maxResults);

	return {
		available: true,
		city: entry.city,
		city_key: entry.city_key,
		timezone: entry.timezone,
		data_as_of: entry.data_as_of,
		resolved,
		events: capped,
		total_matched: events.length,
		more_available: Math.max(0, events.length - capped.length),
	};
}
