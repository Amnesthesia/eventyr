import { fmtDate } from "../common.ts";
import type { ProviderOptions, SearchFocus, SearchResult } from "./base.ts";
import { focusInstruction } from "./base.ts";
import { OpenAIProvider } from "./openai.ts";

export class PerplexityProvider extends OpenAIProvider {
	override readonly name = "perplexity";
	override readonly tiers = ["open"] as const;

	constructor(apiKey: string) {
		super(apiKey, "sonar-pro", "perplexity", "https://api.perplexity.ai");
	}

	private buildPerplexitySystem(
		cityName: string,
		weekStart: Date,
		weekEnd: Date,
		focus: SearchFocus,
	): string {
		return `You are building a structured database of real local events.

Find events occurring in ${cityName} between ${fmtDate(weekStart)} and ${fmtDate(weekEnd)}.

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

${focusInstruction(focus)}`;
	}

	override async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { cityCfg, weekStart, weekEnd, tier, focus } = opts;
		const tierKey = focus === "music" ? `${tier}-music` : tier;
		const label = `${this.name}/${tierKey}`;
		console.log(`  [${label}] Searching…`);

		const systemMsg = this.buildPerplexitySystem(
			cityCfg.name,
			weekStart,
			weekEnd,
			focus,
		);
		const focusNote =
			focus === "music"
				? "Search specifically for concerts, gigs, festivals, and live music."
				: "Skip concerts, gigs, and live music — those are handled in a separate search.";
		const userMsg =
			`Find events in ${cityCfg.name} between ${fmtDate(weekStart)} and ${fmtDate(weekEnd)}. ` +
			`Search deeply across all local sources. ${focusNote} ` +
			"Return results as a compact JSON array with no whitespace between elements.";

		const response = await this.client.chat.completions.create({
			model: this.model,
			max_tokens: 8000,
			messages: [
				{ role: "system", content: systemMsg },
				{ role: "user", content: userMsg },
			],
		});

		const rawText = response.choices[0]?.message?.content ?? "";
		this.validateRaw(rawText, label);
		console.log(`  [${label}] ${rawText.length} chars received`);

		const events = await opts.curate(rawText, cityCfg.name, label, focus);
		return { events };
	}
}
