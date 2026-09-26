import { askDetailed } from "@dothingslol/llm";
import { fmtDate, INTERESTS, llmSourceStrings } from "../common.ts";
import type { ProviderOptions, SearchResult } from "./base.ts";
import {
	BaseProvider,
	OUTPUT_FORMAT_RULES,
	searchModel,
	TIER_INSTRUCTIONS,
} from "./base.ts";

// Sonnet 5 by default. Haiku 4.5 is half the token rate but agentic web search
// is where a small model degrades most, so it is an experiment to run against
// the usage file's unique-events-per-provider count, not a default:
//   ANTHROPIC_SEARCH_MODEL=claude-haiku-4-5
// (The earlier objection — Haiku cannot use the dynamic-filtering tool — is
// moot: that tool variant returned NO_EVENTS_FOUND on every tier and is not
// used. See the tool comment below.)
const SEARCH_MODEL = searchModel(
	"anthropic",
	"ANTHROPIC_SEARCH_MODEL",
	"claude-sonnet-5",
);
/**
 * Searches per tier. This is the whole cost of the provider: each search's raw
 * results (~15k tokens) are cache-written at 1.25× input, plus $10 per 1,000
 * searches — about $0.06 per search on Sonnet 5, and nothing else in the call
 * comes close. Anthropic's own guidance is 1–3 searches for lookups like this.
 */
export const MAX_WEB_SEARCHES = 3;

export class AnthropicProvider extends BaseProvider {
	readonly name = "anthropic";
	readonly tiers = ["aggregators", "institutions", "independents"] as const;

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { cityCfg, tier, weekStart, weekEnd } = opts;
		const cityName = cityCfg.name;
		const label = `anthropic/${tier}`;
		console.log(`  [${label}] Searching…`);

		const sources = llmSourceStrings(cityCfg, tier, opts.city);
		const sourceList = sources.map((s) => `  - ${s.text}`).join("\n");
		// Pinned sources (SourceEntry.pin) keep their place regardless of recent
		// yield — see llmSourceStrings/sourceEarnsPlace — so they get a firmer
		// instruction than the rest of this bullet list, which is a steer only.
		const pinnedNames = sources
			.filter((s) => s.pinned)
			.map((s) => s.text.split("(")[0].trim());
		const pinnedNote = pinnedNames.length
			? `\n\nAlways check these directly and include every confirmed event this week, even a single show: ${pinnedNames.join(", ")}.`
			: "";
		const tierInstruction = TIER_INSTRUCTIONS[tier] ?? "";
		const today = new Date();

		// Two system blocks: the stable prefix (interests, format rules) is
		// the cached one; the city/date/source block varies per call.
		const system = [
			`The person you are researching events for has the following interests:\n${INTERESTS}\n\n` +
				`${OUTPUT_FORMAT_RULES}\n` +
				"Aim for at least 15 events.",
			`You are an events researcher for ${cityName}. Today is ${today.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: cityCfg.timezone })}.\n` +
				`Your job is to find in-person events happening THIS WEEK in ${cityName}:\n` +
				`${fmtDate(weekStart, cityCfg.timezone)} to ${fmtDate(weekEnd, cityCfg.timezone)}.\n\n` +
				`Sources to search (${tier.toUpperCase()}):\n${tierInstruction}\n\n${sourceList}${pinnedNote}`,
		];

		const userMsg = this.buildSearchUser(opts);

		const response = await askDetailed(userMsg, {
			provider: "anthropic",
			model: SEARCH_MODEL,
			stage: "search/anthropic",
			system,
			// 4000 was truncating: two of three tiers hit max_tokens and one
			// returned nothing usable at all, so the cap was silently costing
			// events. Output is $10/1M here, so the extra headroom is worth a
			// fraction of a cent against losing a whole tier.
			maxOutputTokens: 8000,
			// Basic search (web_search_20250305), not dynamic filtering — the
			// transport's tool comment records why.
			search: true,
			maxSearches: MAX_WEB_SEARCHES,
			providerOptions: { tool_choice: { type: "any" } },
		});

		const u = response.usage;
		console.log(
			`  [${label}] ${u.searchQueries} web search(es) | tokens: ${u.inputTokens - u.cachedInputTokens} in / ${u.outputTokens} out | cache: ${u.cachedInputTokens} read / ${u.cacheWriteTokens} write`,
		);
		if (response.finishReason === "max_tokens") {
			console.warn(
				`  ⚠ [${label}] response hit max_tokens — the event list is truncated`,
			);
		}

		const rawText = response.text;
		this.validateRaw(rawText, label);

		const events = await opts.curate(rawText, opts.cityCfg.name, label);
		return { events };
	}
}
