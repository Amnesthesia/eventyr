// Perplexity transport: the openai SDK against api.perplexity.ai, chat
// completions only, every call grounded (golden collect-perplexity). No batch
// API exists, so batch is refused in client.ts.

import type OpenAI from "openai";
import { providerReplayLine } from "../replay.ts";
import type { AskOptions } from "../types.ts";
import { openaiParams, readChatCompletion } from "./openai.ts";
import { type ProviderResult, refuse, type Transport } from "./transport.ts";

export const PERPLEXITY_BASE_URL = "https://api.perplexity.ai";

export function perplexityParams(
	model: string,
	prompt: string,
	opts: AskOptions,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
	// Search is always on, so `search` is neither needed nor refused; JSON
	// mode here is a json_schema response_format no caller needs yet.
	refuse("perplexity", opts, ["json", "thinking", "maxSearches"]);
	const request = openaiParams(model, prompt, { ...opts, search: undefined });
	if (request.api !== "chat")
		throw new Error(`perplexity: ${model} is not a chat model`);
	return request.params;
}

/** Perplexity bills one request fee per call, not per query it ran. */
export function readPerplexityCompletion(
	completion: OpenAI.Chat.ChatCompletion,
): ProviderResult {
	const result = readChatCompletion(completion);
	return {
		...result,
		usage: { ...result.usage, grounded: 1, searchQueries: 1 },
	};
}

export function perplexityTransport(client: () => OpenAI): Transport {
	return {
		provider: "perplexity",
		line: ({ stage, model, prompt, opts }) =>
			providerReplayLine(
				"perplexity",
				stage,
				perplexityParams(model, prompt, opts),
			),
		send: async ({ model, prompt, opts }) =>
			readPerplexityCompletion(
				await client().chat.completions.create(
					perplexityParams(model, prompt, opts),
				),
			),
		replay: (_ctx, canned) =>
			readPerplexityCompletion(
				JSON.parse(canned) as OpenAI.Chat.ChatCompletion,
			),
	};
}
