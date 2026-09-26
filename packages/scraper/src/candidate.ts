import { parseDateRange, parseSingleDateTime } from "./parsers/dates.ts";
import type {
	CandidateEvent,
	ExtractionStrategy,
	FetchProvenance,
	RawCandidateFields,
	RawListing,
	ScrapeSource,
} from "./types.ts";

/**
 * Resolves startRaw/endRaw text into ISO dates in the city's zone. Always our
 * own deterministic parser — never the extractor's own computation, JSON-LD
 * or LLM alike, per "adapters never guess" (see dates.ts for the policy).
 * A single startRaw field sometimes holds a full range as text (common in
 * HTML-extracted "5 – 19 September" style listings, vs. JSON-LD's separate
 * startDate/endDate) — parseDateRange handles both without special-casing
 * the caller.
 */
function resolveDates(
	startRaw: string | null,
	endRaw: string | null,
	referenceDate: Date,
	timeZone: string,
): { startISO: string | null; endISO: string | null } {
	if (startRaw && !endRaw) {
		const range = parseDateRange(startRaw, referenceDate, timeZone);
		if (range.endISO) return range;
		return {
			startISO: parseSingleDateTime(startRaw, referenceDate, timeZone),
			endISO: null,
		};
	}
	return {
		startISO: startRaw
			? parseSingleDateTime(startRaw, referenceDate, timeZone)
			: null,
		endISO: endRaw
			? parseSingleDateTime(endRaw, referenceDate, timeZone)
			: null,
	};
}

export function provenanceFor(
	source: Pick<ScrapeSource, "id">,
	raw: RawListing,
	strategy: ExtractionStrategy,
): FetchProvenance {
	return {
		sourceId: source.id,
		sourceUrl: raw.url,
		fetchedAt: raw.fetchedAt,
		strategy,
	};
}

export function toCandidateEvent(
	fields: RawCandidateFields,
	provenance: FetchProvenance,
	referenceDate: Date,
	/** The city's IANA zone (the city config's `timezone`). */
	timeZone: string,
): CandidateEvent {
	const { startISO, endISO } = resolveDates(
		fields.startRaw,
		fields.endRaw,
		referenceDate,
		timeZone,
	);
	return { ...fields, startISO, endISO, provenance };
}
