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

import { getWeekRange, requireEnv, toISODate } from "../common.ts";
import { installUsageReporting } from "../providers/gemini.ts";
import { applyAnnotation, createGeminiAnnotator } from "./annotate.ts";
import { SourceFetcher } from "./fetch.ts";
import { createGeminiPageExtractor } from "./llmExtract.ts";
import { prepareCandidates } from "./normalise.ts";
import { createPageAdapter } from "./pageAdapter.ts";
import { runAdapter } from "./runner.ts";
import type { SourceDefinition } from "./types.ts";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const RAW = args.includes("--raw");
const ALL = args.includes("--all");

if (!url) {
	console.error("Usage: pnpm test-adapter <url> [--raw] [--all]");
	process.exit(1);
}

const parsed = new URL(url); // throws with a clear message on a malformed URL
const GOOGLE_API_KEY = requireEnv("GOOGLE_API_KEY");
const { sunday } = getWeekRange();

const source: SourceDefinition = {
	id: `manual-test--${parsed.hostname}`,
	name: parsed.hostname,
	homepage: parsed.origin,
	listingUrls: [url],
	domains: [parsed.hostname],
	// Left empty on purpose: a real registry entry names its venue, but this
	// ad-hoc source knows nothing, and filling it with the hostname would
	// fabricate a location for every event the page didn't name one for.
	venue: {
		name: "",
		address: null,
		suburb: null,
	},
	strategy: "html",
	sourceTier: "independents",
	note: "ad-hoc CLI test source, not part of any city registry",
};

installUsageReporting();

const adapter = createPageAdapter(source, {
	fetcher: new SourceFetcher(),
	extractPage: createGeminiPageExtractor(GOOGLE_API_KEY),
});

const { result, candidates } = await runAdapter(adapter);
console.error(
	`\n${result.ok ? "✓" : "✗"} ${result.listingsFetched} listing(s) fetched, ${candidates.length} candidate(s) extracted`,
);
for (const err of result.errors) console.error(`  ! ${err}`);

if (RAW) {
	console.log(JSON.stringify(candidates, null, 2));
} else {
	// --all widens the window so nothing is date-filtered out, which is what
	// you want when inspecting a page in isolation rather than as this week's
	// contribution.
	const from = ALL ? "0000-01-01" : toISODate(new Date());
	const to = ALL
		? "9999-12-31"
		: toISODate(new Date(sunday.getTime() + 7 * 86_400_000));
	const { prepared, stats } = prepareCandidates(candidates, source, from, to);
	console.error(
		`  ${stats.total} found → ${stats.kept} in window` +
			`  (${stats.noDate} undated, ${stats.past} past, ${stats.later} later, ${stats.noTitle} untitled)`,
	);

	let events: Record<string, unknown>[] = [];
	if (prepared.length > 0) {
		const annotate = createGeminiAnnotator(GOOGLE_API_KEY);
		const annotations = await annotate(
			prepared.map((p) => p.event),
			source.name,
		);
		events = prepared
			.map((p, i) => ({ event: p.event, a: annotations[i] }))
			.filter(({ a }) => !a?.drop)
			.map(({ event, a }) => applyAnnotation(event, a));
		console.error(`  ${events.length} after annotation filter`);
	}
	console.log(JSON.stringify(events, null, 2));
}
