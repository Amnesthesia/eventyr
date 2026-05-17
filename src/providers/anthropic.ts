import Anthropic from "@anthropic-ai/sdk";
import type { ProviderOptions, SearchResult, SourceResult } from "./base.ts";
import { BaseProvider } from "./base.ts";

const SEARCH_MODEL = "claude-sonnet-4-6";
const DISCOVERY_MODEL = "claude-opus-4-7";
const MAX_WEB_SEARCHES = 12;

export class AnthropicProvider extends BaseProvider {
	readonly name = "anthropic";
	readonly tiers = ["aggregators", "institutions", "independents"] as const;
	private client: Anthropic;

	constructor(apiKey: string) {
		super();
		this.client = new Anthropic({ apiKey });
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { tier } = opts;
		const label = `anthropic/${tier}`;
		console.log(`  [${label}] Searching…`);

		const system = this.buildSearchSystem(opts);
		const userMsg = this.buildSearchUser(opts);

		const response = await this.client.messages.create({
			model: SEARCH_MODEL,
			max_tokens: 8000,
			tools: [
				{
					type: "web_search_20250305" as const,
					name: "web_search",
					max_uses: MAX_WEB_SEARCHES,
				},
			],
			tool_choice: { type: "any" },
			system,
			messages: [{ role: "user", content: userMsg }],
		});

		const searchCalls = response.content.filter(
			(b) => b.type === "server_tool_use",
		).length;
		console.log(`  [${label}] ${searchCalls} web search(es)`);

		const rawText = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("");

		this.validateRaw(rawText, label);

		const events = await opts.curate(rawText, opts.cityCfg.name, label);
		return { events };
	}

	async findSources(cityName: string): Promise<SourceResult> {
		const label = "anthropic";
		console.log(`[${label}] Discovering event sources for ${cityName}…`);

		const systemPrompt = `You are helping set up an automated weekly events digest for ${cityName}.

Find the best websites to search for local in-person events in this city and
sort them into three tiers:

AGGREGATORS — platforms that index events from many sources (duplicates across
  aggregators are expected). Examples: Eventbrite, Eventfinda, Meetup, Humanitix,
  local event guides (Broadsheet, Urban List, WeekendNotes, Must Do, Fever), tourism
  portals (Visit X), local community diary sites.

INSTITUTIONS — organisations that run their own independent event programmes; each
  has unique events not listed elsewhere. Examples: city/council events pages,
  state libraries, universities, major museums, galleries, concert halls, theatres,
  performing arts companies.

INDEPENDENTS — niche, community-facing venues and groups whose events rarely appear
  in aggregators. Examples: independent bookshops with events, small music venues,
  indie galleries, hackerspaces/makerspaces, board-game communities, philosophy
  groups, language exchange groups, creative spaces, bars/cafes with regular events.

Your response MUST be a single raw JSON object and NOTHING else — no preamble, no
explanation, no reasoning, no markdown, no code fences. Do not write any text before
or after the JSON. Your entire response is the JSON object, starting with { and
ending with }.

The object has exactly three keys: "aggregators", "institutions", "independents".
Each key maps to an array of source description strings: "Source Name (url)".

Example (your full response should look exactly like this):
{
  "aggregators":  ["Eventbrite ${cityName} (eventbrite.com.au)", ...],
  "institutions": ["State Library (slq.qld.gov.au)", ...],
  "independents": ["Local Bookshop (bookshop.com.au/events)", ...]
}`;

		const response = await this.client.messages.create({
			model: DISCOVERY_MODEL,
			max_tokens: 16000,
			tools: [
				{
					type: "web_search_20250305" as const,
					name: "web_search",
					max_uses: 20,
				},
			],
			system: systemPrompt,
			messages: [
				{
					role: "user",
					content:
						`Find all the best event sources for ${cityName}, sorted into the three ` +
						"tiers described in your instructions. Search the web to find accurate, " +
						"current URLs. Return a JSON object with aggregators, institutions, and independents.",
				},
			],
		});

		const searches = response.content.filter(
			(b) => b.type === "server_tool_use",
		).length;
		console.log(`[${label}] ${searches} web search(es)`);

		const raw = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("");

		return this.parseSourcesJson(raw, label);
	}
}
