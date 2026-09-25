// OpenAI transport: gpt-5* models go through the Responses API (the only one
// with the web_search tool), anything else through chat.completions — the
// same branch the search provider had before 1.7 (goldens collect-openai and
// collect-openai-chat). Plus the Batch API transport (D14).

import type OpenAI from "openai";
import { toFile, type Uploadable } from "openai";
import type { BatchJobTransport, BatchOutcome } from "../batch.ts";
import { BatchNotSupportedError } from "../errors.ts";
import { providerReplayLine } from "../replay.ts";
import type { AskOptions } from "../types.ts";
import {
	type ProviderResult,
	refuse,
	systemText,
	type Transport,
} from "./transport.ts";

export type OpenAIRequest =
	| {
			api: "responses";
			params: OpenAI.Responses.ResponseCreateParamsNonStreaming;
	  }
	| { api: "chat"; params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming };

export function usesResponsesApi(model: string): boolean {
	return model.startsWith("gpt-5");
}

function effort(opts: AskOptions): "low" | undefined {
	if (opts.thinking === "off")
		throw new Error('openai: thinking cannot be turned off; use "low"');
	return opts.thinking === "low" ? "low" : undefined;
}

export function openaiParams(
	model: string,
	prompt: string,
	opts: AskOptions,
): OpenAIRequest {
	const system = systemText(opts.system);
	if (!usesResponsesApi(model)) {
		// chat.completions has no web_search tool.
		refuse("openai", opts, ["search", "maxSearches"]);
		const reasoning = effort(opts);
		return {
			api: "chat",
			params: {
				model,
				...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
				messages: [
					...(system ? [{ role: "system" as const, content: system }] : []),
					{ role: "user", content: prompt },
				],
				...(reasoning ? { reasoning_effort: reasoning } : {}),
				...(opts.json ? { response_format: { type: "json_object" } } : {}),
				...(opts.temperature !== undefined
					? { temperature: opts.temperature }
					: {}),
				...opts.providerOptions,
			},
		};
	}
	const reasoning = effort(opts);
	return {
		api: "responses",
		params: {
			model,
			// "low" context: the model reads a summary of each result rather
			// than the full page — a listing task needs titles, dates, venues
			// and URLs, not the body of every hit.
			...(opts.search
				? { tools: [{ type: "web_search", search_context_size: "low" }] }
				: {}),
			...(reasoning ? { reasoning: { effort: reasoning } } : {}),
			...(opts.maxOutputTokens
				? { max_output_tokens: opts.maxOutputTokens }
				: {}),
			// The system prompt is joined into `input` rather than sent as
			// `instructions`: that is the request the goldens pin, and the
			// automatic prefix cache keys on it.
			input: system ? `${system}\n\n${prompt}` : prompt,
			...(opts.maxSearches !== undefined
				? { max_tool_calls: opts.maxSearches }
				: {}),
			...(opts.json ? { text: { format: { type: "json_object" } } } : {}),
			...(opts.temperature !== undefined
				? { temperature: opts.temperature }
				: {}),
			...opts.providerOptions,
		},
	};
}

/** Reasoning tokens are billed as output but reported apart, so the
 * `outputTokens` here is the visible answer only (as before 1.7). */
export function readOpenAIResponse(
	response: OpenAI.Responses.Response,
	search: boolean,
): ProviderResult {
	const u = response.usage;
	const reasoning = u?.output_tokens_details?.reasoning_tokens ?? 0;
	return {
		text: response.output
			.filter((o) => o.type === "message")
			.flatMap((o) => o.content)
			.filter((c) => c.type === "output_text")
			.map((c) => c.text)
			.join(""),
		finishReason:
			response.incomplete_details?.reason ?? response.status ?? null,
		usage: {
			promptTokens: u?.input_tokens ?? 0,
			cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0,
			outputTokens: (u?.output_tokens ?? 0) - reasoning,
			thoughtTokens: reasoning,
			grounded: search ? 1 : 0,
			searchQueries: response.output.filter((o) => o.type === "web_search_call")
				.length,
		},
	};
}

export function readChatCompletion(
	completion: OpenAI.Chat.ChatCompletion,
): ProviderResult {
	return {
		text: completion.choices[0]?.message?.content ?? "",
		finishReason: completion.choices[0]?.finish_reason ?? null,
		usage: {
			promptTokens: completion.usage?.prompt_tokens ?? 0,
			outputTokens: completion.usage?.completion_tokens ?? 0,
		},
	};
}

function read(
	request: OpenAIRequest["api"],
	raw: unknown,
	search: boolean,
): ProviderResult {
	return request === "responses"
		? readOpenAIResponse(raw as OpenAI.Responses.Response, search)
		: readChatCompletion(raw as OpenAI.Chat.ChatCompletion);
}

export function openaiTransport(client: () => OpenAI): Transport {
	return {
		provider: "openai",
		line: ({ stage, model, prompt, opts }) =>
			providerReplayLine(
				"openai",
				stage,
				openaiParams(model, prompt, opts).params,
			),
		send: async ({ model, prompt, opts }) => {
			const request = openaiParams(model, prompt, opts);
			const raw =
				request.api === "responses"
					? await client().responses.create(request.params)
					: await client().chat.completions.create(request.params);
			return read(request.api, raw, opts.search === true);
		},
		replay: ({ model, prompt, opts }, canned) =>
			read(
				openaiParams(model, prompt, opts).api,
				JSON.parse(canned),
				opts.search === true,
			),
	};
}

// --- Batch API (D14) --------------------------------------------------------
// developers.openai.com/api/docs/guides/batch (checked 2026-09-25): a JSONL
// upload, one line per request, against /v1/responses or /v1/chat/completions
// to match the sync branch; results are a JSONL file keyed by custom_id;
// tokens at 50% of standard. The guide says nothing about the web_search tool
// inside a batch, so search is refused rather than sent unverified.

/** The calls this needs from an OpenAI client, so tests can hand in recorded
 * batches instead of a client. */
export interface OpenAIBatchClient {
	files: {
		create(body: {
			file: Uploadable;
			purpose: "batch";
		}): Promise<{ id: string }>;
		content(id: string): Promise<{ text(): Promise<string> }>;
	};
	batches: {
		create(
			body: OpenAI.Batches.BatchCreateParams,
		): Promise<OpenAI.Batches.Batch>;
		retrieve(id: string): Promise<OpenAI.Batches.Batch>;
		cancel(id: string): Promise<OpenAI.Batches.Batch>;
	};
}

const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);

interface OutputLine {
	custom_id: string;
	response?: { status_code: number; body: unknown } | null;
	error?: { message?: string } | null;
}

export function openaiBatchTransport(
	client: OpenAIBatchClient,
	requests: OpenAIRequest[],
	search: boolean,
	sleep: (ms: number) => Promise<void>,
	pollMs: number,
): BatchJobTransport {
	if (search) {
		throw new BatchNotSupportedError(
			"search",
			"the OpenAI batch guide does not document the web_search tool in batch requests",
		);
	}
	const api = requests[0]?.api ?? "responses";
	if (requests.some((r) => r.api !== api)) {
		throw new BatchNotSupportedError(
			"model",
			"one batch cannot mix Responses-API and chat.completions models",
		);
	}
	const endpoint =
		api === "responses" ? "/v1/responses" : "/v1/chat/completions";
	const lines = async (fileId: string | undefined): Promise<OutputLine[]> =>
		fileId
			? (await (await client.files.content(fileId)).text())
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as OutputLine)
			: [];
	const collect = async (
		batch: OpenAI.Batches.Batch,
	): Promise<BatchOutcome> => {
		const results: BatchOutcome["results"] = requests.map(() => undefined);
		for (const line of [
			...(await lines(batch.output_file_id)),
			...(await lines(batch.error_file_id)),
		]) {
			const i = Number(line.custom_id);
			results[i] =
				line.response && line.response.status_code === 200
					? read(api, line.response.body, false)
					: {
							error:
								line.error?.message ??
								`status ${line.response?.status_code ?? "unknown"}`,
						};
		}
		return {
			ok: batch.status === "completed",
			error: batch.errors?.data?.[0]?.message ?? batch.status,
			results,
		};
	};
	return {
		submit: async () => {
			const jsonl = requests
				.map((r, i) =>
					JSON.stringify({
						custom_id: String(i),
						method: "POST",
						url: endpoint,
						body: r.params,
					}),
				)
				.join("\n");
			const file = await client.files.create({
				file: await toFile(Buffer.from(jsonl), "requests.jsonl"),
				purpose: "batch",
			});
			return (
				await client.batches.create({
					input_file_id: file.id,
					endpoint,
					completion_window: "24h",
				})
			).id;
		},
		poll: async (id) => {
			const batch = await client.batches.retrieve(id);
			return TERMINAL.has(batch.status) ? collect(batch) : null;
		},
		cancel: async (id) => {
			// "cancelling" can take up to ten minutes; the output file then
			// holds every request that completed before the cancel.
			let batch = await client.batches.cancel(id);
			while (!TERMINAL.has(batch.status)) {
				await sleep(pollMs);
				batch = await client.batches.retrieve(id);
			}
			return collect(batch);
		},
	};
}
