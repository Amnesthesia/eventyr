import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { isRetiredTemplateDescription } from "./adapters/annotate.ts";
import { humanDatetime, isPast, withinWindow } from "./adapters/normalise.ts";
import {
	allSourceEntries,
	DATA_ROOT,
	DEFAULT_COST_LOCALE,
	fmtDate,
	getWeekRange,
	isLikelyImageUrl,
	loadCityConfig,
	loadYieldLedger,
	mergeTagVariants,
	normaliseCurrency,
	normaliseHost,
	PROJECT_ROOT,
	requireEnv,
	stripUselessTags,
	toISODate,
	yieldLedgerPath,
} from "./common.ts";
import type { DedupeGroup } from "./dedupe.ts";
import { dedupeEventsSmart } from "./dedupe.ts";
import { createGeminiPairClassifier } from "./dedupeClassifier.ts";
import {
	createGoogleGeocoder,
	findElsewhere,
	findForeign,
	withPlaceCache,
} from "./locality.ts";
import { installUsageReporting } from "./providers/gemini.ts";
import { unlistedWorthProbing, updateLedger } from "./sourceYield.ts";
import { cleanText, cleanUrl } from "./text.ts";

const CITY = requireEnv("CITY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);
const cityCfg = loadCityConfig(CITY);
const CITY_NAME = cityCfg.name;
// Defaults documented on CityConfig: a non-Australian city sets both in its
// sources/{city}.yml rather than relying on these.
const COST_LOCALE = {
	locale: cityCfg.locale ?? DEFAULT_COST_LOCALE.locale,
	currency: cityCfg.currency ?? DEFAULT_COST_LOCALE.currency,
	// Needed by the schema.org dates on every page: a naive wall-clock string
	// is ambiguous to a crawler. See isoWithOffset.
	timezone: cityCfg.timezone ?? "Australia/Brisbane",
};

// Same window the scrape pass uses: today through the end of next week. Kept
// here rather than imported from collect.ts so curate has no dependency on a
// script that may not have run.
const WINDOW_FROM = toISODate(new Date());
const WINDOW_TO = toISODate(
	new Date(getWeekRange().sunday.getTime() + 7 * 86_400_000),
);

const OUT_PATH = join(DATA_ROOT, `${CITY}.json`);

/** The digest already published: the cache-check key and the carry-forward
 * input. "No file" and "unreadable file" are told apart so a corrupt digest
 * does not look like a first run. */
const PREVIOUS: Record<string, unknown> | null = (() => {
	if (!existsSync(OUT_PATH)) return null;
	try {
		return JSON.parse(readFileSync(OUT_PATH, "utf-8"));
	} catch {
		console.log(
			`  ⚠ previous digest unreadable, nothing carried forward: ${OUT_PATH}`,
		);
		return null;
	}
})();

/**
 * Skip only when this week's digest exists AND no curated input is newer than
 * it. The week stamp alone missed a real case: a provider that failed in the
 * morning run (max_tokens, nothing written) was collected by a re-dispatch 20
 * minutes later, and curate skipped on the stamp — 16 events sat on disk,
 * invisible until someone passed FORCE. mtime is trustworthy here: a checkout
 * stamps every file at the same instant, so anything written during the run is
 * strictly newer. Rank and geocode follow on their own, because writeJson
 * drops ranked_at/geocoded_at.
 *
 * ponytail: within one run only — a fresh checkout stamps inputs and output
 * alike, so an input committed by an earlier run is never "newer". Record the
 * consumed inputs (path + hash) in the digest if cross-run matters.
 */
function alreadyCuratedThisWeek(monday: Date): boolean {
	if (PREVIOUS?.week_start !== toISODate(monday)) return false;
	const outMtime = statSync(OUT_PATH).mtimeMs;
	const newer = findJsonFiles(join(DATA_ROOT, CITY), "curated").filter(
		(f) => statSync(f).mtimeMs > outMtime,
	);
	if (newer.length === 0) return true;
	console.log(
		`→ ${newer.length} curated input(s) newer than ${CITY}.json — re-curating:`,
	);
	for (const f of newer.slice(0, 5))
		console.log(`    ${relative(DATA_ROOT, f)}`);
	return false;
}

function previousEvents(): Record<string, unknown>[] {
	return Array.isArray(PREVIOUS?.events) ? PREVIOUS.events : [];
}

/** Curated inputs, each tagged with the provider directory it came from —
 * that name is the only record of which provider found an event, and the
 * per-provider yield report is what decides whether a paid provider is worth
 * keeping on. */
function findCuratedFiles(
	baseDir: string,
): { path: string; provider: string }[] {
	if (!existsSync(baseDir)) return [];
	const results: { path: string; provider: string }[] = [];
	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(baseDir, entry.name, "curated");
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".json")) {
				results.push({ path: join(dir, file), provider: entry.name });
			}
		}
	}
	return results.sort((a, b) => a.path.localeCompare(b.path));
}

function findJsonFiles(baseDir: string, subPath: string): string[] {
	if (!existsSync(baseDir)) return [];
	const results: string[] = [];
	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(baseDir, entry.name, subPath);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".json")) results.push(join(dir, file));
		}
	}
	return results.sort();
}

/** Marks which provider produced an event. Stripped before the digest is
 * written — it is bookkeeping, not published data. */
const PROVIDER_KEY = "_provider";
/** Everything except this directory is an LLM search provider. */
const SCRAPE_PROVIDER = "adapters";

/**
 * How much each provider actually contributed: events that survived dedupe,
 * and events no other provider also found. The second number is the one that
 * matters for a paid provider — a search that only re-finds what the scrapers
 * already have is pure cost.
 */
function reportProviderYield(
	events: Record<string, unknown>[],
	groups: DedupeGroup[],
): void {
	const per = new Map<string, { total: number; unique: number }>();
	for (const group of groups) {
		const providers = new Set(
			group.members.map((i) => (events[i][PROVIDER_KEY] as string) ?? "?"),
		);
		for (const provider of providers) {
			const rec = per.get(provider) ?? { total: 0, unique: 0 };
			rec.total++;
			if (providers.size === 1) rec.unique++;
			per.set(provider, rec);
		}
	}
	const rows = [...per.entries()].sort((a, b) => b[1].unique - a[1].unique);
	console.log("→ provider yield (events kept / found by that provider alone):");
	for (const [provider, rec] of rows) {
		console.log(
			`    ${provider.padEnd(12)} ${String(rec.total).padStart(4)} / ${String(rec.unique).padStart(4)} unique`,
		);
	}
}

/**
 * Records which sources the search actually found events on, so next week's
 * prompts can name only those (see src/sourceYield.ts). Hosts belonging to no
 * source are counted too and reported: the search finding a venue we have
 * never heard of is exactly the signal probe-sources wants.
 */
function updateYieldLedger(week: string, linkHosts: string[]): void {
	if (linkHosts.length === 0) return;
	const ledger = updateLedger(
		loadYieldLedger(CITY),
		week,
		linkHosts,
		allSourceEntries(cityCfg),
	);
	const path = yieldLedgerPath(CITY);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(ledger, null, 2), "utf-8");
	const named = Object.keys(ledger.sources).length;
	console.log(
		`→ source yield: ${named} source(s) have produced a search event in the last ${ledger.weeks.length} recorded week(s)`,
	);
	const worth = unlistedWorthProbing(ledger).slice(0, 10);
	if (worth.length > 0) {
		console.log(
			`  ${worth.length} host(s) the search keeps finding that are on no source list — worth \`pnpm probe-sources --city=${CITY} --only=${worth[0].host}\`:`,
		);
		console.log(`    ${worth.map((w) => `${w.host} (${w.count})`).join(", ")}`);
	}
}

/**
 * Text fields shown to a reader, so escaped markup in any of them is a visible
 * defect ("Dice Rolls &#038; Flagons" on a card).
 *
 * Applied here rather than in each collection path: both paths feed this merge,
 * and doing it before dedupe means two sources that differ only in encoding
 * ("Tea &#038; Tour" vs "Tea & Tour") now match instead of both being kept.
 */
const TEXT_FIELDS = [
	"title",
	"description",
	"location",
	"cost",
	"datetime",
	"source",
] as const;
const URL_FIELDS = ["link", "location_url"] as const;

function cleanEvent(event: Record<string, unknown>): Record<string, unknown> {
	const out = { ...event };
	for (const key of TEXT_FIELDS) {
		if (key in out) out[key] = cleanText(out[key]);
	}
	// Re-derived, never trusted as written. The scrape path already builds this
	// with humanDatetime, but the AI search path takes `datetime` straight from
	// the model, which produced 24 different shapes in one city ("7-13 Sept",
	// "12 September 2026", "Tue–Sun, 10am–5pm", "Fri 11 Sep, evening"). Every
	// provenance funnels through cleanEvent, so this is the one place that can
	// make them agree. The fallback keeps the model's own string for an event
	// with no parsable ISO at all, rather than blanking the field.
	out.datetime =
		humanDatetime(
			(out.datetime_iso as string) || null,
			(out.datetime_end_iso as string) || null,
		) ||
		(out.datetime as string) ||
		"";
	// A foreign currency on a South East Queensland listing is the source's
	// markup being wrong, not a real price. See normaliseCurrency.
	if ("cost" in out)
		out.cost = normaliseCurrency(out.cost, COST_LOCALE.currency);
	for (const key of URL_FIELDS) {
		if (key in out) out[key] = cleanUrl(out[key]);
	}
	if (Array.isArray(out.tags)) {
		out.tags = out.tags.map((t) => cleanText(t).trim().toLowerCase());
	}
	// Stricter than the other URLs: an extension-less image URL is an
	// extraction fault rather than a real picture, and 61 of 139 were dead.
	// See isLikelyImageUrl.
	const image = cleanUrl(out.image);
	out.image = isLikelyImageUrl(image) ? image : "";
	return out;
}

const TIER_TO_VENUE: Record<string, string> = {
	aggregators: "aggregator",
	institutions: "institution",
	independents: "independent",
	open: "aggregator",
};

/**
 * Throws out events that are not in the city being published, under two rules
 * of different strength.
 *
 * **Wrong city** — the distance test — applies only to the `aggregators` and
 * `open` tiers. Those are the tiers where a source promoted "for Brisbane"
 * turns out to be national: musick.com.au is a country-wide gig guide, and its
 * verified listing page put 40 Sydney, Melbourne, Adelaide and Perth events
 * into one Brisbane week. An `institutions` or `independents` source is a
 * venue's own site listing its own events, so it is trusted here — and it has
 * to be, because "The Princess Theatre" geocodes to Melbourne while being a
 * real Brisbane venue.
 *
 * **Wrong country** applies to every tier. That is never a near-miss or an
 * ambiguous venue name, and the tier trust turned out to be exploitable: a
 * `method: scraper` source verified for Brisbane (creativelunchclub.com) lists
 * meetups worldwide, and put eight events in Vienna, Manchester, Berlin,
 * Stockholm, Portland, Montreal, Zurich and London on the site under an
 * `independents` entry — where nothing ever looked at them.
 *
 * Only the distinct location strings are geocoded, never one call per event,
 * and every answer is cached to disk, so widening the subject set to all tiers
 * costs one run's worth of new venues and nothing thereafter.
 */
async function dropOtherCities(
	events: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
	const locationOf = (e: Record<string, unknown>): string =>
		((e.location as string) ?? "").trim();
	const centre = cityCfg.centre;
	const apiKey = process.env.GOOGLE_MAPS_API_KEY;
	const located = events.filter((e) => locationOf(e) !== "");
	if (located.length === 0) return events;
	// Same shape of degradation as the dedupe classifier below: the check is an
	// improvement on top of curation, never a precondition for it, and dropping
	// is the destructive direction — so no key means keep everything.
	if (!apiKey) {
		console.log(
			"  ⚠ GOOGLE_MAPS_API_KEY unset — every location kept unchecked",
		);
		return events;
	}
	if (!centre) {
		console.log(
			`  ⚠ no centre configured in sources/${CITY}.yml — only the outside-Australia check will run`,
		);
	}

	const geocode = withPlaceCache(createGoogleGeocoder(apiKey), CITY);
	const places = await geocode(located.map(locationOf));
	// No centre still leaves the country rule usable: it needs no radius.
	const elsewhere = centre ? findElsewhere(places, centre) : new Map();
	const foreign = findForeign(places);
	console.log(
		`→ locality: ${geocode.stats.requested} location(s) geocoded, ` +
			`${geocode.stats.cached} from cache, ${elsewhere.size} not in ${CITY_NAME}, ` +
			`${foreign.size} outside Australia`,
	);
	// Named individually, and separately by rule: the two have different
	// remedies — a wrong-city hit means an aggregator needs watching, a foreign
	// one means the source's listing page is not what it was promoted as.
	for (const [location, why] of elsewhere) {
		console.log(`    ✗ ${location} — ${why}`);
	}
	for (const [location, why] of foreign) {
		console.log(`    ✗✗ ${location} — ${why}`);
	}
	if (elsewhere.size === 0 && foreign.size === 0) return events;
	return events.filter((e) => {
		const location = locationOf(e);
		if (foreign.has(location)) return false;
		// Every tier, not just aggregators. The old rule assumed a venue-tier
		// source only lists its own city, and 128 scraper sources later that is
		// plainly false: QTIX ticketed a Toowoomba museum workshop under
		// brisbane's institutions, and a life-drawing organiser listed Miami
		// Marketta on the Gold Coast under independents. Both were already being
		// geocoded and correctly identified as elsewhere — the drop just never
		// applied to them.
		return !elsewhere.has(location);
	});
}

async function mergeAndDeduplicate(
	monday: Date,
): Promise<Record<string, unknown>[]> {
	const cityDir = join(DATA_ROOT, CITY);
	const allEvents: Record<string, unknown>[] = [];
	const dropped = { past: 0, later: 0, undated: 0 };

	// Link hosts from the search providers only: the ledger governs which
	// sources the *search* prompts name, and a scraped source is not in that
	// list at all.
	const searchLinkHosts: string[] = [];

	for (const { path: file, provider } of findCuratedFiles(cityDir)) {
		try {
			const payload = JSON.parse(readFileSync(file, "utf-8")) as Record<
				string,
				unknown
			>;
			if (payload.week_start === toISODate(monday)) {
				const baseTier = ((payload.tier as string) ?? "").replace(
					/-music$/,
					"",
				);
				const venue = TIER_TO_VENUE[baseTier] ?? "aggregator";
				const events = (payload.events as Record<string, unknown>[]) ?? [];
				for (const rawEvent of events) {
					const event = cleanEvent(rawEvent);
					// The scrape path windows its own output, but the AI search
					// path never did, so finished and far-future events reached
					// the site from search only. Apply the one rule here so both
					// paths are governed identically.
					const start = (event.datetime_iso as string) || null;
					const end = (event.datetime_end_iso as string) || null;
					if (start) {
						if (isPast(start, end, WINDOW_FROM)) {
							dropped.past++;
							continue;
						}
						if (!withinWindow(start, end, WINDOW_FROM, WINDOW_TO)) {
							dropped.later++;
							continue;
						}
					} else {
						// Undated events are kept: they cannot be shown to be
						// past, and the site still renders their human date
						// string. Dropping them would lose real events on the
						// word of a missing field.
						dropped.undated++;
					}
					if (provider !== SCRAPE_PROVIDER) {
						const host = normaliseHost(event.link as string);
						if (host) searchLinkHosts.push(host);
					}
					allEvents.push({ ...event, venue, [PROVIDER_KEY]: provider });
				}
			}
		} catch {
			// skip malformed file
		}
	}

	console.log(
		`→ window ${WINDOW_FROM}..${WINDOW_TO}: dropped ${dropped.past} past, ` +
			`${dropped.later} beyond the window; kept ${dropped.undated} undated`,
	);

	// Carry the previous digest forward. The run is on Sunday for the week
	// starting Monday, and the per-source input files above were already
	// overwritten with next week's results by collect — so without this,
	// today's remaining events (and anything found last week that is still
	// upcoming) would vanish from the site the morning they are being planned
	// around. Appended after the fresh events so dedupe's tie-break keeps the
	// fresh record. Undated events are not carried: they can never expire via
	// isPast, so they would accumulate forever. Everything else does expire on
	// the following run, so this cannot grow unbounded.
	const carried = {
		kept: 0,
		total: 0,
		past: 0,
		later: 0,
		undated: 0,
		detemplated: 0,
	};
	for (const rawEvent of previousEvents()) {
		carried.total++;
		const event = cleanEvent(rawEvent);
		const start = (event.datetime_iso as string) || null;
		const end = (event.datetime_end_iso as string) || null;
		if (!start) {
			carried.undated++;
			continue;
		}
		if (isPast(start, end, WINDOW_FROM)) {
			carried.past++;
			continue;
		}
		if (!withinWindow(start, end, WINDOW_FROM, WINDOW_TO)) {
			carried.later++;
			continue;
		}
		// Stripped before dedupe on purpose: with the filler gone, dedupe's
		// completeness tie-break prefers a freshly scraped copy that has a real
		// description over the carried one.
		if (isRetiredTemplateDescription(event)) {
			event.description = "";
			carried.detemplated++;
		}
		allEvents.push({ ...event, [PROVIDER_KEY]: "carried" });
		carried.kept++;
	}
	console.log(
		PREVIOUS
			? `→ carried ${carried.kept} of ${carried.total} previously published event(s) forward ` +
					`(dropped ${carried.past} past, ${carried.later} beyond the window, ${carried.undated} undated` +
					`${carried.detemplated > 0 ? `; blanked ${carried.detemplated} retired template description(s)` : ""})`
			: "→ no previous digest to carry forward",
	);

	// After the merge so both collection paths are governed identically, and
	// after the window so a finished event is never paid for.
	const local = await dropOtherCities(allEvents);
	if (local.length !== allEvents.length) {
		console.log(
			`→ ${allEvents.length - local.length} event(s) dropped as not in ${CITY_NAME}`,
		);
	}

	// Deliberately not common.ts's dedupeEvents here: this merge now spans
	// many per-source scrape files plus the search results, so it gets the
	// blocking + grey-zone strategy in src/dedupe.ts. See that file's header
	// for why and what it costs.
	// The classifier is an enhancement, not a requirement: without it the
	// deterministic stage still runs and ambiguous pairs are simply kept.
	// Merging is the destructive direction, so degrading to "keep both" is the
	// safe failure — and it means a missing key can't take down curation.
	const apiKey = process.env.GOOGLE_API_KEY;
	if (!apiKey) {
		console.log(
			"  ⚠ GOOGLE_API_KEY unset — deduping deterministically only, ambiguous pairs kept",
		);
	}
	const { events, stats, groups } = await dedupeEventsSmart(local, {
		classify: apiKey ? createGeminiPairClassifier(apiKey) : undefined,
	});
	console.log(
		`→ ${stats.input} events in, ${stats.removed} duplicate(s) removed ` +
			`(${stats.settledPairs} matched outright, ${stats.askedPairs} ambiguous pair(s) checked, ${stats.confirmedByLlm} confirmed)`,
	);
	reportProviderYield(local, groups);
	updateYieldLedger(toISODate(monday), searchLinkHosts);

	// Collapse tag variants now the whole week is in one place — this is the
	// only point that can see the corpus, and the merge is corpus-driven on
	// purpose (see mergeTagVariants).
	const canonical = mergeTagVariants(
		events.map((e) => e.tags as string[] | undefined),
	);
	let rewritten = 0;
	let stripped = 0;
	for (const event of events) {
		if (!Array.isArray(event.tags)) continue;
		const before = event.tags as string[];
		const merged = [...new Set(before.map((t) => canonical.get(t) ?? t))];
		// Tags that cannot divide the list are worse than no tag now that
		// preferences act on them — see stripUselessTags.
		const cleaned = stripUselessTags(
			merged,
			CITY_NAME,
			(event.location as string) ?? "",
		);
		stripped += merged.length - cleaned.length;
		// "free" is a fact about the cost field, not a judgement, so code sets
		// it rather than the annotator — which never sees cost. Asked to guess,
		// it agreed with the cost on only 17 of 43 free events, erring in both
		// directions.
		const cost = ((event.cost as string) ?? "").trim();
		const isFree = /^(free|free entry|no charge|\$?0(\.00)?)$/i.test(cost);
		const after = cleaned.filter((t) => t !== "free");
		if (isFree) after.push("free");
		if (after.join("\u0000") !== before.join("\u0000")) rewritten++;
		event.tags = after;
	}
	if (canonical.size > 0) {
		const merged = new Set(
			[...canonical].filter(([from, to]) => from !== to).map(([from]) => from),
		);
		console.log(
			`→ tags: ${merged.size} variant(s) merged onto their canonical spelling ` +
				`(${[...merged].slice(0, 6).join(", ")}${merged.size > 6 ? ", …" : ""}), ` +
				`${stripped} useless tag(s) dropped, ${rewritten} event(s) rewritten`,
		);
	}

	// Bookkeeping only — never published.
	return events.map(({ [PROVIDER_KEY]: _provider, ...rest }) => rest);
}

function writeJson(
	events: Record<string, unknown>[],
	monday: Date,
	sunday: Date,
): string {
	const payload = {
		city: CITY_NAME,
		city_key: CITY,
		week_start: toISODate(monday),
		week_end: toISODate(sunday),
		...COST_LOCALE,
		generated_at: toISODate(new Date()),
		events,
	};
	writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");
	console.log(
		`→ Written ${relative(PROJECT_ROOT, OUT_PATH)} (${events.length} events)`,
	);
	return OUT_PATH;
}

async function main(): Promise<void> {
	installUsageReporting();
	const { monday, sunday } = getWeekRange();

	if (!FORCE && alreadyCuratedThisWeek(monday)) {
		console.log(
			"→ Already curated for this week — skipping. Set FORCE=true to re-curate.",
		);
		return;
	}

	console.log(
		`Curation — ${CITY_NAME} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);
	console.log("=".repeat(50));

	console.log("→ Merging and deduplicating…");
	const events = await mergeAndDeduplicate(monday);

	if (events.length === 0) {
		throw new Error(
			"✗ No events found. Run collection.ts for each tier first.",
		);
	}

	console.log(`→ ${events.length} events total`);
	writeJson(events, monday, sunday);
	console.log("✓ Curation complete.");
}

await main();
