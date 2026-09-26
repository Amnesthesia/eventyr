import { askDetailed, type OpenAIModel } from "@dothingslol/llm";
import { loadPipelineConfig } from "../config/load.js";
import type { ProviderOptions, SearchResult } from "./base.ts";

import { BaseProvider } from "./base.ts";

// Static key groups every search call into the same cache bucket — combined
// with base.ts fronting each system prompt with a byte-identical shared
// prefix, this is what lets OpenAI's automatic prompt caching actually hit.
const PROMPT_CACHE_KEY = "eventyr-events-search";

/**
 * Built-in tool calls per response. Web search bills per call and every
 * result set lands in context as input tokens on every later iteration, so an
 * uncapped agentic loop is an uncapped bill — this ran with no ceiling at all,
 * which is what made the provider look "too expensive to keep on".
 */

// gpt-5-mini by default (config/pipeline.yml models.search.openai); anything
// not gpt-5* goes through chat.completions without web search (see
// searchEvents).
function searchModel(): OpenAIModel {
	return loadPipelineConfig().models.search.openai.model as OpenAIModel;
}

function stripCitationNoise(text: string): string {
	return text
		.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "")
		.replace(/\?utm_source=openai/g, "")
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "");
}

export class OpenAIProvider extends BaseProvider {
	readonly name = "openai";
	readonly tiers = [
		"aggregators",
		"institutions",
		"independents",
		"open",
	] as const;

	constructor(
		private readonly model: OpenAIModel = searchModel(),
		private readonly debug = false,
	) {
		super();
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { tier } = opts;
		const label = `${this.name}/${tier}`;
		console.log(`  [${label}] Searching…`);

		const systemMsg =
			tier === "open" ? this.buildOpenSystem(opts) : this.buildTierSystem(opts);
		const userMsg =
			tier === "open" ? this.buildOpenUser(opts) : this.buildTierUser(opts);

		// Only gpt-5* models have the web_search tool (Responses API); the
		// transport makes the same split and refuses search on the rest.
		const canSearch = this.model.startsWith("gpt-5");
		const response = await askDetailed(userMsg, {
			provider: "openai",
			model: this.model,
			stage: `search/${this.name}`,
			system: systemMsg,
			maxOutputTokens: 8000,
			...(canSearch
				? {
						search: true,
						// Reasoning tokens are billed as output. Deciding which
						// venue page to open does not need a long think.
						thinking: "low" as const,
						// The only ceiling on the search loop, i.e. on the bill.
						maxSearches:
							loadPipelineConfig().stages.collect.openai.maxToolCalls,
						providerOptions: {
							text: { verbosity: "low" },
							prompt_cache_key: PROMPT_CACHE_KEY,
						},
					}
				: {}),
		});

		if (canSearch) {
			const u = response.usage;
			console.log(
				`  [${label}] ${u.searchQueries} web search(es) | tokens: ${u.inputTokens} in / ${u.outputTokens} out / ${u.thoughtTokens} reasoning`,
			);
		}
		if (response.finishReason === "max_output_tokens") {
			console.error(`  ⚠ [${label}] response truncated at output token limit`);
		}

		const rawText = response.text;
		if (this.debug) console.debug(rawText);
		this.validateRaw(rawText, label);
		const events = await opts.curate(
			stripCitationNoise(rawText),
			opts.cityCfg.name,
			label,
		);
		return { events };
	}
}
