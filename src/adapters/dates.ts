// Date parsing for adapter-extracted raw date/time strings. All output is ISO
// 8601 in the city's own zone, with the UTC offset in force at that instant
// (so a DST city gets +11:00 in summer and +10:00 in winter).
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

import {
	formatOffset,
	zonedDate,
	zonedOffsetMinutes,
	zonedTimeToInstant,
} from "@dothingslol/utils/tz";
import * as chrono from "chrono-node";

// chrono takes an offset in minutes or a timezone *abbreviation*; an IANA name
// is not recognised, so "Australia/Brisbane" silently fell back to the host
// timezone and every scraped time on the UTC CI runner came out 10 hours late
// (7 date tests fail under TZ=UTC with the string).
//
// A fixed offset is only exact for a zone without DST, and it used to be a
// Brisbane constant for every city: Byron Bay (Australia/Sydney, +11:00 from
// October to April) was published an hour off all summer. So chrono is seeded
// with the zone's offset at the REFERENCE instant, which is what it resolves
// relative phrases ("tonight", "this Saturday") against, and every wall-clock
// reading it returns is then turned into an instant with the offset in force
// on THAT date (zonedTimeToInstant), rather than the seed's.

/** Why a string that chrono read was still refused. Named so the log line and
 * the tests agree on it. */
export const DST_GAP = "nonexistent local time (skipped by the DST change)";

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

function pad(n: number, len = 2): string {
	return String(n).padStart(len, "0");
}

/** An instant as a wall-clock ISO string in `timeZone`, with that instant's
 * offset. Seconds are dropped: no listing states them. */
function instantISO(instant: Date, timeZone: string): string {
	const offset = zonedOffsetMinutes(timeZone, instant);
	const local = new Date(instant.getTime() + offset * 60_000);
	const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
	const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00`;
	return `${date}T${time}${formatOffset(offset)}`;
}

/**
 * A date with no time, as local midnight with the offset in force AT midnight.
 * Which offset matters: normalise.ts turns this back into a wall-clock string,
 * and an offset from later in the day (a DST change at 02:00) would make that
 * 23:00 the day before instead of the date-only value midnight stands for.
 */
function dateOnlyISO(date: string, timeZone: string): string {
	const wall = Date.parse(`${date}T00:00:00Z`);
	// ponytail: a zone whose DST starts AT midnight (none in Australia) has no
	// local midnight on that day; the offset at the wall reading is close enough
	// for a value only its date is read from.
	const midnight = zonedTimeToInstant(timeZone, wall) ?? new Date(wall);
	return `${date}T00:00:00${formatOffset(zonedOffsetMinutes(timeZone, midnight))}`;
}

/** A chrono reading as wall-clock UTC ms, in whatever zone it was read in. */
function wallOf(c: chrono.ParsedComponents): number {
	return Date.UTC(
		c.get("year") ?? 0,
		(c.get("month") ?? 1) - 1,
		c.get("day") ?? 1,
		c.get("hour") ?? 0,
		c.get("minute") ?? 0,
		c.get("second") ?? 0,
	);
}

/** YYYY-MM-DD of a wall-clock reading. */
function dateOfWall(wall: number): string {
	return new Date(wall).toISOString().slice(0, 10);
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
	/** Wall-clock readings (UTC ms), not instants: see resolve(). */
	start: number;
	end: number | null;
	startHasTime: boolean;
	endHasTime: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Turns a chrono result into wall-clock readings, correcting one systematic
 * misread.
 *
 * For "11-1pm" chrono applies the trailing meridiem only to the end, infers
 * 11 as 11pm, and then — because 1pm is earlier than 11pm — pushes the end to
 * the following day. The result is a 14-hour event starting at 11pm, when the
 * text plainly means 11am to 1pm. The tell is an end that crossed midnight
 * while still being an afternoon time: a genuine overnight range ("11pm-1am")
 * has an end in the morning hours, so it is left alone.
 *
 * Works on wall-clock readings rather than instants, so the shift is "12 hours
 * earlier on the clock": subtracting 12h from an instant would land an hour
 * off whenever a DST change sits between the two.
 */
function resolve(result: chrono.ParsedResult): Resolved {
	let start = wallOf(result.start);
	let end = result.end ? wallOf(result.end) : null;
	const startHour = result.start.get("hour") ?? 0;
	const endHour = result.end?.get("hour") ?? 0;

	if (
		end !== null &&
		end > start &&
		end - start < DAY_MS &&
		startHour >= 12 &&
		endHour >= 12 &&
		// the end was pushed past midnight relative to the start
		Math.floor(end / DAY_MS) !== Math.floor(start / DAY_MS)
	) {
		start -= 12 * 3_600_000;
		end -= DAY_MS;
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

function qualifyWeekdayAndDay(
	text: string,
	reference: Date,
	timeZone: string,
): string | null {
	const match = WEEKDAY_THEN_DAY.exec(text);
	if (!match) return null;
	const day = Number(match[1]);
	if (!Number.isInteger(day) || day < 1 || day > 31) return null;
	// A trailing time is kept; anything else means this is not the simple shape.
	const rest = match[2].trim();
	if (rest && !/^[0-9:.\s]*(?:am|pm)?$/i.test(rest)) return null;

	const local = new Date(`${zonedDate(timeZone, reference)}T00:00:00Z`);
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

/**
 * The reference to hand chrono so that its output does not depend on the host.
 *
 * chrono does part of its arithmetic in the HOST's local time (it reads dates
 * back with Date#getDate and friends: forwardDate, and pushing a range's end
 * past midnight) and is only self-consistent when the host's offset equals the
 * `timezone` it is given. On the UTC runner, with Brisbane's +600, "3
 * September" read on 3 September became next year and "11-1pm" ended before it
 * began under TZ=America/Los_Angeles. So chrono is told it is parsing in the
 * host's own zone, at the instant the host's clock shows what the city's clock
 * shows at the reference: every reading it returns is then the city's wall
 * clock whatever the host, and toISO converts it with the city's offset for
 * that date.
 *
 * ponytail: the host's offset is read at the reference, so a parsed date on the
 * far side of a HOST DST change can still be an hour out inside chrono. Exact on
 * a UTC host (CI) and on any host without DST; a vendored chrono refiner that
 * never reads host-local time is the upgrade if a DST-observing host matters.
 */
function chronoReference(
	referenceDate: Date,
	timeZone: string,
): { instant: Date; timezone: number } {
	const wall =
		referenceDate.getTime() +
		zonedOffsetMinutes(timeZone, referenceDate) * 60_000;
	// Date#getTimezoneOffset is minutes BEHIND UTC. Asked twice so a host DST
	// change between `wall` and the answer is picked up.
	let instant = new Date(wall + new Date(wall).getTimezoneOffset() * 60_000);
	instant = new Date(wall + instant.getTimezoneOffset() * 60_000);
	return { instant, timezone: -instant.getTimezoneOffset() };
}

function parse(
	raw: string,
	referenceDate: Date,
	timeZone: string,
): chrono.ParsedResult | null {
	let trimmed = raw.trim();
	if (!trimmed || NOT_A_DATE.test(trimmed)) return null;
	trimmed = qualifyWeekdayAndDay(trimmed, referenceDate, timeZone) ?? trimmed;
	// Venue listings are about upcoming events, so a bare "Friday" or "12 Sep"
	// means the next one, not the most recent one.
	const context = chronoReference(referenceDate, timeZone);
	const options = { forwardDate: true };

	let result = chrono.en.GB.parse(trimmed, context, options)[0];

	// en.GB is day-first on purpose — "03/04" has to be 3 April, per Australian
	// convention — but it refuses month-first dates, so "Wed, Sep 16 7:00 PM"
	// matched only the weekday and silently resolved to the wrong day with the
	// time thrown away. Retrying with the US locale recovers those, and is safe
	// precisely because it is gated on a month NAME being present: "Sep 16" and
	// "16 Sep" are both unambiguous, so the two locales cannot disagree. Bare
	// numerics never reach this branch and stay day-first.
	if (!result?.start.isCertain("day") && EXPLICIT_DATE.test(trimmed)) {
		const monthFirst = chrono.en.parse(trimmed, context, options)[0];
		if (monthFirst?.start.isCertain("day")) result = monthFirst;
	}

	if (!result) return null;
	return isTrustworthy(result, trimmed) ? result : null;
}

/**
 * One resolved reading as ISO in `timeZone`. A reading whose text states its
 * own offset ("…+11:00", "…Z", "AEDT") is already an instant; any other reading
 * is wall-clock time in the city. Null when that wall-clock time does not exist
 * (the DST gap) — prefer null over a guess.
 */
function toISO(
	component: chrono.ParsedComponents,
	wall: number,
	hasTime: boolean,
	timeZone: string,
	raw: string,
): string | null {
	// chrono also "knows" the offset of readings it computed from the reference
	// ("now", "in 2 hours"), but that is the host offset chronoReference handed
	// it, and those readings are city wall-clock time like any other.
	const tags = component.tags();
	const explicit =
		component.isCertain("timezoneOffset") &&
		!tags.has("result/relativeDateAndTime") &&
		!tags.has("casualReference/now");
	const instant = explicit
		? new Date(wall - (component.get("timezoneOffset") ?? 0) * 60_000)
		: null;
	if (!hasTime) {
		return dateOnlyISO(
			instant ? zonedDate(timeZone, instant) : dateOfWall(wall),
			timeZone,
		);
	}
	const at = instant ?? zonedTimeToInstant(timeZone, wall);
	if (!at) {
		console.warn(
			`  ⚠ dates: ${DST_GAP} in ${timeZone}: ${JSON.stringify(raw)}`,
		);
		return null;
	}
	return instantISO(at, timeZone);
}

/** Parses a single date/time string into an ISO string in `timeZone`. */
export function parseSingleDateTime(
	raw: string,
	referenceDate: Date,
	timeZone: string,
): string | null {
	if (ON_NOW.test(raw ?? "")) {
		return dateOnlyISO(zonedDate(timeZone, referenceDate), timeZone);
	}
	const result = parse(raw ?? "", referenceDate, timeZone);
	if (!result) return null;
	const { start, startHasTime } = resolve(result);
	return toISO(result.start, start, startHasTime, timeZone, raw);
}

/**
 * Parses a date range appearing in one string, e.g. "5 – 19 September 2026",
 * "Tue 21 – Sun 26 Jul", "6-10pm", or an open-ended "until 3 August 2026"
 * (start left null on purpose — the run's actual start is unknown).
 */
export function parseDateRange(
	raw: string,
	referenceDate: Date,
	timeZone: string,
): ParsedDateRange {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return { startISO: null, endISO: null };

	// "until 3 August" is an end with no start. chrono reads it as a plain
	// date, so handle the framing here.
	const until = /^(?:until|through|til|till|to)\s+(.+)$/i.exec(trimmed);
	if (until) {
		const endISO = parseSingleDateTime(until[1], referenceDate, timeZone);
		// "Until 6 Sep" is a run that is on NOW and closes then, so the start is
		// today rather than unknown. Leaving it null read as undated and dropped
		// the event, which lost five real exhibitions. Only when the end is
		// actually still ahead of us — a past end is an archive listing.
		const today = zonedDate(timeZone, referenceDate);
		const stillRunning = endISO ? endISO.slice(0, 10) >= today : false;
		return {
			startISO: stillRunning ? dateOnlyISO(today, timeZone) : null,
			endISO,
		};
	}

	const result = parse(trimmed, referenceDate, timeZone);
	if (!result) return { startISO: null, endISO: null };
	const { start, end, startHasTime, endHasTime } = resolve(result);
	const startISO = toISO(result.start, start, startHasTime, timeZone, raw);
	// No start means the whole range is unusable: an end on its own would read
	// as an open-ended "until" run, which is not what the text said.
	if (!startISO) return { startISO: null, endISO: null };
	return {
		startISO,
		endISO:
			end !== null && result.end
				? toISO(result.end, end, endHasTime, timeZone, raw)
				: null,
	};
}

/**
 * How many date-shaped fragments a piece of text contains. A free signal for
 * "could this text yield a dated event at all?" — probe uses it to gate which
 * pages get an extraction call, and llmExtract to skip batches (footers,
 * related-content blocks) that cannot produce anything prepareCandidates would
 * keep.
 */
export function countDateHits(text: string): number {
	const patterns = [
		/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi,
		/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi,
		/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g,
		/\b\d{4}-\d{2}-\d{2}\b/g,
		/\b\d{1,2}\s*(am|pm)\b/gi,
	];
	return patterns.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}
