// Anthropic transport: maps AskOptions onto exactly the messages.create call
// the search provider made before 1.7 (verified by scripts/llm-parity.mjs,
// golden collect-anthropic), plus the Message Batches transport (D14).

import type Anthropic from "@anthropic-ai/sdk";
import type { BatchJobTransport, BatchOutcome } from "../batch.ts";
import { providerReplayLine } from "../replay.ts";
import type { AskOptions } from "../types.ts";
import { type ProviderResult, refuse, type Transport } from "./transport.ts";

/**
 * Basic search, NOT the dynamic-filtering variant (web_search_20260209).
 * Dynamic filtering cut cost hard — cache writes fell from ~63k to 5-11k
 * tokens per tier call — but returned NO_EVENTS_FOUND on every search tier:
 * the filter code discards the listing content the pipeline needs. Measured,
 * not assumed; do not "optimise" back to it without re-checking event counts.
 */
export const WEB_SEARCH_TOOL = "web_search_20250305";
/** The API requires max_tokens; callers that care pass maxOutputTokens. */
const DEFAULT_MAX_TOKENS = 4096;

/** The first system block carries the cache breakpoint (PLAN §2.4): the
 * stable prefix is what gets cached, the per-call blocks follow it. */
function systemBlocks(
	system: AskOptions["system"],
): Anthropic.TextBlockParam[] | undefined {
	if (system === undefined) return undefined;
	const [first, ...rest] = Array.isArray(system) ? system : [system];
	return [
		{ type: "text", text: first, cache_control: { type: "ephemeral" } },
		...rest.map((text): Anthropic.TextBlockParam => ({ type: "text", text })),
	];
}

export function anthropicParams(
	model: string,
	prompt: string,
	opts: AskOptions,
): Anthropic.MessageCreateParamsNonStreaming {
	// No JSON mode and no thinking mapping here: no caller needs them yet,
	// and a request missing what was asked for is worse than an error.
	refuse("anthropic", opts, ["json", "thinking", "temperature"]);
	const system = systemBlocks(opts.system);
	return {
		model,
		max_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
		...(opts.search
			? {
					tools: [
						{
							type: WEB_SEARCH_TOOL,
							name: "web_search",
							...(opts.maxSearches !== undefined
								? { max_uses: opts.maxSearches }
								: {}),
						},
					],
				}
			: {}),
		...(system ? { system } : {}),
		messages: [{ role: "user", content: prompt }],
		...opts.providerOptions,
	};
}

/** Text and usage out of one message, the fields the search provider
 * recorded: prompt tokens include the cache read, and the billed search count
 * comes from usage rather than from counting blocks (with dynamic filtering
 * the searches are nested and hidden). */
export function readAnthropicMessage(
	message: Anthropic.Message,
	search: boolean,
): ProviderResult {
	const u = message.usage;
	const cacheRead = u.cache_read_input_tokens ?? 0;
	return {
		text: message.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join(""),
		finishReason: message.stop_reason,
		usage: {
			promptTokens: u.input_tokens + cacheRead,
			cachedTokens: cacheRead,
			cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
			outputTokens: u.output_tokens,
			grounded: search ? 1 : 0,
			searchQueries: u.server_tool_use?.web_search_requests ?? 0,
		},
	};
}

export function anthropicTransport(client: () => Anthropic): Transport {
	return {
		provider: "anthropic",
		line: ({ stage, model, prompt, opts }) =>
			providerReplayLine(
				"anthropic",
				stage,
				anthropicParams(model, prompt, opts),
			),
		send: async ({ model, prompt, opts }) =>
			readAnthropicMessage(
				await client().messages.create(anthropicParams(model, prompt, opts)),
				opts.search === true,
			),
		replay: ({ opts }, canned) =>
			readAnthropicMessage(
				JSON.parse(canned) as Anthropic.Message,
				opts.search === true,
			),
	};
}

// --- Message Batches (D14) ------------------------------------------------
// platform.claude.com/docs/en/build-with-claude/batch-processing and the web
// search tool page (checked 2026-09-25): the web search tool is supported in
// batches at the same per-search price; tokens are 50% of standard.

/** The four calls this needs from `client.messages.batches`, so tests can
 * hand in recorded batches instead of a client. */
export interface AnthropicBatchClient {
	create(
		body: Anthropic.Messages.BatchCreateParams,
	): Promise<Anthropic.Messages.MessageBatch>;
	retrieve(id: string): Promise<Anthropic.Messages.MessageBatch>;
	results(
		id: string,
	): Promise<AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>>;
	cancel(id: string): Promise<Anthropic.Messages.MessageBatch>;
}

export function anthropicBatchTransport(
	client: AnthropicBatchClient,
	requests: Anthropic.MessageCreateParamsNonStreaming[],
	search: boolean,
	sleep: (ms: number) => Promise<void>,
	pollMs: number,
): BatchJobTransport {
	const collect = async (id: string): Promise<BatchOutcome> => {
		const results: BatchOutcome["results"] = requests.map(() => undefined);
		for await (const item of await client.results(id)) {
			const i = Number(item.custom_id);
			const r = item.result;
			results[i] =
				r.type === "succeeded"
					? readAnthropicMessage(r.message, search)
					: {
							error:
								r.type === "errored"
									? ((r.error.error as { message?: string }).message ??
										r.error.type)
									: r.type,
						};
		}
		return { ok: true, results };
	};
	return {
		submit: async () =>
			(
				await client.create({
					requests: requests.map((params, i) => ({
						custom_id: String(i),
						params,
					})),
				})
			).id,
		poll: async (id) =>
			(await client.retrieve(id)).processing_status === "ended"
				? collect(id)
				: null,
		cancel: async (id) => {
			// Cancelling is asynchronous: results are readable once the batch
			// has ended, and requests still in flight then end as "canceled".
			let batch = await client.cancel(id);
			while (batch.processing_status !== "ended") {
				await sleep(pollMs);
				batch = await client.retrieve(id);
			}
			return collect(id);
		},
	};
}
