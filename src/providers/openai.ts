import OpenAI from "openai";
import type { ProviderOptions, SearchResult, SourceResult } from "./base.ts";
import { BaseProvider } from "./base.ts";

export class OpenAIProvider extends BaseProvider {
	readonly name: string;
	readonly tiers: readonly string[] = [
		"aggregators",
		"institutions",
		"independents",
		"open",
	];
	protected client: OpenAI;
	protected readonly model: string;

	constructor(
		apiKey: string,
		model = "gpt-4o",
		name = "openai",
		baseURL?: string,
	) {
		super();
		this.name = name;
		this.model = model;
		this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { tier, focus } = opts;
		const tierKey = focus === "music" ? `${tier}-music` : tier;
		const label = `${this.name}/${tierKey}`;
		console.log(`  [${label}] Searching…`);

		const systemMsg =
			tier === "open" ? this.buildOpenSystem(opts) : this.buildTierSystem(opts);
		const userMsg =
			tier === "open" ? this.buildOpenUser(opts) : this.buildTierUser(opts);

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

		const events = await opts.curate(rawText, opts.cityCfg.name, label);
		return { events };
	}

	async findSources(cityName: string): Promise<SourceResult> {
		const label = this.name;
		console.log(`[${label}] Discovering event sources for ${cityName}…`);

		const response = await this.client.chat.completions.create({
			model: this.model,
			max_tokens: 4000,
			messages: [
				{ role: "system", content: this.buildFindSourcesSystem(cityName) },
				{ role: "user", content: this.buildFindSourcesUser(cityName) },
			],
		});

		const raw = response.choices[0]?.message?.content ?? "";
		return this.parseSourcesJson(raw, label);
	}
}
