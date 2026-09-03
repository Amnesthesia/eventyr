// Date parsing for adapter-extracted raw date/time strings. All output is
// Brisbane-instant ISO 8601 (Australia/Brisbane = UTC+10 year-round, no DST).
//
// Backed by chrono-node's British locale, which matters for three reasons:
// it reads dates day-first (03/04 is 3 April, per Australian convention, never
// month-first), it anchors relative phrases against a supplied reference
// instant and timezone, and it returns a start AND an end so ranges and
// "6-10pm" style times come out correctly rather than being hand-parsed.
//
// This replaced ~250 lines of hand-rolled regex that still could not read
// "Tonight", "Wed 2" or "ON NOW" — which are exactly the phrases venue gig
// guides use for the events happening this week — and which had produced
// invalid dates like 2026-02-31 and resolved "6-10pm" to 10pm.
//
// Policy, unchanged: prefer null over a guess. chrono is deliberately
// permissive, so everything it returns passes the gate in isTrustworthy()
// below; recurring language ("every Tuesday") and vague periods ("Spring
// 2026") stay null, because a recurrence is not a date and publishing a
// guessed one puts a wrong time on the site.

import * as chrono from "chrono-node";

export const BRISBANE_UTC_OFFSET_HOURS = 10;
const OFFSET_MS = BRISBANE_UTC_OFFSET_HOURS * 3_600_000;
const TIMEZONE = "Australia/Brisbane";

export interface ParsedDateRange {
	startISO: string | null;
	endISO: string | null;
}

/**
 * Phrases that describe a recurrence or an indefinite period rather than a
 * date. chrono resolves several of them to a concrete day ("every Tuesday" →
 * next Tuesday), which would be wrong to publish, so they are refused before
 * it ever sees the text.
 */
const NOT_A_DATE =
	/\b(every|each|weekly|fortnightly|monthly|daily|recurring|various dates|multiple dates|dates? (?:to be confirmed|tbc|tba)|tbc|tba|season|spring|summer|autumn|winter)\b/i;

/**
 * "Running right now" phrasing that chrono has no opinion on, but which is
 * unambiguous on an exhibition listing: it is on today.
 */
const ON_NOW =
	/^\s*(on\s+now|now\s+showing|now\s+open|showing\s+now|ongoing|all\s+week|open\s+daily)\s*$/i;

/**
 * Relative and weekday-anchored phrasing. chrono reports `isCertain("day")`
 * false for these (it inferred the day rather than reading a day number), but
 * they are still trustworthy — "This Saturday" and "Wed 2" both resolve
 * correctly. The same certainty flag is what rejects "45 September 2026", so
 * the gate is "an explicit day number, OR a relative marker that explains the
 * inference".
 */
const RELATIVE_MARKER =
	/\b(tonight|today|tomorrow|this|next|coming|mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?|sun)[a-z]*\b/i;

function pad(n: number, len = 2): string {
	return String(n).padStart(len, "0");
}

/** Formats an instant as a Brisbane wall-clock ISO string with the offset. */
function toBrisbaneISO(instant: Date, includeTime: boolean): string {
	const local = new Date(instant.getTime() + OFFSET_MS);
	const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
	const time = includeTime
		? `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00`
		: "00:00:00";
	return `${date}T${time}+${pad(BRISBANE_UTC_OFFSET_HOURS)}:00`;
}

/**
 * Whether a chrono result is solid enough to publish. Either it read a real
 * day number, or the text carried a relative/weekday marker that accounts for
 * the inferred day. A month-and-year-only match ("Spring 2026", "45
 * September") satisfies neither and is refused.
 */
function isTrustworthy(result: chrono.ParsedResult, raw: string): boolean {
	if (result.start.isCertain("day")) return true;
	return RELATIVE_MARKER.test(raw);
}

interface Resolved {
	start: Date;
	end: Date | null;
	startHasTime: boolean;
	endHasTime: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Turns a chrono result into instants, correcting one systematic misread.
 *
 * For "11-1pm" chrono applies the trailing meridiem only to the end, infers
 * 11 as 11pm, and then — because 1pm is earlier than 11pm — pushes the end to
 * the following day. The result is a 14-hour event starting at 11pm, when the
 * text plainly means 11am to 1pm. The tell is an end that crossed midnight
 * while still being an afternoon time: a genuine overnight range ("11pm-1am")
 * has an end in the morning hours, so it is left alone.
 */
function resolve(result: chrono.ParsedResult): Resolved {
	let start = result.start.date();
	let end = result.end ? result.end.date() : null;
	const startHour = result.start.get("hour") ?? 0;
	const endHour = result.end?.get("hour") ?? 0;

	if (
		end &&
		end.getTime() > start.getTime() &&
		end.getTime() - start.getTime() < DAY_MS &&
		startHour >= 12 &&
		endHour >= 12 &&
		// the end was pushed past midnight relative to the start
		Math.floor((end.getTime() + OFFSET_MS) / DAY_MS) !==
			Math.floor((start.getTime() + OFFSET_MS) / DAY_MS)
	) {
		start = new Date(start.getTime() - 12 * 3_600_000);
		end = new Date(end.getTime() - DAY_MS);
	}

	return {
		start,
		end,
		startHasTime: result.start.isCertain("hour"),
		endHasTime: result.end?.isCertain("hour") ?? false,
	};
}

function parse(raw: string, referenceDate: Date): chrono.ParsedResult | null {
	const trimmed = raw.trim();
	if (!trimmed || NOT_A_DATE.test(trimmed)) return null;
	const results = chrono.en.GB.parse(
		trimmed,
		{ instant: referenceDate, timezone: TIMEZONE },
		// Venue listings are about upcoming events, so a bare "Friday" or
		// "12 Sep" means the next one, not the most recent one.
		{ forwardDate: true },
	);
	const result = results[0];
	if (!result) return null;
	return isTrustworthy(result, trimmed) ? result : null;
}

/** Parses a single date/time string into a Brisbane-instant ISO string. */
export function parseSingleDateTime(
	raw: string,
	referenceDate: Date = new Date(),
): string | null {
	if (ON_NOW.test(raw ?? "")) {
		return toBrisbaneISO(referenceDate, false);
	}
	const result = parse(raw ?? "", referenceDate);
	if (!result) return null;
	const { start, startHasTime } = resolve(result);
	return toBrisbaneISO(start, startHasTime);
}

/**
 * Parses a date range appearing in one string, e.g. "5 – 19 September 2026",
 * "Tue 21 – Sun 26 Jul", "6-10pm", or an open-ended "until 3 August 2026"
 * (start left null on purpose — the run's actual start is unknown).
 */
export function parseDateRange(
	raw: string,
	referenceDate: Date = new Date(),
): ParsedDateRange {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return { startISO: null, endISO: null };

	// "until 3 August" is an end with no start. chrono reads it as a plain
	// date, so handle the framing here.
	const until = /^(?:until|through|til|till|to)\s+(.+)$/i.exec(trimmed);
	if (until) {
		return {
			startISO: null,
			endISO: parseSingleDateTime(until[1], referenceDate),
		};
	}

	const result = parse(trimmed, referenceDate);
	if (!result) return { startISO: null, endISO: null };
	const { start, end, startHasTime, endHasTime } = resolve(result);
	return {
		startISO: toBrisbaneISO(start, startHasTime),
		endISO: end ? toBrisbaneISO(end, endHasTime) : null,
	};
}
