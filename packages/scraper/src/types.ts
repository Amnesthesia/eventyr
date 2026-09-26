// Shared types for the scrape path: fetch and parse known event sources
// deterministically; the LLM rung is injected by the caller (llmExtract.ts in
// the pipeline) and only ever sees already-fetched page text.

/**
 * How a source's listing pages are fetched.
 *
 * "render" means the page is fetched through a real browser (render.ts) because
 * its events only exist after JavaScript runs and probe could verify no static
 * URL for it. It is the narrowest and most expensive path, so probe only
 * assigns it when a render actually produced dated events — never speculatively.
 */
export type SourceStrategy = "jsonld" | "html" | "render";

/**
 * Which path actually produced an event, recorded on its provenance. "api" is
 * the embedded hydration JSON path (embeddedJson.ts) and "feed" is a site's
 * own event API (feeds.ts — The Events Calendar, Modern Events Calendar,
 * Squarespace); neither has a matching fetch strategy, because both are
 * recognised from the body of something fetched as "html".
 *
 * "ics" and "rss" used to be in this union with no implementation behind
 * them anywhere, so a source declaring one silently ran the HTML path. Every
 * value here must stay backed by a real branch in the ladder (ladder.ts).
 */
export type ExtractionStrategy = SourceStrategy | "api" | "feed";

export interface VenueRecord {
	/** Null when the source has no single venue (an aggregator, a council
	 * calendar) — its events then carry only the venue the page names. */
	name: string | null;
	address: string | null;
	suburb: string | null;
}

/**
 * What the scraper needs to know about the source a page belongs to. The
 * pipeline's SourceDefinition (registry.ts) satisfies this structurally; the
 * scraper never sees listingUrls, domains or the city — those come in through
 * ScrapeOptions and the URL itself.
 */
export interface ScrapeSource {
	id: string;
	name: string;
	/** Fallback link for an event whose page named none. */
	homepage?: string | null;
	/** Fills in the venue for an event whose card named none. */
	venue?: VenueRecord;
	/** The city config's tier for this source, carried through untouched. */
	tier?: string;
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
	strategy: SourceStrategy;
}

/**
 * Pre-normalisation event shape. Every factual field is nullable.
 * Adapters never guess: if a field is not on the page, it is null — never
 * inferred, defaulted, or filled from another field (e.g. from the title).
 */
export interface CandidateEvent {
	title: string | null;
	description: string | null;
	/** ISO 8601 in the city's zone, with the offset in force at that instant (dates.ts), or null if not confidently parsed. */
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

/**
 * Minimal shape ladder.ts depends on — satisfied by the real
 * SourceFetcher (fetch.ts) but small enough to stub directly in tests
 * without mocking robots.txt/network behaviour.
 */
export interface Fetcher {
	fetch(
		sourceId: string,
		url: string,
		strategy: SourceStrategy,
	): Promise<RawListing>;
}
