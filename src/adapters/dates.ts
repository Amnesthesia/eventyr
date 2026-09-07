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
// chrono takes an offset in minutes or a timezone *abbreviation*; an IANA name
// is not recognised, so "Australia/Brisbane" silently fell back to the host
// timezone and every scraped time on the UTC CI runner came out 10 hours late
// (7 date tests fail under TZ=UTC with the string). Brisbane has no DST, so a
// fixed offset is exact.
const TIMEZONE = BRISBANE_UTC_OFFSET_HOURS * 60;

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
	// Every abbreviation has to be reachable from three letters. "thurs?"
	// required at least "thur", so the commonest form — "Thu" — was not a
	// recognised marker and 32 candidates whose only date text was "Thu 3" were
	// discarded as undated, while "Wed 2" parsed fine.
	/\b(tonight|today|tomorrow|this|next|coming|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;

const MONTHS =
	"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/**
 * A month name sitting next to a day number, in either order — "Sep 16" or
 * "16 Sep". Such a string states its date outright, so a weekday in the same
 * text is decoration and must never be used to infer the day instead.
 */
const EXPLICIT_DATE = new RegExp(
	`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+(?:${MONTHS})\\b`,
	"i",
);

/** The reference instant's own Brisbane calendar date, for comparisons. */
function toDateOnly(instant: Date): string {
	return toBrisbaneISO(instant, false).slice(0, 10);
}

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
	// A string that names a month and a day number is not a relative reference,
	// whatever weekday it also carries. "Wed, Sep 16 7:00 PM" was resolved to
	// the NEXT Wednesday — 9 Sep — because en.GB could not read the month-first
	// date and fell back to the weekday, and the relative marker below waved
	// that through. The result was a wrong date and a dropped time on the site.
	if (EXPLICIT_DATE.test(raw)) return false;
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

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/**
 * "Thu 3", "Wed 2", "Sat 12 7:30pm" — a weekday followed by a day-of-month,
 * which is how most gig guides write a date.
 *
 * chrono cannot read this shape: it ignores the number ("Wed 2" resolved to
 * the NEXT Wednesday, discarding the 2) or mistakes it for a time ("Thu 10"
 * became today at 10:00). Both are wrong days, and this is the single most
 * common date format in the corpus — 32 candidates carried nothing else.
 *
 * The day number wins over the weekday when they disagree: the number is
 * explicit data, the weekday is redundant with it. Rewritten into a fully
 * qualified date so chrono still does the actual parsing, which keeps one
 * implementation of month rollover and time handling.
 */
const WEEKDAY_THEN_DAY =
	/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(\d{1,2})\b\s*(.*)$/i;

function qualifyWeekdayAndDay(text: string, reference: Date): string | null {
	const match = WEEKDAY_THEN_DAY.exec(text);
	if (!match) return null;
	const day = Number(match[1]);
	if (!Number.isInteger(day) || day < 1 || day > 31) return null;
	// A trailing time is kept; anything else means this is not the simple shape.
	const rest = match[2].trim();
	if (rest && !/^[0-9:.\s]*(?:am|pm)?$/i.test(rest)) return null;

	const local = new Date(reference.getTime() + OFFSET_MS);
	let month = local.getUTCMonth();
	let year = local.getUTCFullYear();
	// A day already past this month means they mean next month's.
	if (day < local.getUTCDate()) {
		month += 1;
		if (month > 11) {
			month = 0;
			year += 1;
		}
	}
	return `${day} ${MONTH_NAMES[month]} ${year}${rest ? ` ${rest}` : ""}`;
}

function parse(raw: string, referenceDate: Date): chrono.ParsedResult | null {
	let trimmed = raw.trim();
	if (!trimmed || NOT_A_DATE.test(trimmed)) return null;
	trimmed = qualifyWeekdayAndDay(trimmed, referenceDate) ?? trimmed;
	// Venue listings are about upcoming events, so a bare "Friday" or "12 Sep"
	// means the next one, not the most recent one.
	const context = { instant: referenceDate, timezone: TIMEZONE };
	const options = { forwardDate: true };

	let result = chrono.en.GB.parse(trimmed, context, options)[0];

	// en.GB is day-first on purpose — "03/04" has to be 3 April, per Australian
	// convention — but it refuses month-first dates, so "Wed, Sep 16 7:00 PM"
	// matched only the weekday and silently resolved to the wrong day with the
	// time thrown away. Retrying with the US locale recovers those, and is safe
	// precisely because it is gated on a month NAME being present: "Sep 16" and
	// "16 Sep" are both unambiguous, so the two locales cannot disagree. Bare
	// numerics never reach this branch and stay day-first.
	if (
		(!result || !result.start.isCertain("day")) &&
		EXPLICIT_DATE.test(trimmed)
	) {
		const monthFirst = chrono.en.parse(trimmed, context, options)[0];
		if (monthFirst?.start.isCertain("day")) result = monthFirst;
	}

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
		const endISO = parseSingleDateTime(until[1], referenceDate);
		// "Until 6 Sep" is a run that is on NOW and closes then, so the start is
		// today rather than unknown. Leaving it null read as undated and dropped
		// the event, which lost five real exhibitions. Only when the end is
		// actually still ahead of us — a past end is an archive listing.
		const stillRunning = endISO
			? endISO.slice(0, 10) >= toDateOnly(referenceDate)
			: false;
		return {
			startISO: stillRunning ? toBrisbaneISO(referenceDate, false) : null,
			endISO,
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
