// Turns CandidateEvents (adapter output, all-nullable, our own parsed dates)
// into the 16-key event shape the rest of the pipeline consumes — the same
// shape the AI-search path's enrich pass emits, so curate/rank/geocode/
// markdown/ical/rss can't tell the two provenances apart.
//
// Split deliberately: every factual field is mapped deterministically here,
// and only the genuinely editorial fields (category, tags, vibe booleans) go
// to an LLM (annotate.ts). Dates in particular are never re-derived by a
// model — dates.ts already resolved them, and re-asking would reintroduce
// exactly the guessing the adapter framework exists to avoid.

import { CATEGORIES, type Category } from "../common.ts";
import { BRISBANE_UTC_OFFSET_HOURS } from "./dates.ts";
import type { CandidateEvent, SourceDefinition } from "./types.ts";

const OFFSET_MS = BRISBANE_UTC_OFFSET_HOURS * 3_600_000;

/**
 * Converts an instant into the naive Brisbane wall-clock string the pipeline
 * uses (`YYYY-MM-DDTHH:MM:SS`, or `YYYY-MM-DD` when no time was on the page).
 *
 * Must not be done by slicing the offset off the string: startISO arrives in
 * two shapes — `2026-10-05T19:00:00+10:00` from the textual/slash/range
 * parsers, but `2026-10-04T23:00:00.000Z` from the ISO-passthrough path
 * (dates.ts trusts an explicit offset and normalises to UTC). Slicing would
 * silently shift the UTC ones by 10 hours.
 *
 * The output format is load-bearing: ical.ts's parseDt accepts ONLY
 * `YYYY-MM-DDTHH:MM[:SS]` or `YYYY-MM-DD`, and silently drops the event from
 * the feed for anything else.
 */
export function brisbaneNaive(iso: string | null): string | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	const s = new Date(t + OFFSET_MS).toISOString().slice(0, 19);
	// dates.ts uses midnight as its "no time given on the page" value, and a
	// date-only string makes ical.ts emit a proper all-day event instead of a
	// bogus 00:00 timed one.
	// ponytail: a real 00:00 start is indistinguishable here; the fix is a
	// hasTime flag on CandidateEvent, not worth it until a source needs it.
	return s.endsWith("T00:00:00") ? s.slice(0, 10) : s;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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

/** Human-readable datetime, formatted from the resolved instant rather than
 * copied from startRaw — page text is wildly inconsistent ("5 – 19 September",
 * "Every Tues") and sometimes disagrees with the date we actually resolved.
 * Built by hand rather than via toLocaleString: ICU output differs between
 * Node builds ("Sep" vs "Sept"), and this string is committed to data files
 * and rendered on the site, so it should not depend on the runtime's ICU. */
export function humanDatetime(naive: string | null): string {
	if (!naive) return "";
	const dateOnly = naive.length === 10;
	// Parsed as UTC and read back in UTC so the wall-clock value passes
	// through untouched regardless of the machine's own timezone.
	const d = new Date(`${naive}${dateOnly ? "T00:00:00" : ""}Z`);
	if (Number.isNaN(d.getTime())) return "";
	const day = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
	if (dateOnly) return day;
	const h24 = d.getUTCHours();
	const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
	const mins = String(d.getUTCMinutes()).padStart(2, "0");
	return `${day}, ${h12}:${mins} ${h24 < 12 ? "AM" : "PM"}`;
}

/**
 * Keeps events overlapping the publishing window, which runs from TODAY (not
 * the Monday — a Wednesday run must not resurrect Monday's finished events)
 * through the end of next week. Showing next week's events early is harmless;
 * showing last night's is not.
 *
 * Interval overlap rather than start-only, so a multi-day exhibition that
 * opened last month and runs through next week still surfaces — but a one-off
 * that has already happened does not.
 */
export function withinWindow(
	startNaive: string | null,
	endNaive: string | null,
	from: string,
	to: string,
): boolean {
	if (!startNaive) return false;
	const start = startNaive.slice(0, 10);
	const end = (endNaive ?? startNaive).slice(0, 10);
	return start <= to && end >= from;
}

/** Whether an event has already finished, which is the signal that a listing
 * URL points at an archive rather than a programme. */
export function isPast(
	startNaive: string | null,
	endNaive: string | null,
	from: string,
): boolean {
	if (!startNaive) return false;
	return (endNaive ?? startNaive).slice(0, 10) < from;
}

function composeLocation(
	c: CandidateEvent,
	source: SourceDefinition | undefined,
): string {
	const venue = c.venueName ?? source?.venue.name ?? "";
	const detail =
		c.address ?? source?.venue.address ?? source?.venue.suburb ?? "";
	if (!venue) return detail;
	if (!detail || venue.toLowerCase().includes(detail.toLowerCase())) {
		return venue;
	}
	return `${venue}, ${detail}`;
}

/** Only http(s) URLs survive: anything else is rendered as a link on the site
 * and a javascript:/data: href would be click-to-execute. */
function httpUrlOrEmpty(url: string | null | undefined): string {
	return url && /^https?:\/\//i.test(url) ? url : "";
}

export function isValidCategory(v: unknown): v is Category {
	return CATEGORIES.includes(v as Category);
}

/**
 * The deterministic half: every field we can know for certain from the page.
 * category/tags/vibe booleans are filled in afterwards by annotate.ts.
 */
export function candidateToEvent(
	c: CandidateEvent,
	source: SourceDefinition | undefined,
): Record<string, unknown> {
	const datetimeIso = brisbaneNaive(c.startISO);
	return {
		title: c.title ?? "",
		datetime: humanDatetime(datetimeIso),
		datetime_iso: datetimeIso ?? "",
		datetime_end_iso: brisbaneNaive(c.endISO) ?? "",
		location: composeLocation(c, source),
		// Same scheme guard as image: a scraped url goes straight into an <a
		// href> on the site, and new URL() happily parses "javascript:alert(1)".
		link: httpUrlOrEmpty(c.url) || httpUrlOrEmpty(source?.homepage),
		// markdown.ts calls .toLowerCase() on cost, so it must always be a
		// string; "See link" is markdown's own fallback wording.
		cost: c.price ?? "See link",
		source: source?.name ?? c.provenance.sourceId,
		description: c.description ?? "",
		image: httpUrlOrEmpty(c.imageUrl),
		category: "Community / Other",
		tags: [] as string[],
		social: false,
		intellectual: false,
		hands_on: false,
		creative: false,
	};
}

export interface PreparedCandidate {
	event: Record<string, unknown>;
	candidate: CandidateEvent;
}

export interface PrepareStats {
	total: number;
	noTitle: number;
	noDate: number;
	/** Already finished. Non-zero means the listing URL is probably an archive. */
	past: number;
	/** Upcoming, but beyond the window — normal for a venue listing its season. */
	later: number;
	kept: number;
}

/**
 * Deterministic pre-pass: drop what can't be used, week-filter, map fields.
 *
 * Dropping null-date candidates is not just tidiness — common.ts's
 * fingerprintEvent yields date:"" for them and isDuplicateEvent only bails
 * early when BOTH dates are present and differ, so a dateless event matches
 * any similarly-titled event on any date and would swallow real ones during
 * the merge.
 */
export interface Rejection {
	reason: "no title" | "no date" | "past" | "later";
	title: string | null;
	startRaw: string | null;
	startISO: string | null;
	url: string | null;
}

export function prepareCandidates(
	candidates: CandidateEvent[],
	source: SourceDefinition | undefined,
	from: string,
	to: string,
): {
	prepared: PreparedCandidate[];
	stats: PrepareStats;
	rejected: Rejection[];
} {
	const stats: PrepareStats = {
		total: candidates.length,
		noTitle: 0,
		noDate: 0,
		past: 0,
		later: 0,
		kept: 0,
	};
	const prepared: PreparedCandidate[] = [];
	// Kept so a bad yield is diagnosable from a file instead of re-running the
	// extraction: the reason 391 candidates were lost to "no date" took offline
	// forensics precisely because these were thrown away.
	const rejected: Rejection[] = [];
	const reject = (
		reason: Rejection["reason"],
		c: CandidateEvent,
		startISO: string | null,
	): void => {
		rejected.push({
			reason,
			title: c.title,
			startRaw: c.startRaw,
			startISO,
			url: c.url,
		});
	};

	for (const c of candidates) {
		if (!c.title?.trim()) {
			stats.noTitle++;
			reject("no title", c, null);
			continue;
		}
		const event = candidateToEvent(c, source);
		const startNaive = (event.datetime_iso as string) || null;
		if (!startNaive) {
			stats.noDate++;
			reject("no date", c, null);
			continue;
		}
		const endNaive = (event.datetime_end_iso as string) || null;
		if (isPast(startNaive, endNaive, from)) {
			stats.past++;
			reject("past", c, startNaive);
			continue;
		}
		if (!withinWindow(startNaive, endNaive, from, to)) {
			stats.later++;
			reject("later", c, startNaive);
			continue;
		}
		prepared.push({ event, candidate: c });
	}
	stats.kept = prepared.length;
	return { prepared, stats, rejected };
}
