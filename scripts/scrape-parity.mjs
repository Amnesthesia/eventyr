#!/usr/bin/env node
// Scraper output parity harness (docs/monorepo/PLAN.md §9, phase 1.8).
//
// Runs every page fixture in packages/scraper/test/fixtures through
// @dothingslol/scraper's scrape() with the package's fixture fetcher (the
// fixture bodies stand in for the network) and a stub LLM rung that returns
// one fixed marker candidate, so no model is ever called. The goldens in
// test/golden/scrape were recorded from the pre-1.8 ladder + normalise (the
// step-1 version of this script, commit 2ab0ec6) and are the contract the
// move must keep:
//
//   <fixture>.json   fetch outcome (listings, errors), every candidate with
//                    its provenance, the normalised events, the rejections
//                    with their reasons, and how often the LLM rung was asked
//   _meta.json       peak concurrent fetches and wall-clock with a 100 ms
//                    fetch latency (D19: the scrape fan-out stays concurrent)
//
// Usage:
//   node scripts/scrape-parity.mjs [--record-meta] [--latency=<ms>]
//
// <fixture>.json files are rewritten on every run: `git diff --exit-code
// test/golden/scrape` is the parity check. _meta.json is only written with
// --record-meta; otherwise the fresh profile is checked against it (peak ≥
// golden, wall-clock ≤ golden + 10%) and a drop fails the run.
//
// The clock is pinned (scripts/fake-now.mjs): iCal recurrence expansion and
// the date parser's reference date both read it.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO, "packages", "scraper", "test", "fixtures");
const GOLDEN = join(REPO, "test", "golden", "scrape");
/** Same instant as the LLM parity harness: a Wednesday, so the iCal fixture's
 * weekly recurrence has occurrences on both sides of it. */
const FAKE_NOW = "2026-09-23T10:00:00+10:00";
const FETCHED_AT = "2026-09-23T00:00:00.000Z";
const TIME_ZONE = "Australia/Brisbane";
/** collect.ts's SOURCE_CONCURRENCY: the fan-out the profile measures. */
const CONCURRENCY = 5;
const WALL_CLOCK_TOLERANCE = 1.1;

process.env.EVENTYR_FAKE_NOW ??= FAKE_NOW;
// Explicit dummy: nothing here may reach a model, and this overrides .env.
process.env.GOOGLE_API_KEY = "dummy";
await import("./fake-now.mjs");

const args = process.argv.slice(2);
const recordMeta = args.includes("--record-meta");
const latencyMs = Number(
	args.find((a) => a.startsWith("--latency="))?.slice("--latency=".length) ??
		"100",
);

const load = (p) => tsImport(p, import.meta.url);
const { scrape } = await load("../packages/scraper/src/index.ts");
const { createFixtureFetcher } = await load("../packages/scraper/src/testing.ts");
const { mapWithConcurrency } = await load(
	"../packages/utils/src/concurrency.ts",
);

const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf-8"));
const fetcher = createFixtureFetcher(FIXTURES, { latencyMs, fetchedAt: FETCHED_AT });

// --- stub LLM rung --------------------------------------------------------
// One fixed marker candidate per call, so the golden proves the rung was
// reached (and with what) without any model.
const MARKER = {
	title: "LLM rung marker",
	description: null,
	startRaw: "Tuesday 29 September 2026, 7:00 PM",
	endRaw: null,
	venueName: null,
	address: null,
	url: null,
	price: null,
	imageUrl: null,
	organiser: null,
	category: null,
	sourceEventId: null,
};
const fallbackCalls = new Map();
const extractPage = async (pageText, sourceName) => {
	const calls = fallbackCalls.get(sourceName) ?? [];
	calls.push(pageText.length);
	fallbackCalls.set(sourceName, calls);
	return [MARKER];
};

function sourceFor(f) {
	const u = new URL(f.url);
	return {
		id: f.name,
		name: `Fixture ${f.name}`,
		homepage: `${u.origin}/`,
		listingUrls: [f.url],
		domains: [u.host],
		venue: { name: "Fixture Venue", address: "1 Test St", suburb: "Testville" },
		strategy: f.strategy ?? "html",
		sourceTier: "independents",
		timeZone: TIME_ZONE,
	};
}

async function runFixture(f) {
	const source = sourceFor(f);
	const r = await scrape(f.url, {
		timeZone: TIME_ZONE,
		strategy: source.strategy,
		fetcher,
		fallback: extractPage,
		source,
		now: () => new Date(FAKE_NOW),
	});
	// The goldens carry the pre-1.8 runner's error wording ("discover:" for a
	// fetch that never completed, "extract <url>:" for a refusal); ScrapeResult
	// says the same thing as fetch.status + fetch.error.
	const errors =
		r.fetch.status === "failed"
			? [`discover: ${r.fetch.error}`]
			: r.fetch.status === "blocked"
				? [`extract ${f.url}: ${r.fetch.error}`]
				: [];
	return {
		fixture: f.name,
		url: f.url,
		strategy: source.strategy,
		fetch: { listingsFetched: r.fetch.status === "failed" ? 0 : 1, errors },
		found: r.parse.found,
		candidates: r.candidates,
		events: r.events,
		// The old Rejection also carried startISO, always null for these two
		// reasons (they are decided before a date is resolved).
		rejected: r.parse.rejected.map(({ reason, title, startRaw, url }) => ({
			reason,
			title,
			startRaw,
			startISO: null,
			url,
		})),
		fallbackCalls: fallbackCalls.get(source.name) ?? [],
	};
}

mkdirSync(GOLDEN, { recursive: true });
for (const f of readdirSync(GOLDEN)) {
	if (f !== "_meta.json") rmSync(join(GOLDEN, f));
}
const started = Date.now();
const outputs = await mapWithConcurrency(manifest, CONCURRENCY, runFixture);
const wallClockMs = Date.now() - started;
for (const out of outputs) {
	writeFileSync(
		join(GOLDEN, `${out.fixture}.json`),
		`${JSON.stringify(out, null, 2)}\n`,
		"utf-8",
	);
	const status = out.fetch.errors.length ? "✗" : "✓";
	console.log(
		`${status} ${out.fixture.padEnd(24)} ${String(out.found).padStart(3)} found → ${String(out.events.length).padStart(3)} events` +
			`, ${out.rejected.length} rejected, ${out.fallbackCalls.length} fallback call(s)` +
			(out.fetch.errors.length ? `  ! ${out.fetch.errors.join("; ")}` : ""),
	);
}

const { fetches, peakInFlight } = fetcher.stats;
const meta = { fixtures: manifest.length, fetches, latencyMs, peakInFlight, wallClockMs };
const metaPath = join(GOLDEN, "_meta.json");
const problems = [];
if (recordMeta) {
	writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
} else if (existsSync(metaPath)) {
	const golden = JSON.parse(readFileSync(metaPath, "utf-8"));
	if (meta.peakInFlight < golden.peakInFlight)
		problems.push(`peak in-flight ${meta.peakInFlight} < golden ${golden.peakInFlight} — something went serial`);
	if (meta.wallClockMs > golden.wallClockMs * WALL_CLOCK_TOLERANCE)
		problems.push(`wall-clock ${meta.wallClockMs}ms > golden ${golden.wallClockMs}ms +10%`);
	if (meta.fetches !== golden.fetches) problems.push(`fetches ${meta.fetches} ≠ golden ${golden.fetches}`);
}
console.log(
	`\n${manifest.length} fixture(s), ${fetches} fetch(es), peak ${peakInFlight} in flight, ${wallClockMs}ms wall-clock at ${latencyMs}ms latency` +
		(problems.length ? `\n  ${problems.join("\n  ")}\nscrape-parity: FAILED` : ""),
);
if (problems.length) process.exit(1);
console.log(
	`scrape-parity: goldens written to ${relative(REPO, GOLDEN)}; run \`git diff --exit-code ${relative(REPO, GOLDEN)}\``,
);
