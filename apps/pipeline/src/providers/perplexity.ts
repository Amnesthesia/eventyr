import { askDetailed } from "@dothingslol/llm";
import { fmtDate } from "../config/week.js";
import type { ProviderOptions, SearchResult } from "./base.ts";
import { BaseProvider } from "./base.ts";

export class PerplexityProvider extends BaseProvider {
	readonly name = "perplexity";
	readonly tiers = ["open"] as const;

	private buildPerplexitySystem(
		cityName: string,
		weekStart: Date,
		weekEnd: Date,
		timeZone: string,
	): string {
		return `You are building a structured database of real local events.

Find events occurring in ${cityName} between ${fmtDate(weekStart, timeZone)} and ${fmtDate(weekEnd, timeZone)}.

Prioritize:
- niche or high quality events
- galleries
- live music
- workshops
- talks
- social events
- university/community events
- boutique venues
- recurring local scenes

Avoid:
- generic SEO listicles
- old events
- duplicate listings
- nationwide event directories unless necessary

Return a compact JSON array (no whitespace between elements):
[{"title":"","date":"","venue":"","suburb":"","category":"","description":"","source_url":"","confidence":0}]

Search deeply across venue websites, local publications, Instagram-linked event pages, Facebook events, Eventbrite, Humanitix, council pages, and arts/community spaces.

This is a fully automated pipeline with no human able to read or reply to your response — return only the JSON array, never an offer, question, or list of options. If there's a more complete or exhaustive version of the answer, just do it and include it directly instead of asking permission.
`;
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { cityCfg, weekStart, weekEnd, tier } = opts;
		const label = `${this.name}/${tier}`;
		console.log(`  [${label}] Searching…`);

		const systemMsg = this.buildPerplexitySystem(
			cityCfg.name,
			weekStart,
			weekEnd,
			cityCfg.timezone,
		);
		const focusNote =
			"Cover every category — talks, workshops, social events, exhibitions, " +
			"outdoor activities, and live music alike.";
		const userMsg =
			`Find events in ${cityCfg.name} between ${fmtDate(weekStart, cityCfg.timezone)} and ${fmtDate(weekEnd, cityCfg.timezone)}. ` +
			`Search deeply across all local sources. ${focusNote} ` +
			"Return results as a compact JSON array with no whitespace between elements.";

		const response = await askDetailed(userMsg, {
			provider: "perplexity",
			model: "sonar-pro",
			stage: "search/perplexity",
			system: systemMsg,
			maxOutputTokens: 8000,
		});

		const rawText = response.text;
		this.validateRaw(rawText, label);
		console.log(`  [${label}] ${rawText.length} chars received`);

		const events = await opts.curate(rawText, cityCfg.name, label);
		return { events };
	}
}
