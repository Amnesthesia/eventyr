// The pipeline's view of a scraper source: a sources/{city}.yml entry with
// method: scraper, as loaded by registry.ts. Structurally a ScrapeSource plus
// the listing URLs, strategy and zone that scrape() takes as options, so a
// SourceDefinition is passed straight through as `source`.

import type { SourceStrategy, VenueRecord } from "@dothingslol/scraper";

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
	strategy: SourceStrategy;
	/**
	 * Which sources/{city}.yml tier this source was moved out of. Carried
	 * forward so scraped output can be written under the same tier name the
	 * AI-search path uses, which is what lets curate.ts's TIER_TO_VENUE map
	 * classify adapter events with no special-casing.
	 */
	sourceTier: "aggregators" | "institutions" | "independents";
	/**
	 * The city's IANA zone, copied from sources/{city}.yml `timezone` by the
	 * registry. Page text states wall-clock times, and which instant those name
	 * depends on the city, and for a DST city on the date.
	 */
	timeZone: string;
	/**
	 * Any caveat about how this entry was populated — e.g. which probe run
	 * verified its listing URL, or a known quirk of the source.
	 */
	note?: string;
}
