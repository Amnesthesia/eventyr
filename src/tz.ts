// Time-zone arithmetic, built on Intl so DST comes from the platform's tz
// database rather than from a constant. A city's zone is stated once, as
// `timezone:` in sources/{city}.yml; every offset is derived from it here, per
// instant. Nothing in this file reads the host's TZ.
//
// Browser-safe (no node: imports): shared.ts, which the site bundles, uses it.

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One cached formatter per zone: constructing Intl.DateTimeFormat is the
 * expensive part, and dates.ts asks for offsets once per parsed candidate. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, f);
	}
	return f;
}

/** The wall clock in `timeZone` at `at`, encoded as UTC milliseconds. */
function wallClock(timeZone: string, at: Date): number {
	const p: Record<string, number> = {};
	for (const part of formatterFor(timeZone).formatToParts(at)) {
		if (part.type !== "literal") p[part.type] = Number(part.value);
	}
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function pad(n: number, len = 2): string {
	return String(n).padStart(len, "0");
}

/** UTC offset of `timeZone` at the instant `at`, in minutes (Brisbane: 600). */
export function zonedOffsetMinutes(timeZone: string, at: Date): number {
	// Intl reports whole seconds, so compare against the instant without its ms.
	const whole = Math.floor(at.getTime() / 1000) * 1000;
	return Math.round((wallClock(timeZone, at) - whole) / 60_000);
}

/** The calendar date (YYYY-MM-DD) in `timeZone` at the instant `at`. */
export function zonedDate(timeZone: string, at: Date): string {
	const d = new Date(wallClock(timeZone, at));
	return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * The instant at which the wall clock in `timeZone` reads `wall` (a wall-clock
 * reading encoded as UTC ms, i.e. `Date.UTC(y, m, d, h, min)`).
 *
 * - A reading that never happens (the skipped hour when DST starts, 02:00–02:59
 *   on 2026-10-04 in Sydney) returns null. Any instant we picked would be a
 *   guess at what the source meant.
 * - A reading that happens twice (the repeated hour when DST ends, 02:00–02:59
 *   on 2027-04-04 in Sydney) returns the FIRST occurrence, still on daylight
 *   time. It is the reading a clock shows first, and taking the earlier
 *   instant means a calendar entry or reminder built from it can be an hour
 *   early but never an hour late.
 *
 * Tries the offsets in force a day either side of the reading: a zone never
 * changes offset twice within two days, so those are the only candidates.
 */
export function zonedTimeToInstant(
	timeZone: string,
	wall: number,
): Date | null {
	const offsets = new Set([
		zonedOffsetMinutes(timeZone, new Date(wall - 86_400_000)),
		zonedOffsetMinutes(timeZone, new Date(wall + 86_400_000)),
	]);
	const valid = [...offsets]
		.map((offset) => wall - offset * 60_000)
		// wallClock reads whole seconds, so compare against the reading without ms.
		.filter((t) => wallClock(timeZone, new Date(t)) === wall - (wall % 1000))
		.sort((a, b) => a - b);
	return valid.length > 0 ? new Date(valid[0]) : null;
}

/** The instant a calendar day (YYYY-MM-DD) starts in `timeZone`. */
export function zonedMidnight(timeZone: string, isoDate: string): Date {
	const wall = Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);
	// ponytail: a zone whose DST starts AT midnight (none in Australia) has no
	// 00:00 that day; its day starts at 01:00.
	return (
		zonedTimeToInstant(timeZone, wall) ??
		(zonedTimeToInstant(timeZone, wall + 3_600_000) as Date)
	);
}

/** 600 → "+10:00", -420 → "-07:00". */
export function formatOffset(minutes: number): string {
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Shifts a YYYY-MM-DD string by whole days. Calendar arithmetic, done in UTC
 * so neither a zone nor the host's DST can move the result. */
export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}
