import { fmtDate } from "../common.ts";
import type { ProviderOptions, SearchResult } from "./base.ts";
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

Search deeply across venue websites, local publications, Instagram-linked event pages, Facebook events, Eventbrite, Humanitix, council pages, and arts/community spaces.`;
	}

	override async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { cityCfg, weekStart, weekEnd, tier } = opts;
		const label = `${this.name}/${tier}`;
		console.log(`  [${label}] Searching…`);

		const systemMsg = this.buildPerplexitySystem(
			cityCfg.name,
			weekStart,
			weekEnd,
		);
		const userMsg =
			`Find events in ${cityCfg.name} between ${fmtDate(weekStart)} and ${fmtDate(weekEnd)}. ` +
			"Search deeply across all local sources. Return results as a compact JSON array with no whitespace between elements.";

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

		const events = await opts.curate(rawText, cityCfg.name, label);
		return { events };
	}
}
