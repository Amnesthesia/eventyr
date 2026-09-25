// Single source of truth lives in src/shared.ts, which the pipeline's /ai
// feed builder (src/ai.ts) also reads — a second copy here is exactly how the
// site and that feed would end up disagreeing about which day an event
// belongs to. Imported from shared.ts, not common.ts: common.ts reads the
// filesystem and cannot be bundled for the browser.
import { eventOverlapsRange, parseEndDate } from "@dothingslol/core/shared";

export { eventOverlapsRange, parseEndDate };

function localDateStr(offset: number): string {
	const d = new Date();
	return new Date(
		d.getFullYear(),
		d.getMonth(),
		d.getDate() + offset,
	).toLocaleDateString("sv");
}

/** Shifts a YYYY-MM-DD string by whole days. Built on local Date arithmetic
 * rather than string maths so month and year ends are the platform's problem. */
export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	d.setDate(d.getDate() + days);
	return d.toLocaleDateString("sv");
}

/** Last day of the month containing `iso`, as YYYY-MM-DD. */
export function endOfMonth(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	// Day 0 of the next month is the last day of this one.
	return new Date(d.getFullYear(), d.getMonth() + 1, 0).toLocaleDateString(
		"sv",
	);
}

/** Monday of the week containing `iso`, as YYYY-MM-DD. */
export function startOfWeek(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	// getDay: Sunday is 0, so Sunday belongs to the week that started six days ago.
	return addDays(iso, -((d.getDay() + 6) % 7));
}

export function todayIso(): string {
	return localDateStr(0);
}
export function tomorrowIso(): string {
	return localDateStr(1);
}

/**
 * The coming weekend, as an inclusive range.
 *
 * Same rule as the build-time /this-weekend/ page (src/pages/[city]/[timeframe].astro):
 * Saturday and Sunday of the week we are in, except on Sunday itself, when the
 * Saturday just gone is over and the weekend is today alone.
 */
export function weekendRange(iso: string): { start: string; end: string } {
	const dow = new Date(`${iso}T00:00:00`).getDay(); // 0=Sun..6=Sat
	if (dow === 0) return { start: iso, end: iso };
	const sat = dow === 6 ? iso : addDays(iso, 6 - dow);
	return { start: sat, end: addDays(sat, 1) };
}

export function fmtRange(a: string, b: string): string {
	const fmt = (d: string) =>
		new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", {
			day: "numeric",
			month: "short",
		});
	return `${fmt(a)} – ${fmt(b)}`;
}

const MONTHS_SHORT = [
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

/** "5 Dec", with the year only when it is not the one in `iso`'s sibling.
 * Hand-built for the same reason normalise.ts's humanDatetime is: ICU output
 * differs between Node builds ("Sep" vs "Sept"), and this sits next to strings
 * that formatter produced. */
export function shortDate(iso: string): string {
	const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/**
 * What a card should print for an event's date.
 *
 * Usually the pipeline's own `datetime` string. The exception is a run that
 * has already opened and has not closed — an exhibition, a season, a weekly
 * workshop. Those are dated from their START, which for the long ones is 2023,
 * and a saved-events list full of "Sat 29 Aug, 10:30 AM" reads as a list of
 * things already missed. It is the single most common way this site has been
 * misread.
 *
 * `today` is the viewer's own date (context's todayStr), not the build's, so
 * this cannot go stale between the weekly digest and the day it is read. An
 * empty `today` — the pre-hydration render — returns the plain string, so the
 * server and the first client render agree.
 */
export function displayDatetime(
	event: {
		datetime?: string;
		datetime_iso?: string;
		datetime_end_iso?: string;
	},
	today: string,
): string {
	const fallback = event.datetime || "";
	if (!today) return fallback;
	const start = (event.datetime_iso || "").slice(0, 10);
	const end = (event.datetime_end_iso || "").slice(0, 10);
	// Both bounds are required: without an end this is a one-off that started
	// today at the earliest, and "on now" would be a claim we cannot make.
	if (!start || !end || start >= today || end < today) return fallback;
	return `On now — until ${shortDate(end)}`;
}
