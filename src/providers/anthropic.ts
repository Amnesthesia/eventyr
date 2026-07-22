import Anthropic from "@anthropic-ai/sdk";
import { fmtDate, INTERESTS } from "../common.ts";
import type { ProviderOptions, SearchResult, SourceResult } from "./base.ts";
import {
	BaseProvider,
	focusInstruction,
	OUTPUT_FORMAT_RULES,
	TIER_INSTRUCTIONS,
} from "./base.ts";

const SEARCH_MODEL = "claude-sonnet-5";
const DISCOVERY_MODEL = "claude-opus-4-7";
const MAX_WEB_SEARCHES = 8;

export class AnthropicProvider extends BaseProvider {
	readonly name = "anthropic";
	readonly tiers = ["aggregators", "institutions", "independents"] as const;
	private client: Anthropic;

	constructor(apiKey: string) {
		super();
		this.client = new Anthropic({ apiKey });
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { cityCfg, tier, weekStart, weekEnd, focus } = opts;
		const cityName = cityCfg.name;
		const tierKey = focus === "music" ? `${tier}-music` : tier;
		const label = `anthropic/${tierKey}`;
		console.log(`  [${label}] Searching…`);

		const sources = cityCfg.sources[tier as keyof typeof cityCfg.sources] ?? [];
		const sourceList = sources.map((s) => `  - ${s}`).join("\n");
		const tierInstruction = TIER_INSTRUCTIONS[tier] ?? "";
		const today = new Date();

		const system: Anthropic.TextBlockParam[] = [
			{
				type: "text",
				text:
					`The person you are researching events for has the following interests:\n${INTERESTS}\n\n` +
					`${OUTPUT_FORMAT_RULES}\n` +
					"Aim for at least 15 events.\n\n" +
					focusInstruction(focus),
				cache_control: { type: "ephemeral" },
			},
			{
				type: "text",
				text:
					`You are an events researcher for ${cityName}. Today is ${today.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.\n` +
					`Your job is to find in-person events happening THIS WEEK in ${cityName}:\n` +
					`${fmtDate(weekStart)} to ${fmtDate(weekEnd)}.\n\n` +
					`Sources to search (${tier.toUpperCase()}):\n${tierInstruction}\n\n${sourceList}`,
			},
		];

		const userMsg = this.buildSearchUser(opts);

		const response = await this.client.messages.create({
			model: SEARCH_MODEL,
			max_tokens: 4000,
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
		const cacheRead = response.usage.cache_read_input_tokens ?? 0;
		const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
		console.log(
			`  [${label}] ${searchCalls} web search(es) | cache: ${cacheRead} read / ${cacheWrite} write`,
		);

		const rawText = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("");

		this.validateRaw(rawText, label);

		const events = await opts.curate(rawText, opts.cityCfg.name, label, focus);
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

Your response MUST be a single raw compact JSON object and NOTHING else — no preamble, no
explanation, no reasoning, no markdown, no code fences, no whitespace between elements.
Do not write any text before or after the JSON. Your entire response is the JSON object,
starting with { and ending with }.

The object has exactly three keys: "aggregators", "institutions", "independents".
Each key maps to an array of source description strings: "Source Name (url)".

Example (your full response should look exactly like this):
{"aggregators":["Eventbrite ${cityName} (eventbrite.com.au)"],"institutions":["State Library (slq.qld.gov.au)"],"independents":["Local Bookshop (bookshop.com.au/events)"]}`;

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
