import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { CityConfig } from "../common.ts";
import {
	CATEGORIES,
	curatedPath,
	fmtDate,
	INTERESTS,
	PROJECT_ROOT,
	toISODate,
} from "../common.ts";

export interface SearchResult {
	events: Record<string, unknown>[];
}

export interface SourceResult {
	aggregators: string[];
	institutions: string[];
	independents: string[];
}

export type CurateFunction = (
	rawText: string,
	cityName: string,
	label: string,
) => Promise<Record<string, unknown>[]>;

export type SearchFocus = "general" | "music";

export interface ProviderOptions {
	cityCfg: CityConfig;
	tier: string;
	weekStart: Date;
	weekEnd: Date;
	curate: CurateFunction;
	focus: SearchFocus;
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

export const EXCLUDE_MUSIC_INSTRUCTION =
	"Do NOT include concerts, gigs, festivals, DJ nights, or any live-music events in this pass — " +
	"those are collected separately in a dedicated music search. Focus on everything else: talks, " +
	"workshops, social events, exhibitions, outdoor activities, and other non-music categories.";

export const MUSIC_ONLY_INSTRUCTION =
	"Focus ONLY on live music for this pass: concerts, gigs, festivals, DJ nights with live acts, " +
	"open mic music nights, classical/jazz/orchestral performances, and busking with scheduled sets. " +
	"Be exhaustive — list every live music event you can find, big or small, mainstream or niche. " +
	"The usual 'prefer smaller/niche over mainstream' guidance does NOT apply here — a touring act at " +
	"a major venue still counts. Aim for at least 15 music events.";

export function focusInstruction(focus: SearchFocus): string {
	return focus === "music" ? MUSIC_ONLY_INSTRUCTION : EXCLUDE_MUSIC_INSTRUCTION;
}

export function sourceNames(sources: string[]): string {
	return sources
		.map((s) => s.split("(")[0].trim().replace(/—\s*$/, "").trim())
		.join(", ");
}

export abstract class BaseProvider {
	abstract readonly name: string;
	abstract readonly tiers: readonly string[];
	abstract searchEvents(opts: ProviderOptions): Promise<SearchResult>;
	abstract findSources(cityName: string): Promise<SourceResult>;

	async collect(
		city: string,
		cityCfg: CityConfig,
		weekStart: Date,
		weekEnd: Date,
		force: boolean,
		curate: CurateFunction,
	): Promise<void> {
		for (const tier of this.tiers) {
			for (const focus of ["general", "music"] as const) {
				const tierKey = focus === "music" ? `${tier}-music` : tier;
				const outPath = curatedPath(city, this.name, tierKey);
				const label = `${this.name}/${tierKey}`;

				if (!force && existsSync(outPath)) {
					try {
						const payload = JSON.parse(
							readFileSync(outPath, "utf-8"),
						) as Record<string, unknown>;
						if (payload.week_start === toISODate(weekStart)) {
							console.log(`  → [${label}] Already collected — skipping`);
							continue;
						}
					} catch {
						// proceed with collection
					}
				}

				try {
					const opts: ProviderOptions = {
						cityCfg,
						tier,
						weekStart,
						weekEnd,
						curate,
						focus,
					};
					const { events } = await this.searchEvents(opts);
					const payload = {
						city_key: city,
						provider: this.name,
						tier: tierKey,
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
			}
		}
	}

	protected buildFormatSystem(cityName: string): string {
		return `You are a personal events curator for someone in ${cityName} with these interests:
${INTERESTS}

The user will give you raw event listings from a single search source.

Your job:
1. FILTER: Remove any sports, MLM, sales-pitch, or clearly irrelevant events.
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

	protected buildSearchSystem(opts: ProviderOptions): string {
		const { cityCfg, tier, weekStart, weekEnd, focus } = opts;
		const cityName = cityCfg.name;
		const sources = cityCfg.sources[tier as keyof CityConfig["sources"]] ?? [];
		const tierInstruction = TIER_INSTRUCTIONS[tier] ?? "";
		const sourceList = sources.map((s) => `  - ${s}`).join("\n");
		const today = new Date();

		return `You are an events researcher for ${cityName}. Today is ${today.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.
Your job is to find in-person events happening THIS WEEK in ${cityName}:
${fmtDate(weekStart)} to ${fmtDate(weekEnd)}.

The person receiving this digest has the following interests:
${INTERESTS}

Sources to search (${tier.toUpperCase()}):
${tierInstruction}

${sourceList}

For each event you find, note:
  - Event name
  - Date and time
  - Venue / location (suburb)
  - Ticket link or event page URL
  - Cost (free or price)
  - Category: one of ${JSON.stringify(CATEGORIES)}
  - Source website
  - Brief description of what the event is

Rules:
  - Only include events within ${fmtDate(weekStart)} – ${fmtDate(weekEnd)}.
  - Apply the SKIP rules above — do not list sports, MLM, or sales-pitch events.
  - Aim for at least 15 events.
  - Include the direct URL for every event you list.

${focusInstruction(focus)}`;
	}

	protected buildSearchUser(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd, focus } = opts;
		const focusNote =
			focus === "music"
				? "Search specifically for concerts, gigs, festivals, and live music."
				: "Skip concerts, gigs, and live music — those are handled in a separate search.";
		return (
			`Search for ${cityCfg.name} events this week (${fmtDate(weekStart)} to ${fmtDate(weekEnd)}). ` +
			"Use web search on the sources listed in your instructions. " +
			"Skip anything matching the SKIP criteria. " +
			`${focusNote} ` +
			"List every relevant event you find with full details and a direct URL. " +
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND"
		);
	}

	protected buildOpenSystem(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd, focus } = opts;
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		const outputRules =
			"For each event include: title, date and time, venue/location, " +
			"direct URL to the event page, cost (Free or ticket price), organiser. " +
			"Only include events with confirmed dates in that range. " +
			"Skip spectator sports, MLM events, corporate sales pitches, and online-only events.";
		return (
			`You are an events researcher for ${cityCfg.name}, Australia. ` +
			`Find in-person events for ${dateRange} matching these interests:\n${INTERESTS}\n` +
			"Search Eventbrite, Meetup, Humanitix, venue websites, community platforms, Facebook Events, and local guides. " +
			`${outputRules}\n\n${focusInstruction(focus)}`
		);
	}

	protected buildOpenUser(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd, focus } = opts;
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		const focusNote =
			focus === "music"
				? "Search specifically for concerts, gigs, festivals, and live music."
				: "Skip concerts, gigs, and live music — those are handled in a separate search.";
		return (
			`What in-person events are happening in ${cityCfg.name} from ${dateRange}? ` +
			"Search broadly. Prioritise intellectually stimulating, creative, and social or community-oriented events, but list every relevant in-person event you find. " +
			`${focusNote} ` +
			"Include full details and a direct URL for each. " +
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND"
		);
	}

	protected buildTierSystem(opts: ProviderOptions): string {
		const { cityCfg, tier, weekStart, weekEnd, focus } = opts;
		const cityName = cityCfg.name;
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		const outputRules =
			"For each event include: title, date and time, venue/location, " +
			"direct URL to the event page, cost (Free or ticket price), organiser. " +
			"Only include events with confirmed dates in that range. " +
			"Skip spectator sports, MLM events, corporate sales pitches, and online-only events.";
		const focusBlock = `\n\n${focusInstruction(focus)}`;

		if (tier === "aggregators") {
			return (
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find in-person events listed on event platforms for ${dateRange}. ${outputRules}${focusBlock}`
			);
		}
		if (tier === "institutions") {
			return (
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find in-person events at ${cityName}'s cultural institutions for ${dateRange}. ` +
				`Search their websites, event pages, and Eventbrite listings. ${outputRules}${focusBlock}`
			);
		}
		if (tier === "independents") {
			return (
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find events at small, independent venues and community groups for ${dateRange}. ` +
				"These niche venues rarely appear on aggregators. " +
				"Search broadly for independent bookshops, small music venues, indie galleries, " +
				`makerspaces, philosophy groups, language exchanges, community bars and cafes with events. ${outputRules}${focusBlock}`
			);
		}
		return this.buildOpenSystem(opts);
	}

	protected buildTierUser(opts: ProviderOptions): string {
		const { cityCfg, tier, weekStart, weekEnd, focus } = opts;
		const cityName = cityCfg.name;
		const sources = cityCfg.sources[tier as keyof CityConfig["sources"]] ?? [];
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		const noEventsNote =
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND";
		const focusNote =
			focus === "music"
				? "Search specifically for concerts, gigs, festivals, and live music."
				: "Skip concerts, gigs, and live music — those are handled in a separate search.";

		if (tier === "aggregators") {
			const names = sourceNames(sources);
			return (
				`What events are on in ${cityName} from ${dateRange}? ` +
				`Search these event listing platforms: ${names}. ` +
				`${focusNote} ` +
				`List as many specific confirmed events as you can find. ${noEventsNote}`
			);
		}
		if (tier === "institutions") {
			const names = sourceNames(sources);
			return (
				`What events are happening at ${cityName} cultural venues for ${dateRange}? ` +
				`Venues to check include: ${names}. ` +
				`${focusNote} ` +
				`List every event you find. ${noEventsNote}`
			);
		}
		if (tier === "independents") {
			const names = sourceNames(sources);
			return (
				`What events are happening at small, independent ${cityName} venues and community groups from ${dateRange}? ` +
				`Known venues to check include: ${names} — but also search for other independent venues and community events not on that list. ` +
				`${focusNote} ` +
				`List every event you can find. ${noEventsNote}`
			);
		}
		return this.buildOpenUser(opts);
	}

	protected buildFindSourcesSystem(cityName: string): string {
		return (
			`You are helping set up an automated weekly events digest for ${cityName}. ` +
			"Find the best websites for local in-person events and sort them into three tiers: " +
			"AGGREGATORS (Eventbrite/Meetup-type platforms that index many events), " +
			"INSTITUTIONS (universities, libraries, museums, galleries, theatres — each with unique programmes), " +
			"INDEPENDENTS (small venues, bookshops, makerspaces, community groups rarely listed by aggregators). " +
			'Return ONLY a JSON object: {"aggregators": [...], "institutions": [...], "independents": [...]}. ' +
			'Each entry format: "Source Name (domain.com)". No markdown, no explanation.'
		);
	}

	protected buildFindSourcesUser(cityName: string): string {
		return (
			`Find the best event discovery sources in ${cityName}. ` +
			"Search for current, active websites. " +
			"Return JSON with aggregators, institutions, and independents arrays."
		);
	}

	protected parseSourcesJson(raw: string, label: string): SourceResult {
		const cleaned = raw.replace(/```json|```/g, "").trim();
		const match = cleaned.match(/\{[\s\S]*\}/);
		if (!match) {
			throw new Error(
				`[${label}] No JSON in source discovery response. Raw: ${cleaned.slice(0, 300)}`,
			);
		}
		const parsed = JSON.parse(match[0]);
		for (const tier of [
			"aggregators",
			"institutions",
			"independents",
		] as const) {
			console.log(`[${label}] Found ${(parsed[tier] ?? []).length} ${tier}`);
		}
		return {
			aggregators: parsed.aggregators ?? [],
			institutions: parsed.institutions ?? [],
			independents: parsed.independents ?? [],
		};
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
