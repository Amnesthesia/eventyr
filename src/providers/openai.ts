import OpenAI from "openai";
import type { ProviderOptions, SearchResult, SourceResult } from "./base.ts";
import { BaseProvider } from "./base.ts";

export class OpenAIProvider extends BaseProvider {
	readonly name: string;
	private client: OpenAI;
	private model: string;

	constructor(apiKey: string, baseURL: string, model: string, name: string) {
		super();
		this.name = name;
		this.model = model;
		this.client = new OpenAI({ apiKey, baseURL });
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { tier } = opts;
		const label = `${this.name}/${tier}`;
		console.log(`  [${label}] Searching…`);

		let systemMsg: string;
		let userMsg: string;

		if (tier === "open") {
			systemMsg = this.buildOpenSystem(opts);
			userMsg = this.buildOpenUser(opts);
		} else {
			systemMsg = this.buildTierSystem(opts);
			userMsg = this.buildTierUser(opts);
		}

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
		return { rawText };
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
