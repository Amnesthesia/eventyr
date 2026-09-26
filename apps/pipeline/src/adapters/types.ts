// The pipeline's view of a scraper source: a sources/{city}.yml entry with
// method: scraper, as loaded by registry.ts. Structurally a ScrapeSource plus
// the listing URLs, strategy and zone that scrape() takes as options, so a
// SourceDefinition is passed straight through as `source`.

import type { SourceDefinition } from "@dothingslol/core/sources";
import type { SourceStrategy, VenueRecord } from "@dothingslol/scraper";

export type { SourceDefinition };
