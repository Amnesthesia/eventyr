// Turns CandidateEvents (ladder output, all-nullable, our own parsed dates)
// into the 16-key event shape the pipeline consumes — the same shape the
// AI-search path's enrich pass emits, so curate/rank/geocode/markdown/ical/rss
// can't tell the two provenances apart.
//
// Split deliberately: every factual field is mapped deterministically here,
// and only the genuinely editorial fields (category, tags, vibe booleans) go
// to an LLM afterwards (the pipeline's annotate.ts). Dates in particular are
// never re-derived by a model — dates.ts already resolved them, and re-asking
// would reintroduce exactly the guessing the scraper exists to avoid.
//
// The publishing window (withinWindow/isPast) is the pipeline's: the scraper
// has no idea which week is being published.

import type { EventData } from "@dothingslol/core/schema";
import { zonedOffsetMinutes } from "@dothingslol/utils/tz";
import type { CandidateEvent, ScrapeSource } from "./types.ts";

/**
 * Converts an instant into the naive wall-clock string, in the city's zone, that
 * the pipeline stores (`YYYY-MM-DDTHH:MM:SS`, or `YYYY-MM-DD` when no time was
 * on the page).
 *
 * Must not be done by slicing the offset off the string: an explicit offset or
 * `Z` on the input need not be the city's (a feed in UTC, a DST city's summer
 * +11:00 against a winter reference), and slicing would keep the wrong wall
 * clock. The offset used is the zone's at that instant, so a DST city's
 * summer events come out in summer time.
 *
 * The output format is load-bearing: ical.ts's parseDt accepts ONLY
 * `YYYY-MM-DDTHH:MM[:SS]` or `YYYY-MM-DD`, and silently drops the event from
 * the feed for anything else.
 */
export function zonedNaive(
	iso: string | null,
	timeZone: string,
): string | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	const offset = zonedOffsetMinutes(timeZone, new Date(t));
	const s = new Date(t + offset * 60_000).toISOString().slice(0, 19);
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
 * and rendered on the site, so it should not depend on the runtime's ICU.
 *
 * "Tue 8 Sep, 7:00 PM", or "Sat 2 May – Sat 5 Dec" when the end falls on a
 * later day. The range matters: a season pass or exhibition whose card said
 * only "Sat 2 May" read as a stale event in September, when it was still on
 * and the end date was sitting right there in datetime_end_iso. */
export function humanDatetime(
	naive: string | null,
	endNaive: string | null = null,
): string {
	if (!naive) return "";
	const dateOnly = naive.length === 10;
	// Parsed as UTC and read back in UTC so the wall-clock value passes
	// through untouched regardless of the machine's own timezone.
	const d = new Date(`${naive}${dateOnly ? "T00:00:00" : ""}Z`);
	if (Number.isNaN(d.getTime())) return "";
	const day = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
	const h24 = d.getUTCHours();
	const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
	const mins = String(d.getUTCMinutes()).padStart(2, "0");
	// Kept separate from `day` so the multi-day branch can carry it too: a run
	// that starts at a known time used to render as a bare date range, silently
	// discarding a time we had. "Fri 4 Sep, 10:00 AM – Sat 26 Sep".
	const time = dateOnly ? "" : `, ${h12}:${mins} ${h24 < 12 ? "AM" : "PM"}`;
	if (endNaive && endNaive.slice(0, 10) > naive.slice(0, 10)) {
		const e = new Date(`${endNaive.slice(0, 10)}T00:00:00Z`);
		if (!Number.isNaN(e.getTime())) {
			// A run that crosses a new year gets the year on BOTH ends, never only
			// the end. Twenty of Brisbane's long exhibitions opened in 2023–2025,
			// and "Wed 20 Sep, 10:00 AM – Tue 26 Jan 2027" reads as opening this
			// September when it opened three years ago.
			const spansYears = e.getUTCFullYear() !== d.getUTCFullYear();
			const startYear = spansYears ? ` ${d.getUTCFullYear()}` : "";
			const endYear = spansYears ? ` ${e.getUTCFullYear()}` : "";
			return `${day}${startYear}${time} – ${DAYS[e.getUTCDay()]} ${e.getUTCDate()} ${MONTHS_SHORT[e.getUTCMonth()]}${endYear}`;
		}
	}
	return `${day}${time}`;
}

function composeLocation(
	c: CandidateEvent,
	source: ScrapeSource | undefined,
): string {
	const venue = c.venueName ?? source?.venue?.name ?? "";
	const detail =
		c.address ?? source?.venue?.address ?? source?.venue?.suburb ?? "";
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

/**
 * What the scraper can fill of an EventData. `venue` (the tier's display
 * name) and `score` are the pipeline's, as are the real category, tags and
 * vibes: the placeholders below are what every scraped event carried before
 * annotation, kept so the per-source files keep their exact shape.
 */
export type ScrapedEvent = Pick<
	EventData,
	| "title"
	| "datetime"
	| "datetime_iso"
	| "datetime_end_iso"
	| "location"
	| "link"
	| "cost"
	| "source"
	| "description"
	| "image"
	| "category"
	| "tags"
	| "social"
	| "intellectual"
	| "hands_on"
	| "creative"
>;

/**
 * The deterministic half: every field we can know for certain from the page.
 * category/tags/vibe booleans are filled in afterwards by the pipeline.
 * `linkRewriter` is the pipeline's hook for links a source publishes in a
 * form that does not land on the event (councilEventUrl in the pipeline).
 */
export function candidateToEvent(
	c: CandidateEvent,
	source: ScrapeSource | undefined,
	timeZone: string,
	linkRewriter?: (url: string | null) => string | null,
): ScrapedEvent {
	const datetimeIso = zonedNaive(c.startISO, timeZone);
	const datetimeEndIso = zonedNaive(c.endISO, timeZone);
	const link = linkRewriter ? linkRewriter(c.url) : c.url;
	return {
		title: c.title ?? "",
		datetime: humanDatetime(datetimeIso, datetimeEndIso),
		datetime_iso: datetimeIso ?? "",
		datetime_end_iso: datetimeEndIso ?? "",
		location: composeLocation(c, source),
		// Same scheme guard as image: a scraped url goes straight into an <a
		// href> on the site, and new URL() happily parses "javascript:alert(1)".
		link: httpUrlOrEmpty(link) || httpUrlOrEmpty(source?.homepage),
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
