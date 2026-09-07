// Where each saved event sits on a week grid.
//
// Split out of SavedCalendar so the arithmetic — which day a thing lands on,
// which hours the grid has to cover, how far down a lane a 7:30pm start
// belongs — can be checked without rendering anything.

import type { Event } from "../types";
import { addDays, eventOverlapsRange } from "./dates";

/** The lane the grid draws when nothing pins it wider. Most events fall inside
 * it, and a row per hour of the night is empty space to scroll past. */
export const DEFAULT_FIRST_HOUR = 8;
export const DEFAULT_LAST_HOUR = 23;

export interface TimedPlacement {
	event: Event;
	/** Minutes past midnight, local to the city — the value the grid offsets by. */
	minutes: number;
}

export interface DayLane {
	day: string;
	timed: TimedPlacement[];
}

export interface AllDayBar {
	event: Event;
	/** 1-based CSS grid column of the first day it covers in this week. */
	startCol: number;
	/** 1-based column AFTER the last day it covers, i.e. grid-column end. */
	endCol: number;
	/** 1-based row, so runs that overlap in time sit above one another. */
	lane: number;
}

export interface WeekLayout {
	days: string[];
	lanes: DayLane[];
	/** All-day and multi-day runs, each as ONE bar spanning the days it covers.
	 * Repeating a five-month exhibition as seven identical chips filled the
	 * strip and pushed the grid off screen. */
	allDayBars: AllDayBar[];
	/** How many rows the all-day strip needs. */
	allDayLanes: number;
	firstHour: number;
	lastHour: number;
}

/** Minutes past midnight, or null when the event has a date but no time.
 * datetime_iso is a naive wall-clock string, so this reads the characters
 * rather than constructing a Date — parsing it would apply the viewer's own
 * timezone to a value that is already local to the city. */
export function startMinutes(event: Event): number | null {
	const iso = event.datetime_iso || "";
	if (iso.length <= 10) return null;
	const hours = Number(iso.slice(11, 13));
	const mins = Number(iso.slice(14, 16));
	if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
	return hours * 60 + mins;
}

/**
 * Whether the event runs across more than one day.
 *
 * A run is an all-day bar even when it has a start time. An exhibition opening
 * "14 Feb, 10:00 AM" and closing in January is not a two-hour slot on 14
 * February: blocking it out there hid it from every week except the one it
 * opened in, which is the week the calendar would then jump to. The opening
 * time still shows in the bar's tooltip, where it belongs.
 */
export function isRun(event: Event): boolean {
	const start = (event.datetime_iso || "").slice(0, 10);
	const end = (event.datetime_end_iso || "").slice(0, 10);
	return !!start && !!end && end > start;
}

/** Placed at an hour on the grid, rather than as a bar over whole days. */
function isTimedSlot(event: Event): boolean {
	return startMinutes(event) !== null && !isRun(event);
}

export function weekLayout(events: Event[], weekStart: string): WeekLayout {
	const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
	const weekEnd = days[6];

	const lanes: DayLane[] = days.map((day) => ({
		day,
		timed: events
			.filter(
				(e) => isTimedSlot(e) && (e.datetime_iso || "").slice(0, 10) === day,
			)
			.map((event) => ({ event, minutes: startMinutes(event) as number }))
			.sort((a, b) => a.minutes - b.minutes),
	}));

	// The lane grows to fit what is actually in this week, so an 8am workshop or
	// a midnight gig is on the grid rather than clipped off the end of it.
	const inWeek = lanes.flatMap((lane) =>
		lane.day >= weekStart && lane.day <= weekEnd
			? lane.timed.map((t) => t.minutes)
			: [],
	);
	return {
		days,
		lanes,
		...packAllDay(events, days),
		firstHour: Math.min(
			DEFAULT_FIRST_HOUR,
			...inWeek.map((m) => Math.floor(m / 60)),
		),
		lastHour: Math.min(
			24,
			Math.max(DEFAULT_LAST_HOUR, ...inWeek.map((m) => Math.floor(m / 60) + 1)),
		),
	};
}

/** How far down its lane a chip sits, as a percentage. */
export function offsetPercent(
	minutes: number,
	firstHour: number,
	lastHour: number,
): number {
	const span = (lastHour - firstHour) * 60;
	if (span <= 0) return 0;
	return ((minutes - firstHour * 60) / span) * 100;
}

/**
 * Lays the all-day runs out as spanning bars, packed into as few rows as they
 * will fit into.
 *
 * Greedy by start column: each bar takes the first row whose last bar has
 * already ended. That is optimal for interval graphs, and with a handful of
 * saved events it is a loop over nothing.
 */
function packAllDay(
	events: Event[],
	days: string[],
): { allDayBars: AllDayBar[]; allDayLanes: number } {
	const weekStart = days[0];
	const weekEnd = days[6];
	const bars = events
		.filter((e) => !isTimedSlot(e) && eventOverlapsRange(e, weekStart, weekEnd))
		.map((event) => {
			const start = (event.datetime_iso || "").slice(0, 10);
			const end = (event.datetime_end_iso || "").slice(0, 10) || start;
			// Clamped to the week: a run that opened in May starts at column 1
			// here, and the bar says "already running" by touching the edge.
			const first = Math.max(
				0,
				days.indexOf(start < weekStart ? weekStart : start),
			);
			const last = Math.max(first, days.indexOf(end > weekEnd ? weekEnd : end));
			return { event, first, last };
		})
		.sort((a, b) => a.first - b.first || a.last - b.last);

	/** Last occupied column per row. */
	const rowEnds: number[] = [];
	const allDayBars = bars.map(({ event, first, last }) => {
		let lane = rowEnds.findIndex((end) => end < first);
		if (lane === -1) lane = rowEnds.length;
		rowEnds[lane] = last;
		// +1 twice over: the gutter is column 1, and CSS grid lines are 1-based.
		return { event, startCol: first + 2, endCol: last + 3, lane: lane + 1 };
	});
	return { allDayBars, allDayLanes: Math.max(rowEnds.length, 1) };
}
