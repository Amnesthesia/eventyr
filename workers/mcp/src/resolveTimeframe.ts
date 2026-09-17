// Pure timeframe -> file-selection logic for get_events. No fetch, no Date.now()
// — the caller supplies the city's own local "today" (computed from its IANA
// timezone, never the Worker's UTC clock) and the list of day dates the /ai
// feed has actually published, so this stays testable with plain arrays.
//
// An explicit `date` argument bypasses this entirely (see resolveExplicitDate
// below) rather than being folded into the timeframe switch, keeping this
// function's surface small and its tests focused on the five relative cases.

import { addDays, weekendRange } from "../../../app/utils/dates.ts";

export const TIMEFRAMES = [
	"today",
	"tomorrow",
	"this_weekend",
	"this_week",
	"next_week",
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export type TimeframePlan =
	| { kind: "day"; date: string }
	| { kind: "days"; dates: string[] }
	| { kind: "week" }
	| { kind: "unavailable"; reason: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayPlan(date: string, availableDates: string[]): TimeframePlan {
	if (!availableDates.includes(date)) {
		return {
			kind: "unavailable",
			reason: `${date} is beyond the currently published week`,
		};
	}
	return { kind: "day", date };
}

export function resolveTimeframe(
	timeframe: Timeframe,
	cityToday: string,
	availableDates: string[],
	hasWeek: boolean,
): TimeframePlan {
	switch (timeframe) {
		case "today":
			return dayPlan(cityToday, availableDates);
		case "tomorrow":
			return dayPlan(addDays(cityToday, 1), availableDates);
		case "this_weekend": {
			const { start, end } = weekendRange(cityToday);
			const dates = start === end ? [start] : [start, end];
			const available = dates.filter((d) => availableDates.includes(d));
			if (available.length === 0) {
				return {
					kind: "unavailable",
					reason: "this weekend is beyond the currently published week",
				};
			}
			return { kind: "days", dates: available };
		}
		case "this_week":
			return hasWeek
				? { kind: "week" }
				: {
						kind: "unavailable",
						reason: "this week's file has not been published yet",
					};
		case "next_week":
			return {
				kind: "unavailable",
				reason:
					"next week is not available — this feed only ever publishes the current week",
			};
	}
}

/** A named day ("March 15th") bypasses resolveTimeframe: it maps straight to
 * that city's single day file, with no relative-date reasoning involved. */
export function resolveExplicitDate(
	date: string,
	cityToday: string,
	availableDates: string[],
): TimeframePlan {
	if (!ISO_DATE.test(date)) {
		return {
			kind: "unavailable",
			reason: `"${date}" is not a valid date — expected YYYY-MM-DD`,
		};
	}
	if (date < cityToday) {
		return {
			kind: "unavailable",
			reason:
				"that date is in the past — this feed only publishes today onward",
		};
	}
	return dayPlan(date, availableDates);
}
