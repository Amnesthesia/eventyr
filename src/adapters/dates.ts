// Date parsing for adapter-extracted raw date/time strings. All output is
// Brisbane-instant ISO 8601 (Australia/Brisbane = UTC+10 year-round, no
// DST) plus the untouched original string.
//
// Policy: prefer null over a guess. This module resolves the concrete
// cases below; anything it can't confidently parse — recurring language
// ("every Tuesday"), vague seasons ("Spring 2026"), or a string it simply
// doesn't recognise — returns null rather than approximating. Occurrence
// modeling for exhibitions/seasons with many sessions is a Phase 6 concern,
// not this module's.
//
// Handled: ISO 8601 passthrough (date-only or with time; trusts any
// explicit offset, otherwise treats as Brisbane local time); "D Month[,]
// [YYYY][, time]" and "Month D[,] [YYYY]"; "DD/MM/YYYY" (day-first, per
// Australian convention — 03/04 is 3 April, never month-first); simple
// same-string ranges ("5 – 19 September[, YYYY]", "Tue 21 – Sun 26 Jul");
// open-ended "until D Month[, YYYY]" (end only, start intentionally null).
// Not handled: recurring/seasonal language, ranges spanning years without
// an explicit year on both sides.

export const BRISBANE_UTC_OFFSET_HOURS = 10;

export interface ParsedDateRange {
	startISO: string | null;
	endISO: string | null;
}

const MONTHS: Record<string, number> = {
	jan: 0,
	january: 0,
	feb: 1,
	february: 1,
	mar: 2,
	march: 2,
	apr: 3,
	april: 3,
	may: 4,
	jun: 5,
	june: 5,
	jul: 6,
	july: 6,
	aug: 7,
	august: 7,
	sep: 8,
	sept: 8,
	september: 8,
	oct: 9,
	october: 9,
	nov: 10,
	november: 10,
	dec: 11,
	december: 11,
};

interface TimeOfDay {
	hour: number;
	minute: number;
}

function parseTimeOfDay(raw: string): TimeOfDay | null {
	// Requires a colon-minute part or an am/pm suffix — a bare 1-2 digit
	// number (e.g. a leftover day-of-month) must never be read as an hour.
	const m = /(\d{1,2})(?:(:(\d{2}))\s*(am|pm)?|\s*(am|pm))/i.exec(raw.trim());
	if (!m) return null;
	const hasColon = m[2] !== undefined;
	const minuteStr = m[3];
	const meridiemStr = hasColon ? m[4] : m[5];
	return finishTimeOfDay(
		Number(m[1]),
		minuteStr ? Number(minuteStr) : 0,
		meridiemStr,
	);
}

function finishTimeOfDay(
	hour: number,
	minute: number,
	meridiem: string | undefined,
): TimeOfDay | null {
	let h = hour;
	const m = meridiem?.toLowerCase();
	if (h > 23 || minute > 59) return null;
	if (m === "pm" && h < 12) h += 12;
	if (m === "am" && h === 12) h = 0;
	return { hour: h, minute };
}

interface CalendarDate {
	year: number | null;
	month: number; // 0-based
	day: number;
}

// "14 June 2026", "14 Jun", "June 14, 2026", "Jun 14"
function parseTextualDate(raw: string): CalendarDate | null {
	const dayFirst =
		/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s*(\d{4})?/.exec(raw);
	if (dayFirst) {
		const month = MONTHS[dayFirst[2].toLowerCase()];
		if (month !== undefined) {
			return {
				day: Number(dayFirst[1]),
				month,
				year: dayFirst[3] ? Number(dayFirst[3]) : null,
			};
		}
	}
	const monthFirst =
		/([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/.exec(raw);
	if (monthFirst) {
		const month = MONTHS[monthFirst[1].toLowerCase()];
		if (month !== undefined) {
			return {
				day: Number(monthFirst[2]),
				month,
				year: monthFirst[3] ? Number(monthFirst[3]) : null,
			};
		}
	}
	return null;
}

// "03/04/2026" — Australian day-first convention, never month-first.
function parseSlashDate(raw: string): CalendarDate | null {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
	if (!m) return null;
	const day = Number(m[1]);
	const month = Number(m[2]) - 1;
	const year = Number(m[3]);
	if (month < 0 || month > 11 || day < 1 || day > 31) return null;
	return { day, month, year };
}

function parseIsoDate(
	raw: string,
): { date: Date; hasOffset: boolean; dateOnly: boolean } | null {
	const trimmed = raw.trim();
	if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) return null;
	return {
		date,
		hasOffset: /[Zz]|[+-]\d{2}:?\d{2}$/.test(trimmed),
		dateOnly: /^\d{4}-\d{2}-\d{2}$/.test(trimmed),
	};
}

function toBrisbaneISO(
	cal: CalendarDate,
	time: TimeOfDay | null,
	referenceDate: Date,
): string {
	const year = cal.year ?? resolveImplicitYear(cal, referenceDate);
	const hour = time?.hour ?? 0;
	const minute = time?.minute ?? 0;
	const pad = (n: number, len = 2) => String(n).padStart(len, "0");
	const offset = `+${pad(BRISBANE_UTC_OFFSET_HOURS)}:00`;
	return `${year}-${pad(cal.month + 1)}-${pad(cal.day)}T${pad(hour)}:${pad(minute)}:00${offset}`;
}

// When a source omits the year (common on "this week" listing pages), use
// the reference year, rolling to next year if that would place the date
// more than ~60 days in the past — handles listings crossing a Dec/Jan
// boundary. This resolves an omission in how the date is written, not a
// guess about the event itself.
function resolveImplicitYear(cal: CalendarDate, referenceDate: Date): number {
	const year = referenceDate.getFullYear();
	const candidate = Date.UTC(year, cal.month, cal.day);
	const diffDays = (candidate - referenceDate.getTime()) / 86_400_000;
	return diffDays < -60 ? year + 1 : year;
}

function tryParseCalendarDate(raw: string): CalendarDate | null {
	return parseSlashDate(raw) ?? parseTextualDate(raw);
}

/** Parses a single date/time string (no range) into a Brisbane-instant ISO string. */
export function parseSingleDateTime(
	raw: string,
	referenceDate: Date = new Date(),
): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const iso = parseIsoDate(trimmed);
	if (iso) {
		if (iso.hasOffset) return iso.date.toISOString();
		// No explicit offset: treat the wall-clock value as Brisbane local time.
		const [datePart, timePart] = trimmed.split("T");
		const [y, mo, d] = datePart.split("-").map(Number);
		const time = timePart ? parseTimeOfDay(timePart) : null;
		return toBrisbaneISO(
			{ year: y, month: mo - 1, day: d },
			time,
			referenceDate,
		);
	}

	const cal = tryParseCalendarDate(trimmed);
	if (!cal) return null;
	const time = parseTimeOfDay(trimmed.replace(/^.*\d{4}\b/, "").trim());
	return toBrisbaneISO(cal, time, referenceDate);
}

const RANGE_SEPARATOR = /\s*(?:–|—|-|to)\s*/i;

/**
 * Parses a date range appearing in one string, e.g. "5 – 19 September
 * 2026", "Tue 21 – Sun 26 Jul", or an open-ended "until 3 August 2026"
 * (start left null on purpose — the run's actual start is unknown).
 */
export function parseDateRange(
	raw: string,
	referenceDate: Date = new Date(),
): ParsedDateRange {
	const trimmed = raw.trim();
	if (!trimmed) return { startISO: null, endISO: null };

	const untilMatch = /^until\s+(.+)$/i.exec(trimmed);
	if (untilMatch) {
		return {
			startISO: null,
			endISO: parseSingleDateTime(untilMatch[1], referenceDate),
		};
	}

	const parts = trimmed.split(RANGE_SEPARATOR);
	if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
		const endISO = parseSingleDateTime(parts[1], referenceDate);
		// The left side is often just a day number ("5") borrowing month/year
		// from the right side ("19 September 2026") — try that before giving up.
		let startISO = parseSingleDateTime(parts[0], referenceDate);
		if (!startISO && endISO) {
			const dayOnly = /^\d{1,2}$/.exec(parts[0].trim());
			const rightCal = tryParseCalendarDate(parts[1]);
			if (dayOnly && rightCal) {
				startISO = toBrisbaneISO(
					{
						day: Number(dayOnly[0]),
						month: rightCal.month,
						year: rightCal.year,
					},
					null,
					referenceDate,
				);
			}
		}
		if (startISO || endISO) return { startISO, endISO };
	}

	const single = parseSingleDateTime(trimmed, referenceDate);
	return { startISO: single, endISO: null };
}
