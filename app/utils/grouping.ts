// Splits the event list into labelled groups, so a 300-event page can be read
// as "Thursday has these sixty" rather than as one undifferentiated grid.
import { CATEGORIES } from "../../src/shared.ts";
import type { Event } from "../types";
import { catToSlug } from "./categorySlug";
import { addDays, todayIso } from "./dates";

export type GroupBy = "none" | "date" | "category";

export interface EventGroup {
	/** Stable key for React, and the raw value the group was made from. */
	key: string;
	label: string;
	/** Category slug, so a category group's heading can carry its accent. */
	cat?: string;
	events: Event[];
}

/** The span of dates the page is actually showing: today through the end of
 * next week, the same window `curate.ts` publishes. */
export interface DateWindow {
	from: string;
	to: string;
}

/**
 * The window to build date groups from.
 *
 * Deliberately derived from the digest week rather than from the events: the
 * events include long-running exhibitions whose start dates go back to 2023,
 * and grouping by whatever dates appear in the data produced 33 groups holding
 * one or two events each, all of them outside the week being published.
 */
export function dateWindowFor(
	weekStart: string,
	weekEnd: string,
	today: string = todayIso(),
): DateWindow {
	const to = addDays(weekEnd, 7);
	// A stale build — today already past the window — would otherwise bucket
	// every event as "Later". Fall back to the digest week it was built for.
	const from = today >= weekStart && today <= to ? today : weekStart;
	return { from, to };
}

const DAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/**
 * Built by hand rather than with toLocaleDateString, for the same reason
 * normalise.ts's humanDatetime is: ICU output differs between builds and
 * platforms ("Sep" vs "Sept"), and this heading sits directly above cards
 * whose own date strings come from that hand-built formatter.
 */
export function dateLabel(iso: string, today: string): string {
	if (iso === today) return "Today";
	if (iso === addDays(today, 1)) return "Tomorrow";
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function startDate(event: Event): string {
	return (event.datetime_iso ?? "").slice(0, 10);
}

/** Ascending by start instant, so a group reads down the day. Undated sinks to
 * the bottom, and a date with no time sits before that day's timed events —
 * which is what an all-day event is. */
function byStartTime(a: Event, b: Event): number {
	return (a.datetime_iso || "9999").localeCompare(b.datetime_iso || "9999");
}

/** Ascending by end date: for something already running when the window
 * opened, a start time months ago says nothing, but "closes soonest" does. */
function byEndDate(a: Event, b: Event): number {
	return (a.datetime_end_iso || "9999").localeCompare(
		b.datetime_end_iso || "9999",
	);
}

function groupByDate(
	events: Event[],
	window: DateWindow,
	today: string,
): EventGroup[] {
	// Buckets come from the window, not from the data, and an event lands in
	// exactly one of them — keyed on its start date. A run that opened before
	// the window is "Ongoing" rather than being repeated under every date it
	// covers, which is the noise this replaced.
	const byDay = new Map<string, Event[]>();
	const ongoing: Event[] = [];
	const later: Event[] = [];
	const undated: Event[] = [];

	for (const event of events) {
		const start = startDate(event);
		if (!start) undated.push(event);
		else if (start < window.from) ongoing.push(event);
		else if (start > window.to) later.push(event);
		else byDay.set(start, [...(byDay.get(start) ?? []), event]);
	}

	const groups: EventGroup[] = [];
	// Walked forward across the window so the days come out in order and empty
	// ones are simply absent — a heading with nothing under it is not an
	// overview.
	for (let day = window.from; day <= window.to; day = addDays(day, 1)) {
		const dayEvents = byDay.get(day);
		if (dayEvents?.length) {
			groups.push({
				key: day,
				label: dateLabel(day, today),
				events: [...dayEvents].sort(byStartTime),
			});
		}
	}

	// The exceptions go after the dates: the control says "by date", so a date
	// ordering leads, and these three have no place in one.
	if (ongoing.length > 0) {
		groups.push({
			key: "ongoing",
			label: "Ongoing",
			events: [...ongoing].sort(byEndDate),
		});
	}
	if (later.length > 0) {
		groups.push({
			key: "later",
			label: "Later",
			events: [...later].sort(byStartTime),
		});
	}
	if (undated.length > 0) {
		groups.push({
			key: "undated",
			label: "Date to be confirmed",
			events: [...undated].sort(byStartTime),
		});
	}
	return groups;
}

export function groupEvents(
	events: Event[],
	mode: GroupBy,
	window: DateWindow,
	today: string = todayIso(),
): EventGroup[] {
	if (mode === "none") return [{ key: "all", label: "", events }];
	if (mode === "date") return groupByDate(events, window, today);

	const buckets = new Map<string, Event[]>();
	for (const event of events) {
		const key = event.category || "";
		buckets.set(key, [...(buckets.get(key) ?? []), event]);
	}

	// CATEGORIES order rather than alphabetical or count, so the groups sit in
	// the same order on every city and every filter — an overview that
	// reshuffles itself is not an overview.
	const ordered = [
		...CATEGORIES.filter((c) => buckets.has(c)),
		...[...buckets.keys()].filter((c) => !CATEGORIES.includes(c as never)),
	];
	return ordered.map((key) => ({
		key: key || "uncategorised",
		label: key || "Uncategorised",
		cat: key ? catToSlug(key) : undefined,
		events: [...(buckets.get(key) ?? [])].sort(byStartTime),
	}));
}
