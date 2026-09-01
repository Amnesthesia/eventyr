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
	/**
	 * Which sources/{city}.yml tier this source was moved out of. Carried
	 * forward so scraped output can be written under the same tier name the
	 * AI-search path uses, which is what lets curate.ts's TIER_TO_VENUE map
	 * classify adapter events with no special-casing.
	 */
	sourceTier: "aggregators" | "institutions" | "independents";
	/** Fetch cadence, e.g. "daily" | "weekly". */
	schedule: "daily" | "weekly";
	/**
	 * Any caveat about how this entry was populated — e.g. which probe run
	 * verified its listing URL, or a known quirk of the source.
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

/**
 * The raw, pre-date-parsing fields any extraction method (deterministic
 * JSON-LD mapping, or LLM extraction over reduced page text) produces.
 * Shared shape so both paths feed the same conversion into CandidateEvent
 * (see candidate.ts) — dates are always resolved by our own parser, never
 * trusted from the extractor itself.
 */
export interface RawCandidateFields {
	title: string | null;
	description: string | null;
	/** Date/time exactly as it appears on the page — never computed. */
	startRaw: string | null;
	endRaw: string | null;
	venueName: string | null;
	address: string | null;
	url: string | null;
	price: string | null;
	imageUrl: string | null;
	organiser: string | null;
	category: string | null;
	sourceEventId: string | null;
}

/**
 * Extracts CandidateEvent-shaped fields from already-fetched page text.
 * Implementations must never fetch or search anything themselves — the
 * page content is provided; the job is purely turning it into structured
 * fields, copying values verbatim and returning null for anything not
 * actually present. Used as the "html" strategy's extraction mechanism
 * when a page publishes no JSON-LD/structured endpoint (see llmExtract.ts).
 */
export type PageExtractFn = (
	pageText: string,
	sourceName: string,
) => Promise<RawCandidateFields[]>;

export interface EventSourceAdapter {
	id: string;
	discover(): Promise<RawListing[]>;
	extract(raw: RawListing): Promise<CandidateEvent[]>;
}

/**
 * Minimal shape pageAdapter.ts depends on — satisfied by the real
 * SourceFetcher (fetch.ts) but small enough to stub directly in tests
 * without mocking robots.txt/network behaviour.
 */
export interface Fetcher {
	fetch(
		sourceId: string,
		url: string,
		strategy: ExtractionStrategy,
	): Promise<RawListing>;
}

export interface SourceRunResult {
	sourceId: string;
	ok: boolean;
	listingsFetched: number;
	candidatesExtracted: number;
	errors: string[];
}
