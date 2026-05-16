import type { CityConfig } from "../common.ts";
import { CATEGORIES, fmtDate, INTERESTS } from "../common.ts";

export interface SearchResult {
	rawText: string;
}

export interface SourceResult {
	aggregators: string[];
	institutions: string[];
	independents: string[];
}

export interface ProviderOptions {
	cityCfg: CityConfig;
	tier: string;
	weekStart: Date;
	weekEnd: Date;
}

const TIER_INSTRUCTIONS: Record<string, string> = {
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

export function sourceNames(sources: string[]): string {
	return sources
		.map((s) => s.split("(")[0].trim().replace(/—\s*$/, "").trim())
		.join(", ");
}

export abstract class BaseProvider {
	abstract readonly name: string;
	abstract searchEvents(opts: ProviderOptions): Promise<SearchResult>;
	abstract findSources(cityName: string): Promise<SourceResult>;

	protected buildSearchSystem(opts: ProviderOptions): string {
		const { cityCfg, tier, weekStart, weekEnd } = opts;
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
  - Include the direct URL for every event you list.`;
	}

	protected buildSearchUser(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd } = opts;
		return (
			`Search for ${cityCfg.name} events this week (${fmtDate(weekStart)} to ${fmtDate(weekEnd)}). ` +
			"Use web search on the sources listed in your instructions. " +
			"Skip anything matching the SKIP criteria. " +
			"List every relevant event you find with full details and a direct URL. " +
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND"
		);
	}

	protected buildOpenSystem(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd } = opts;
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
			outputRules
		);
	}

	protected buildOpenUser(opts: ProviderOptions): string {
		const { cityCfg, weekStart, weekEnd } = opts;
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		return (
			`What interesting in-person events are happening in ${cityCfg.name} from ${dateRange}? ` +
			"Search broadly and focus on intellectually stimulating, creative, and community-oriented events. " +
			"List every relevant confirmed event with full details and a direct URL. " +
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND"
		);
	}

	protected buildTierSystem(opts: ProviderOptions): string {
		const { cityCfg, tier, weekStart, weekEnd } = opts;
		const cityName = cityCfg.name;
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		const outputRules =
			"For each event include: title, date and time, venue/location, " +
			"direct URL to the event page, cost (Free or ticket price), organiser. " +
			"Only include events with confirmed dates in that range. " +
			"Skip spectator sports, MLM events, corporate sales pitches, and online-only events.";

		if (tier === "aggregators") {
			return (
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find in-person events listed on event platforms for ${dateRange}. ${outputRules}`
			);
		}
		if (tier === "institutions") {
			return (
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find publicly announced in-person events at ${cityName}'s cultural institutions for ${dateRange}. ` +
				"These venues publish individual event announcements, Eventbrite listings, and press releases — " +
				`search for those rather than trying to navigate calendar pages. ${outputRules}`
			);
		}
		if (tier === "independents") {
			return (
				`You are an events researcher for ${cityName}, Australia. ` +
				`Find events at small, independent venues and community groups for ${dateRange}. ` +
				"These niche venues rarely appear on aggregators. " +
				"Search broadly for independent bookshops, small music venues, indie galleries, " +
				`makerspaces, philosophy groups, language exchanges, community bars and cafes with events. ${outputRules}`
			);
		}
		return this.buildOpenSystem(opts);
	}

	protected buildTierUser(opts: ProviderOptions): string {
		const { cityCfg, tier, weekStart, weekEnd } = opts;
		const cityName = cityCfg.name;
		const sources = cityCfg.sources[tier as keyof CityConfig["sources"]] ?? [];
		const dateRange = `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`;
		const noEventsNote =
			"If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND";

		if (tier === "aggregators") {
			const names = sourceNames(sources);
			return (
				`What events are on in ${cityName} from ${dateRange}? ` +
				`Search these event listing platforms: ${names}. ` +
				`List as many specific confirmed events as you can find. ${noEventsNote}`
			);
		}
		if (tier === "institutions") {
			const topNames = sourceNames(sources.slice(0, 8));
			return (
				`What events have been announced at ${cityName} cultural venues for ${dateRange}? ` +
				"Focus on theatres, galleries, museums, libraries, and universities. " +
				`Key venues include: ${topNames}. ` +
				"Search for publicly announced performances, exhibitions, lectures, and public programmes. " +
				`List every event you find. ${noEventsNote}`
			);
		}
		if (tier === "independents") {
			const names = sourceNames(sources);
			return (
				`What events are happening at small, independent ${cityName} venues and community groups from ${dateRange}? ` +
				`Known venues to check include: ${names} — but also search for other independent venues and community events not on that list. ` +
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
