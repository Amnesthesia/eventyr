import OpenAI from "openai";
import type { ProviderOptions, SearchResult, SourceResult } from "./base.ts";
import { BaseProvider } from "./base.ts";

const PLAIN_TEXT_INSTRUCTION =
	"\n\nRespond in plain text only. No markdown tables, no headings, no " +
	"bracketed citation links like ([site](url)) — use bare URLs. One event " +
	"per line or short paragraph, using the fields above.";

function stripCitationNoise(text: string): string {
	return text
		.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "")
		.replace(/\?utm_source=openai/g, "");
}

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
		model = "gpt-5.6",
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

		const response = !this.model.startsWith("gpt-5") ? await this.client.chat.completions.create({
			model: this.model,
			max_tokens: 8000,
			messages: [
				{ role: "system", content: systemMsg },
				{ role: "user", content: userMsg },
			],
		})
			: await this.client.responses.create({
				model: "gpt-5.6",
				tools: [{ type: "web_search" }],
				max_output_tokens: 32000,
				input: systemMsg + PLAIN_TEXT_INSTRUCTION + "\n\n" + userMsg,
			});

		if (
			"incomplete_details" in response &&
			response.incomplete_details?.reason === "max_output_tokens"
		) {
			console.error(`  ⚠ [${label}] response truncated at output token limit`);
		}

		const rawText = 'output_text' in response ? response.output_text : response.choices[0]?.message?.content ?? "";
		if (process.env.DEBUG) console.debug(rawText);
		this.validateRaw(rawText, label);
		const events = await opts.curate(stripCitationNoise(rawText), opts.cityCfg.name, label);
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
