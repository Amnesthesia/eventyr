// Shared types for the first-party site adapter framework (see prompt.md
// "Refactor: replace LLM tool-use fetching with first-party site adapters").
// Adapters fetch and parse known event sources deterministically; the LLM is
// only used downstream (Phase 4) as a normaliser over already-extracted data.

export const EXTRACTION_STRATEGIES = [
	"jsonld",
	"api",
	"html",
	"ics",
	"rss",
] as const;

export type ExtractionStrategy = (typeof EXTRACTION_STRATEGIES)[number];

export interface VenueRecord {
	name: string;
	address: string | null;
	suburb: string | null;
	lat: number | null;
	lng: number | null;
	aliases: string[];
}

export interface SourceDefinition {
	id: string;
	name: string;
	/** Null for a candidate whose homepage was never located/confirmed. */
	homepage: string | null;
	/** URLs to fetch for listings. Empty for unverified candidates. */
	listingUrls: string[];
	/**
	 * All hostnames this source owns — including aliases, redirect targets,
	 * and ticketing subdomains/delegates it sells through. Load-bearing for
	 * Phase 5 legacy-path suppression: matched after redirect-following and
	 * URL canonicalisation, never by exact URL string.
	 */
	domains: string[];
	venue: VenueRecord;
	strategy: ExtractionStrategy;
	enabled: boolean;
	/** Fetch cadence, e.g. "daily" | "weekly". */
	schedule: "daily" | "weekly";
	/**
	 * Why this entry is disabled, unverified, or otherwise not ready for an
	 * adapter — or any other caveat about how this entry was populated.
	 * Required whenever enabled is false, or the id/domains were guessed.
	 */
	note?: string;
}

/** Provenance of one fetch, attached to everything derived from it. */
export interface FetchProvenance {
	sourceId: string;
	sourceUrl: string;
	fetchedAt: string;
	strategy: ExtractionStrategy;
}

/** One fetched listing page (or structured endpoint response). */
export interface RawListing {
	url: string;
	fetchedAt: string;
	status: number;
	/** True if this was a 304 Not Modified — caller should skip re-parsing. */
	notModified: boolean;
	contentType: string | null;
	/** Path to the persisted raw response body on disk, or null on hard failure. */
	bodyPath: string | null;
	strategy: ExtractionStrategy;
}

/**
 * Pre-normalisation event shape. Every factual field is nullable.
 * Adapters never guess: if a field is not on the page, it is null — never
 * inferred, defaulted, or filled from another field (e.g. from the title).
 */
export interface CandidateEvent {
	title: string | null;
	description: string | null;
	/** Brisbane-instant ISO 8601 (UTC+10, no DST), or null if not confidently parsed. */
	startISO: string | null;
	/** Original date/time string exactly as found on the page. */
	startRaw: string | null;
	endISO: string | null;
	endRaw: string | null;
	venueName: string | null;
	address: string | null;
	url: string | null;
	price: string | null;
	imageUrl: string | null;
	organiser: string | null;
	/** Free-text category/genre as found on the source — mapping to the fixed
	 * CATEGORIES enum is a Phase 4 normalisation job, not an adapter job. */
	category: string | null;
	/** Stable upstream id (e.g. JSON-LD @id, WP post id) if the source exposes one. */
	sourceEventId: string | null;
	provenance: FetchProvenance;
}

export interface EventSourceAdapter {
	id: string;
	discover(): Promise<RawListing[]>;
	extract(raw: RawListing): Promise<CandidateEvent[]>;
}

export interface SourceRunResult {
	sourceId: string;
	ok: boolean;
	listingsFetched: number;
	candidatesExtracted: number;
	errors: string[];
}
