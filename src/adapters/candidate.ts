import { parseDateRange, parseSingleDateTime } from "./dates.ts";
import type {
	CandidateEvent,
	ExtractionStrategy,
	FetchProvenance,
	RawCandidateFields,
	RawListing,
	SourceDefinition,
} from "./types.ts";

/**
 * Resolves startRaw/endRaw text into Brisbane-instant ISO dates. Always our
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
): { startISO: string | null; endISO: string | null } {
	if (startRaw && !endRaw) {
		const range = parseDateRange(startRaw, referenceDate);
		if (range.endISO) return range;
		return {
			startISO: parseSingleDateTime(startRaw, referenceDate),
			endISO: null,
		};
	}
	return {
		startISO: startRaw ? parseSingleDateTime(startRaw, referenceDate) : null,
		endISO: endRaw ? parseSingleDateTime(endRaw, referenceDate) : null,
	};
}

export function provenanceFor(
	source: SourceDefinition,
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
	referenceDate: Date = new Date(),
): CandidateEvent {
	const { startISO, endISO } = resolveDates(
		fields.startRaw,
		fields.endRaw,
		referenceDate,
	);
	return { ...fields, startISO, endISO, provenance };
}
