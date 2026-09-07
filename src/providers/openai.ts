import OpenAI from "openai";
import type { ProviderOptions, SearchResult } from "./base.ts";
import { BaseProvider } from "./base.ts";
import { estimateUsd, recordUsage } from "./gemini.ts";

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
const MAX_TOOL_CALLS = 4;

function stripCitationNoise(text: string): string {
	return text
		.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "")
		.replace(/\?utm_source=openai/g, "")
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "");
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
		model = "gpt-5-mini",
		name = "openai",
		baseURL?: string,
	) {
		super();
		this.name = name;
		this.model = model;
		this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { tier } = opts;
		const label = `${this.name}/${tier}`;
		console.log(`  [${label}] Searching…`);

		const systemMsg =
			tier === "open" ? this.buildOpenSystem(opts) : this.buildTierSystem(opts);
		const userMsg =
			tier === "open" ? this.buildOpenUser(opts) : this.buildTierUser(opts);

		const response = !this.model.startsWith("gpt-5")
			? await this.client.chat.completions.create({
					model: this.model,
					max_tokens: 8000,
					messages: [
						{ role: "system", content: systemMsg },
						{ role: "user", content: userMsg },
					],
				})
			: await this.client.responses.create({
					model: this.model,
					// "low" context: the model reads a summary of each result rather
					// than the full page. This is a listing task — titles, dates,
					// venues, URLs — not one that needs the body of every hit.
					tools: [{ type: "web_search", search_context_size: "low" }],
					// Reasoning tokens are billed as output. Deciding which venue
					// page to open does not need a long think.
					reasoning: { effort: "low" },
					text: { verbosity: "low" },
					// 32000 was pure headroom for reasoning; the event list itself is
					// a few hundred tokens per tier.
					max_output_tokens: 8000,
					prompt_cache_key: PROMPT_CACHE_KEY,
					input: `${systemMsg}\n\n${userMsg}`,
					// The API takes max_tool_calls and echoes it back on the response
					// (it is typed on Response, not on the create params, in SDK
					// 6.38) — so it is passed through the cast rather than dropped.
					// It is the only ceiling on the search loop, i.e. on the bill.
					...({ max_tool_calls: MAX_TOOL_CALLS } as object),
				});

		if ("output" in response) {
			const searches = response.output.filter(
				(o) => o.type === "web_search_call",
			).length;
			const u = response.usage;
			const call = {
				calls: 1,
				promptTokens: u?.input_tokens ?? 0,
				cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0,
				outputTokens:
					(u?.output_tokens ?? 0) -
					(u?.output_tokens_details?.reasoning_tokens ?? 0),
				thoughtTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
				grounded: 1,
				searchQueries: searches,
			};
			recordUsage(`search/${this.name}`, {
				...call,
				estimatedUsd: estimateUsd(this.model, call),
			});
			console.log(
				`  [${label}] ${searches} web search(es) | tokens: ${call.promptTokens} in / ${call.outputTokens} out / ${call.thoughtTokens} reasoning`,
			);
		} else if (response.usage) {
			const call = {
				calls: 1,
				promptTokens: response.usage.prompt_tokens,
				outputTokens: response.usage.completion_tokens,
			};
			recordUsage(`search/${this.name}`, {
				...call,
				estimatedUsd: estimateUsd(this.model, call),
			});
		}

		if (
			"incomplete_details" in response &&
			response.incomplete_details?.reason === "max_output_tokens"
		) {
			console.error(`  ⚠ [${label}] response truncated at output token limit`);
		}

		const rawText =
			"output_text" in response
				? response.output_text
				: (response.choices[0]?.message?.content ?? "");
		if (process.env.DEBUG) console.debug(rawText);
		this.validateRaw(rawText, label);
		const events = await opts.curate(
			stripCitationNoise(rawText),
			opts.cityCfg.name,
			label,
		);
		return { events };
	}
}
