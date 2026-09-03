import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { CityConfig } from "../common.ts";
import {
	CATEGORIES,
	curatedPath,
	fmtDate,
	INTERESTS,
	llmSourceStrings,
	PROJECT_ROOT,
	toISODate,
} from "../common.ts";

export interface SearchResult {
	events: Record<string, unknown>[];
}

export type CurateFunction = (
	rawText: string,
	cityName: string,
	label: string,
) => Promise<Record<string, unknown>[]>;

export interface ProviderOptions {
	city: string;
	cityCfg: CityConfig;
	tier: string;
	weekStart: Date;
	weekEnd: Date;
	curate: CurateFunction;
}

export const TIER_INSTRUCTIONS: Record<string, string> = {
	aggregators:
		"These sources often list the same events as each other. " +
		"Batch them into 1–2 broad `site:A OR site:B` queries — " +
		"you do not need to search every source individually.",
	institutions:
		"Each institution runs its own independent programme. " +
		"Check every source. Batch by type where sensible " +
		"(e.g. universities together, major venues together).",
	independents:
		"These are niche venues whose events rarely appear in aggregators. " +
		"Check every source. Small `site:A OR site:B` batches are fine " +
		"where sources are closely related, but don't skip any.",
};

// A fixed grammar (rather than "note these fields" prose) keeps every
// provider's raw output shaped the same way, which is what the downstream
// extraction pass actually parses — free-form prose/tables/citation
// footnotes vary call to call and make extraction miss events.
export const OUTPUT_FORMAT_RULES =
	"For each event, output ONE line in exactly this pipe-delimited format and field order " +
	"— nothing else on the line, no markdown, no bold, no headings, no tables, no numbering " +
	"or bullets, no bracketed citation links like ([site](url)):\n" +
	"Title | Date and time | Venue/location | Cost | Organiser | URL\n" +
	"Use bare URLs only. Only include events with confirmed dates in that range. " +
	"Skip spectator sports, MLM events, corporate sales pitches, and online-only events. " +
	"This is a fully automated pipeline with no human able to read or reply to your response — " +
	"never end with an offer, question, or list of options (e.g. 'want me to also include X, Y, or " +
	"Z?'). If there's a more complete or exhaustive version of the answer, just do it and include " +
	"it directly instead of asking permission — always take the most thorough option yourself.";

function sourceNames(sources: string[]): string {
	return sources
		.map((s) => s.split("(")[0].trim().replace(/—\s*$/, "").trim())
		.join(", ");
}

// Splits raw search text into paragraph-sized chunks so no single curation
// call has to read (or emit) an unbounded amount of text.
export function splitIntoBatches(text: string, maxChars = 6000): string[] {
	const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
	const batches: string[] = [];
	let current = "";
	for (const p of paragraphs) {
		if (current && current.length + p.length + 2 > maxChars) {
			batches.push(current);
			current = p;
		} else {
			current = current ? `${current}\n\n${p}` : p;
		}
	}
	if (current) batches.push(current);
	return batches.length ? batches : [text];
}

/**
 * Parses a JSON array out of an LLM response, tolerating the two things these
 * responses actually do wrong: wrapping the array in prose/code fences, and
 * getting cut off mid-array by the output token cap. On truncation it retries
 * at the last complete object rather than losing the whole batch — a clipped
 * final event should cost one event, not all of them.
 */
export function parseJsonArray<T>(raw: string, label?: string): T[] {
	const cleaned = raw.replace(/```json|```/g, "").trim();
	const start = cleaned.indexOf("[");
	if (start === -1) return [];
	let jsonStr = cleaned.slice(start);
	const end = jsonStr.lastIndexOf("]");
	if (end !== -1) jsonStr = jsonStr.slice(0, end + 1);
	try {
		return JSON.parse(jsonStr) as T[];
	} catch {
		const lastComplete = jsonStr.lastIndexOf("},");
		if (lastComplete !== -1) {
			try {
				return JSON.parse(`${jsonStr.slice(0, lastComplete + 1)}]`) as T[];
			} catch {
				// fall through to the shared failure log
			}
		}
		if (label) console.log(`  ✗ [${label}] Could not parse JSON response`);
		return [];
	}
}

export function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		chunks.push(items.slice(i, i + size));
	return chunks;
}

export abstract class BaseProvider {
	abstract readonly name: string;
	abstract readonly tiers: readonly string[];
	abstract searchEvents(opts: ProviderOptions): Promise<SearchResult>;

	async collect(
		city: string,
		cityCfg: CityConfig,
		weekStart: Date,
		weekEnd: Date,
		force: boolean,
		curate: CurateFunction,
	): Promise<void> {
		// One search per tier. There used to be a second "music" pass per tier,
		// because a single mixed-category search spread one event budget across
		// all six CATEGORIES and Concert/Music lost out. Music-heavy venues are
		// now scraped directly (src/adapters/), so that workaround costs double
		// the search calls for a problem it no longer solves.
		//
		// Each tier search is independent, so run them concurrently — that's
		// what cuts wall-clock time, since per-call token cost is fixed either
		// way. Errors are caught per-job so one failure doesn't take down the
		// rest of the batch.
		await Promise.all(
			this.tiers.map(async (tier) => {
				const outPath = curatedPath(city, this.name, tier);
				const label = `${this.name}/${tier}`;

				if (!force && existsSync(outPath)) {
					try {
						const payload = JSON.parse(
							readFileSync(outPath, "utf-8"),
						) as Record<string, unknown>;
						if (payload.week_start === toISODate(weekStart)) {
							console.log(`  → [${label}] Already collected — skipping`);
							return;
						}
					} catch {
						// proceed with collection
					}
				}

				try {
					const opts: ProviderOptions = {
						city,
						cityCfg,
						tier,
						weekStart,
						weekEnd,
						curate,
					};
					const { events } = await this.searchEvents(opts);
					const payload = {
						city_key: city,
						provider: this.name,
						tier,
						week_start: toISODate(weekStart),
						week_end: toISODate(weekEnd),
						events,
					};
					mkdirSync(dirname(outPath), { recursive: true });
					writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
					console.log(`  → Written ${relative(PROJECT_ROOT, outPath)}`);
				} catch (err) {
					console.error(`  ⚠ [${label}] ${(err as Error).message}`);
				}
			}),
		);
	}

	protected buildFormatSystem(cityName: string): string {
		const filterRule =
			"1. FILTER: Remove any sports, MLM, sales-pitch, or clearly irrelevant events.";
		return `You are a personal events curator for someone in ${cityName} with these interests:
${INTERESTS}

The user will give you raw event listings from a single search source.

Your job:
${filterRule}
2. CURATE: For each remaining event, produce the following fields:
   - title:       event name (string)
   - datetime:    date and time as a short string, e.g. "Sat 14 Jun, 7:00 PM"
   - location:    venue name and/or suburb (string)
   - link:        direct URL to the event page (string; use "" if unknown)
   - category:    exactly one of ${JSON.stringify(CATEGORIES)}
   - cost:        "Free" or the price, e.g. "$25" (string)
   - source:      website or organisation name (string)
   - description: 1–2 sentences describing what the event actually is — what happens,
                  who runs it, what to expect. Be specific, not generic.
   - tags:        3–4 short lowercase topic tags reflecting subject matter, format, and cost,
                  e.g. ["philosophy", "lecture", "free"] or ["art", "workshop", "beginners"]
   - social:      true if the event has significant group/social interaction (meetups, socials, networking, group classes)
   - intellectual: true if the event is primarily idea- or knowledge-focused (lectures, talks, debates, book clubs, trivia)
   - hands_on:    true if participants actively make, build, or do something (workshops, craft, coding, cooking)
   - creative:    true if the event involves artistic or creative expression (art, music, writing, performance, improv)
   - datetime_iso: ISO 8601 start datetime, e.g. "2026-06-14T19:00:00". Use the event's
                  actual date and time. Date-only "YYYY-MM-DD" if no time is known.
                  Use "" if completely unknown.
   - datetime_end_iso: ISO 8601 end datetime, e.g. "2026-06-14T21:00:00". Use the event's
                  actual end date and time. Date-only "YYYY-MM-DD" if no time is known.
                  Use "" if completely unknown.
   - image:       direct URL to a preview/hero image for the event. Use "" if none available. Must be a full https:// URL.

3. OUTPUT: A valid compact JSON array — no whitespace or newlines between elements. Include EVERY event that passes the filter — do not stop early or truncate the list. No markdown, no explanation, no code fences.

Example element (compact, single line):
{"title":"Philosophy of Mind: AI and Consciousness","datetime":"Mon 12 May, 7:00 PM","location":"UQ St Lucia, Building 9","link":"https://events.uq.edu.au/...","category":"Public Lecture","cost":"Free","source":"UQ Events","description":"UQ's Professor of Philosophy presents her latest research on consciousness and what AI can and cannot tell us about subjective experience — aimed at a general audience, followed by open Q&A.","tags":["philosophy","ai","lecture","free"],"social":false,"intellectual":true,"hands_on":false,"creative":false,"datetime_iso":"2026-05-12T19:00:00","datetime_end_iso":"2026-05-12T21:00:00","image":"https://events.uq.edu.au/images/philosophy-lecture.jpg"}`;
	}

	// Cheap first pass: pull every event out of messy raw search text into a
	// minimal, compact shape. No filtering, no descriptions, no tags — that's
	// the enrichment pass's job. Keeping the schema small means even a batch
	// of 30+ events fits comfortably under any output token limit.
	protected buildExtractSystem(cityName: string): string {
		return `You are extracting a raw list of events from unstructured search results about ${cityName}.

Your ONLY job is extraction — do not filter, judge relevance, or skip anything unless it is clearly not an event (e.g. a table header, a section heading, a venue description with no specific date).

For each event mentioned, extract only:
  - title:    event name (string)
  - datetime: date and time as written, e.g. "Sat 25 Jul, 10am-5pm" (string)
  - location: venue name and/or suburb (string)
  - link:     direct URL to the event page (string; use "" if unknown)
  - cost:     price or "Free" as written (string)
  - source:   website or organisation name (string)

Extract EVERY event mentioned, including every row of every table and every item in every list — do not summarize, merge, or drop any. If the same event appears more than once, list it once.

Output a valid compact JSON array — no whitespace or newlines between elements. No markdown, no explanation, no code fences.

Example element: {"title":"Skyline Cinema","datetime":"Tue 21-Sun 26 Jul, 6-10pm nightly","location":"Level 7, 33 William Street, Brisbane City","link":"https://visit.brisbane.qld.au/whats-on/skyline-cinema","cost":"$5-$20","source":"The Star Brisbane"}`;
	}

	protected parseEvents(
		rawText: string,
		label: string,
	): Record<string, unknown>[] {
		const cleaned = rawText.replace(/```json|```/g, "").trim();
		const start = cleaned.indexOf("[");
		if (start === -1) {
			console.log(`  ✗ [${label}] No JSON array found in curator response`);
			return [];
		}

		let jsonStr = cleaned.slice(start);
		const end = jsonStr.lastIndexOf("]");
		if (end !== -1) jsonStr = jsonStr.slice(0, end + 1);

		try {
			return JSON.parse(jsonStr) as Record<string, unknown>[];
		} catch {
			const lastComplete = jsonStr.lastIndexOf("},");
			if (lastComplete === -1) {
				console.log(
					`  ✗ [${label}] JSONDecodeError and no recovery point found`,
				);
				return [];
			}
			const recovered = `${jsonStr.slice(0, lastComplete + 1)}]`;
			try {
				const events = JSON.parse(recovered) as Record<string, unknown>[];
				console.log(
					`  ⚠ [${label}] Recovered ${events.length} events from truncated response`,
				);
				return events;
			} catch {
				console.log(`  ✗ [${label}] Could not recover from truncated JSON`);
				return [];
			}
		}
	}

	protected buildSearchUser(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd } = opts;
		const coverageNote =
			"Cover every category: talks, workshops, social events, exhibitions, " +
			"outdoor activities, and live music alike.";
		return (
			`Search for ${cityCfg.name} events this week (${fmtDate(weekStart)} to ${fmtDate(weekEnd)}). ` +
			"Use web search on the sources listed in your instructions. " +
			"Skip anything matching the SKIP criteria. " +
			`${coverageNote} ` +
			"List every relevant event you find with full details and a direct URL. " +
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND"
		);
	}

	protected buildOpenSystem(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd } = opts;
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		// Interest profile + format rules first: that
		// block is byte-identical for every call (city/date included) sharing
		// the same prefix, which is what lets providers with automatic
		// prefix-based prompt caching (OpenAI, Gemini) actually hit cache
		// instead of re-paying full price on every tier.
		return (
			`${INTERESTS}\n\n${OUTPUT_FORMAT_RULES}\n\n` +
			`You are an events researcher for ${cityCfg.name}, Australia. ` +
			`Find in-person events for ${dateRange} matching the interests above. ` +
			"Search Eventbrite, Meetup, Humanitix, venue websites, community platforms, Facebook Events, and local guides."
		);
	}

	protected buildOpenUser(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd } = opts;
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		const coverageNote =
			"Cover every category: talks, workshops, social events, exhibitions, " +
			"outdoor activities, and live music alike.";
		return (
			`What in-person events are happening in ${cityCfg.name} from ${dateRange}? ` +
			"Search broadly. Prioritise intellectually stimulating, creative, and social or community-oriented events, but list every relevant in-person event you find. " +
			`${coverageNote} ` +
			"Include full details and a direct URL for each. " +
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND"
		);
	}

	protected buildTierSystem(opts: ProviderOptions): string {
		const { cityCfg, tier, weekStart, weekEnd } = opts;
		const cityName = cityCfg.name;
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		// Shared prefix first — identical across all three tiers for a given
		// tier — so automatic prefix-based prompt caching (OpenAI, Gemini)
		// actually hits on the 2nd/3rd tier call instead of re-paying full
		// price each time.
		const sharedPrefix = OUTPUT_FORMAT_RULES;

		if (tier === "aggregators") {
			return (
				`${sharedPrefix}\n\n` +
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find in-person events listed on event platforms for ${dateRange}.`
			);
		}
		if (tier === "institutions") {
			return (
				`${sharedPrefix}\n\n` +
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find in-person events at ${cityName}'s cultural institutions for ${dateRange}. ` +
				"Search their websites, event pages, and Eventbrite listings."
			);
		}
		if (tier === "independents") {
			return (
				`${sharedPrefix}\n\n` +
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find events at small, independent venues and community groups for ${dateRange}. ` +
				"These niche venues rarely appear on aggregators. " +
				"Search broadly for independent bookshops, small music venues, indie galleries, " +
				"makerspaces, philosophy groups, language exchanges, community bars and cafes with events."
			);
		}
		return this.buildOpenSystem(opts);
	}

	protected buildTierUser(opts: ProviderOptions): string {
		const { cityCfg, tier, weekStart, weekEnd } = opts;
		const cityName = cityCfg.name;
		const sources = llmSourceStrings(cityCfg, tier, opts.city);
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		const noEventsNote =
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND";
		const coverageNote =
			"Cover every category: talks, workshops, social events, exhibitions, " +
			"outdoor activities, and live music alike.";

		if (tier === "aggregators") {
			const names = sourceNames(sources);
			return (
				`What events are on in ${cityName} from ${dateRange}? ` +
				`Search these event listing platforms: ${names}. ` +
				`${coverageNote} ` +
				`List as many specific confirmed events as you can find. ${noEventsNote}`
			);
		}
		if (tier === "institutions") {
			const names = sourceNames(sources);
			return (
				`What events are happening at ${cityName} cultural venues for ${dateRange}? ` +
				`Venues to check include: ${names}. ` +
				`${coverageNote} ` +
				`List every event you find. ${noEventsNote}`
			);
		}
		if (tier === "independents") {
			const names = sourceNames(sources);
			return (
				`What events are happening at small, independent ${cityName} venues and community groups from ${dateRange}? ` +
				`Known venues to check include: ${names} — but also search for other independent venues and community events not on that list. ` +
				`${coverageNote} ` +
				`List every event you can find. ${noEventsNote}`
			);
		}
		return this.buildOpenUser(opts);
	}

	protected validateRaw(raw: string, label: string): void {
		if (/\bNO_EVENTS_FOUND\b/.test(raw)) {
			throw new Error(`[${label}] Provider found no events`);
		}
		if (raw.length < 100) {
			throw new Error(`[${label}] Response too short (${raw.length} chars)`);
		}
	}
}

/**
 * Runs `worker` over every item with at most `limit` in flight, preserving
 * input order in the result.
 *
 * Every LLM-backed pass in this pipeline wants the same shape: batch the work,
 * run the batches together rather than one at a time, but don't fan out
 * without a ceiling. A bare `Promise.all` over batches did the first two and
 * not the third — dedupe's pair classifier could open ~67 simultaneous Gemini
 * calls, which is how you collect 429s and pay for the retries. Serial loops
 * are the opposite failure: the probe's URL discovery took 28 minutes for work
 * that is entirely independent.
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await worker(items[i], i);
			}
		},
	);
	await Promise.all(runners);
	return results;
}
