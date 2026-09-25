// @dothingslol/scraper — the deterministic scrape path (PLAN §2.5): fetching
// with rate limits and conditional GET, the extraction ladder (site feed →
// JSON-LD → hydration JSON → an injected fallback), date parsing, and the
// CandidateEvent → event mapping. No LLM code and no knowledge of data/,
// cities or sources/*.yml: everything comes in through options.

export { provenanceFor, toCandidateEvent } from "./candidate.ts";
export {
	type EnrichStats,
	enrichFromDetailPage,
	findDescription,
	MIN_DESCRIPTION_CHARS,
} from "./enrich.ts";
export {
	blockedReason,
	createFetcher,
	createTempStore,
	type HttpCacheEntry,
	type HttpCacheStore,
	isPermanentFailure,
	SourceFetcher,
} from "./fetch.ts";
export { BlockedError, extractListing, type LadderOutcome } from "./ladder.ts";
export {
	candidateToEvent,
	humanDatetime,
	type ScrapedEvent,
	zonedNaive,
} from "./normalise.ts";
export { type ScrapeOptions, type ScrapeResult, scrape } from "./scrape.ts";
export type * from "./types.ts";
