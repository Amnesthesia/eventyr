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

const DEFAULT_MAX_RESULTS = 30;

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

	if (plan.kind === "day") {
		const file = await fetchFile<DayFile>(dayFileUrl(entry, plan.date));
		events = file.events;
		resolved = plan.date;
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
	}

	if (opts.category)
		events = events.filter((e) => e.category === opts.category);
	events = [...events].sort((a, b) => a.start.localeCompare(b.start));

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
