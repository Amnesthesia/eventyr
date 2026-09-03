import Anthropic from "@anthropic-ai/sdk";
import { fmtDate, INTERESTS, llmSourceStrings } from "../common.ts";
import type { ProviderOptions, SearchResult } from "./base.ts";
import {
	BaseProvider,
	OUTPUT_FORMAT_RULES,
	TIER_INSTRUCTIONS,
} from "./base.ts";

// Kept on Sonnet 5 deliberately. The obvious cost lever — dropping to Haiku
// 4.5 at half the token rate — is the wrong one twice over: agentic web search
// is exactly where a small model degrades, and Haiku 4.5 predates 4.6 so it
// cannot use dynamic filtering at all (it would need
// allowed_callers: ["direct"], i.e. every raw search result back in context,
// which is where this provider's cost actually goes).
const SEARCH_MODEL = "claude-sonnet-5";
/**
 * Searches per tier. Web search bills $10 per 1,000 searches on top of tokens,
 * so 8 per tier across 3 tiers was $0.24 per city-week in search fees alone —
 * $37/year across three cities. Anthropic's own guidance is 1–3 searches for
 * simple lookups; four leaves room for a couple of retries on a tier.
 */
const MAX_WEB_SEARCHES = 4;

export class AnthropicProvider extends BaseProvider {
	readonly name = "anthropic";
	readonly tiers = ["aggregators", "institutions", "independents"] as const;
	private client: Anthropic;

	constructor(apiKey: string) {
		super();
		this.client = new Anthropic({ apiKey });
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { cityCfg, tier, weekStart, weekEnd } = opts;
		const cityName = cityCfg.name;
		const label = `anthropic/${tier}`;
		console.log(`  [${label}] Searching…`);

		const sources = llmSourceStrings(cityCfg, tier, opts.city);
		const sourceList = sources.map((s: string) => `  - ${s}`).join("\n");
		const tierInstruction = TIER_INSTRUCTIONS[tier] ?? "";
		const today = new Date();

		const system: Anthropic.TextBlockParam[] = [
			{
				type: "text",
				text:
					`The person you are researching events for has the following interests:\n${INTERESTS}\n\n` +
					`${OUTPUT_FORMAT_RULES}\n` +
					"Aim for at least 15 events.",
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
			// 4000 was truncating: two of three tiers hit max_tokens and one
			// returned nothing usable at all, so the cap was silently costing
			// events. Output is $10/1M here, so the extra headroom is worth a
			// fraction of a cent against losing a whole tier.
			max_tokens: 8000,
			tools: [
				{
					// Dynamic filtering: Claude writes code that filters search
					// results before they enter the context window, instead of
					// every raw result landing there. That context is what was
					// costing the money — ~63k cache-write tokens per tier call
					// at 1.25x the input rate, which dwarfed the search fees.
					//
					// Basic search, NOT the dynamic-filtering variant
					// (web_search_20260209). Dynamic filtering cut cost hard —
					// cache writes fell from ~63k to 5-11k tokens per tier —
					// but it returned NO_EVENTS_FOUND on every tier at both 4
					// and 8 searches: the filter code discards the listing
					// content this task needs. Measured, not assumed; do not
					// "optimise" back to it without re-checking event counts.
					type: "web_search_20250305" as const,
					name: "web_search",
					max_uses: MAX_WEB_SEARCHES,
				},
			],
			tool_choice: { type: "any" },
			system,
			messages: [{ role: "user", content: userMsg }],
		});

		// The authoritative billed count, rather than counting response blocks:
		// with dynamic filtering the searches are nested inside code execution
		// and response_inclusion hides them from the response entirely.
		const searchCalls =
			response.usage.server_tool_use?.web_search_requests ?? 0;
		const cacheRead = response.usage.cache_read_input_tokens ?? 0;
		const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
		console.log(
			`  [${label}] ${searchCalls} web search(es) | tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out | cache: ${cacheRead} read / ${cacheWrite} write`,
		);
		if (response.stop_reason === "max_tokens") {
			console.warn(
				`  ⚠ [${label}] response hit max_tokens — the event list is truncated`,
			);
		}

		const rawText = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("");

		this.validateRaw(rawText, label);

		const events = await opts.curate(rawText, opts.cityCfg.name, label);
		return { events };
	}
}
