// Manual check for the scrape path: point it at any URL and see exactly what
// that page would contribute to the pipeline — the same fetch (robots.txt,
// rate limit), the same JSON-LD-then-LLM extraction, the same date parsing,
// week filter, field mapping and annotation that `pnpm collect-adapters`
// applies to a real source.
//
// Usage:
//   pnpm test-adapter <url>           # final pipeline-shaped events
//   pnpm test-adapter <url> --raw     # pre-normalisation CandidateEvents
//   pnpm test-adapter <url> --all     # skip the this-week filter
//
// CITY must be set: page times are wall-clock times in that city's zone.
// EVENTYR_SCRAPE_FIXTURES=<dir> serves the URL from a fixture manifest instead
// of the network (packages/scraper/test/fixtures is one), for replay.

import { toISODate } from "@dothingslol/core/shared";
import type { CityConfig } from "@dothingslol/core/sources";
import { SourceFetcher, scrape } from "@dothingslol/scraper";
import { createFixtureFetcher } from "@dothingslol/scraper/testing";
import { addDays } from "@dothingslol/utils/tz";
import {
	applyAnnotation,
	createGeminiAnnotator,
} from "../adapters/annotate.js";
import { createGeminiPageExtractor } from "../adapters/llmExtract.js";
import { councilEventUrl, prepareCandidates } from "../adapters/normalise.js";
import type { SourceDefinition } from "../adapters/types.js";
import type { Logger } from "../config/context.js";
import type { PipelineConfig } from "../config/load.js";
import { getWeekRange } from "../config/week.js";
import { createHttpCacheStore } from "../io/httpCache.js";

export interface TestUrlOptions {
	url: string;
	cityConfig: CityConfig;
	config: PipelineConfig;
	raw: boolean;
	all: boolean;
	/** EVENTYR_SCRAPE_FIXTURES — a fixture manifest dir in place of the network. */
	fixturesDir?: string;
}

export async function testUrl(
	log: Logger,
	opts: TestUrlOptions,
): Promise<void> {
	const { url, cityConfig, config: cfg, raw, all, fixturesDir } = opts;
	const parsed = new URL(url); // throws with a clear message on a malformed URL
	const CITY_TZ = cityConfig.timezone;
	const { sunday } = getWeekRange(new Date(), CITY_TZ);

	const source: SourceDefinition = {
		id: `manual-test--${parsed.hostname}`,
		name: parsed.hostname,
		homepage: parsed.origin,
		listingUrls: [url],
		domains: [parsed.hostname],
		// Left empty on purpose: a real registry entry names its venue, but
		// this ad-hoc source knows nothing, and filling it with the hostname
		// would fabricate a location for every event the page didn't name
		// one for.
		venue: {
			name: "",
			address: null,
			suburb: null,
		},
		strategy: "html",
		sourceTier: "independents",
		timeZone: cityConfig.timezone,
		note: "ad-hoc CLI test source, not part of any city registry",
	};

	const result = await scrape(url, {
		strategy: "html",
		fetcher: fixturesDir
			? createFixtureFetcher(fixturesDir)
			: new SourceFetcher({ store: createHttpCacheStore() }),
		fallback: createGeminiPageExtractor(),
		timeZone: cityConfig.timezone,
		linkRewriter: councilEventUrl,
		source,
	});
	const { candidates } = result;
	const failed = result.fetch.status === "failed";
	const blocked = result.fetch.status === "blocked";
	log.error(
		`\n${failed || blocked ? "✗" : "✓"} ${failed ? 0 : 1} listing(s) fetched, ${candidates.length} candidate(s) extracted`,
	);
	if (failed) log.error(`  ! fetch ${url}: ${result.fetch.error}`);
	if (blocked) log.error(`  ! extract ${url}: ${result.fetch.error}`);

	if (raw) {
		log.log(JSON.stringify(candidates, null, 2));
		return;
	}

	// --all widens the window so nothing is date-filtered out, which is
	// what you want when inspecting a page in isolation rather than as
	// this week's contribution.
	const from = all ? "0000-01-01" : toISODate(new Date(), CITY_TZ);
	const to = all
		? "9999-12-31"
		: addDays(toISODate(sunday, CITY_TZ), cfg.publish.windowDaysAfterWeek);
	const { prepared, stats } = prepareCandidates(
		candidates,
		source,
		from,
		to,
		source.timeZone,
	);
	log.error(
		`  ${stats.total} found → ${stats.kept} in window` +
			`  (${stats.noDate} undated, ${stats.past} past, ${stats.later} later, ${stats.noTitle} untitled)`,
	);

	let events: Record<string, unknown>[] = [];
	if (prepared.length > 0) {
		const annotate = createGeminiAnnotator();
		const annotations = await annotate(
			prepared.map((p) => p.event),
			source.name,
		);
		events = prepared
			.map((p, i) => ({ event: p.event, a: annotations[i] }))
			.filter(({ a }) => !a?.drop)
			.map(({ event, a }) => applyAnnotation(event, a));
		log.error(`  ${events.length} after annotation filter`);
	}
	log.log(JSON.stringify(events, null, 2));
}
