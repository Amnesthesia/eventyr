// The three SDK transports added in 1.7 and their batch adapters, against
// hand-written response shapes. No network, no key. Request parity with the
// pre-1.7 providers is scripts/llm-parity.mjs's job (goldens collect-*).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { type BatchRunDeps, runBatch } from "./batch.ts";
import {
	ask,
	BatchNotSupportedError,
	configureLLM,
	type LLMProvider,
	LLMUnavailableError,
	type StageUsage,
	usageTotals,
} from "./index.ts";
import {
	type AnthropicBatchClient,
	anthropicBatchTransport,
	anthropicParams,
	readAnthropicMessage,
} from "./providers/anthropic.ts";
import {
	type OpenAIBatchClient,
	openaiBatchTransport,
	openaiParams,
	readOpenAIResponse,
} from "./providers/openai.ts";
import {
	perplexityParams,
	readPerplexityCompletion,
} from "./providers/perplexity.ts";
import { providerReplayLine, resetLLM, responsePath } from "./testing.ts";

const RAW = "Title | Date | Venue | Cost | Organiser | URL";

function message(text: string): Anthropic.Message {
	return {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-5",
		content: [
			{
				type: "server_tool_use",
				id: "srvtoolu_1",
				name: "web_search",
				input: { query: "q" },
			},
			{ type: "text", text, citations: null },
		],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: 100,
			output_tokens: 20,
			cache_creation_input_tokens: 50,
			cache_read_input_tokens: 30,
			server_tool_use: { web_search_requests: 2 },
		},
	} as unknown as Anthropic.Message;
}

function response(text: string): OpenAI.Responses.Response {
	return {
		id: "resp_1",
		object: "response",
		status: "completed",
		model: "gpt-5-mini",
		output: [
			{ type: "web_search_call", id: "ws_1", status: "completed" },
			{
				type: "message",
				id: "m_1",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		],
		usage: {
			input_tokens: 500,
			input_tokens_details: { cached_tokens: 64 },
			output_tokens: 90,
			output_tokens_details: { reasoning_tokens: 40 },
			total_tokens: 590,
		},
		incomplete_details: null,
	} as unknown as OpenAI.Responses.Response;
}

function completion(text: string): OpenAI.Chat.ChatCompletion {
	return {
		id: "c_1",
		object: "chat.completion",
		created: 0,
		model: "sonar-pro",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text, refusal: null },
				finish_reason: "stop",
				logprobs: null,
			},
		],
		usage: { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 },
	};
}

afterEach(() => resetLLM());

test("anthropic: the request the search provider sent — two system blocks, cache breakpoint on the first, capped web search", () => {
	const params = anthropicParams("claude-sonnet-5", "U", {
		system: ["stable", "per-call"],
		search: true,
		maxSearches: 3,
		maxOutputTokens: 8000,
		providerOptions: { tool_choice: { type: "any" } },
	});
	assert.deepEqual(params, {
		model: "claude-sonnet-5",
		max_tokens: 8000,
		tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
		system: [
			{ type: "text", text: "stable", cache_control: { type: "ephemeral" } },
			{ type: "text", text: "per-call" },
		],
		messages: [{ role: "user", content: "U" }],
		tool_choice: { type: "any" },
	});
	assert.throws(
		() => anthropicParams("claude-sonnet-5", "U", { json: true }),
		/json is not supported/,
	);
	const r = readAnthropicMessage(message(RAW), true);
	assert.equal(r.text, RAW);
	assert.equal(r.finishReason, "end_turn");
	assert.deepEqual(r.usage, {
		promptTokens: 130,
		cachedTokens: 30,
		cacheWriteTokens: 50,
		outputTokens: 20,
		grounded: 1,
		searchQueries: 2,
	});
});

test("openai: gpt-5* → Responses API with web_search, system joined into input; otherwise chat.completions without search", () => {
	const responses = openaiParams("gpt-5-mini", "U", {
		system: "S",
		search: true,
		thinking: "low",
		maxOutputTokens: 8000,
		maxSearches: 4,
		providerOptions: { text: { verbosity: "low" }, prompt_cache_key: "k" },
	});
	assert.equal(responses.api, "responses");
	assert.deepEqual(responses.params, {
		model: "gpt-5-mini",
		tools: [{ type: "web_search", search_context_size: "low" }],
		reasoning: { effort: "low" },
		max_output_tokens: 8000,
		input: "S\n\nU",
		max_tool_calls: 4,
		text: { verbosity: "low" },
		prompt_cache_key: "k",
	});
	const chat = openaiParams("gpt-4.1-mini", "U", {
		system: "S",
		maxOutputTokens: 8000,
	});
	assert.equal(chat.api, "chat");
	assert.deepEqual(chat.params, {
		model: "gpt-4.1-mini",
		max_tokens: 8000,
		messages: [
			{ role: "system", content: "S" },
			{ role: "user", content: "U" },
		],
	});
	assert.throws(
		() => openaiParams("gpt-4.1-mini", "U", { search: true }),
		/search is not supported/,
	);
	const r = readOpenAIResponse(response(RAW), true);
	assert.equal(r.text, RAW);
	assert.deepEqual(r.usage, {
		promptTokens: 500,
		cachedTokens: 64,
		outputTokens: 50,
		thoughtTokens: 40,
		grounded: 1,
		searchQueries: 1,
	});
});

test("perplexity: chat params, every call counts as one grounded search", () => {
	assert.deepEqual(
		perplexityParams("sonar-pro", "U", { system: "S", maxOutputTokens: 8000 }),
		{
			model: "sonar-pro",
			max_tokens: 8000,
			messages: [
				{ role: "system", content: "S" },
				{ role: "user", content: "U" },
			],
		},
	);
	const r = readPerplexityCompletion(completion(RAW));
	assert.deepEqual(r.usage, {
		promptTokens: 80,
		outputTokens: 15,
		grounded: 1,
		searchQueries: 1,
	});
});

// --- through the client -----------------------------------------------------

let dir: string;
beforeEach(() => {
	resetLLM();
	dir = mkdtempSync(join(tmpdir(), "llm-providers-"));
	mkdirSync(join(dir, "responses"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a non-Gemini provider replays a canned SDK response and records its usage", async () => {
	configureLLM({ replay: { dir, mode: "replay", latencyMs: 0 } });
	const opts = { system: "S", search: true, maxOutputTokens: 100 };
	const line = providerReplayLine(
		"anthropic",
		"search/anthropic",
		anthropicParams("claude-sonnet-5", "U", opts),
	);
	writeFileSync(responsePath(dir, line), JSON.stringify(message(RAW)));
	const text = await ask("U", {
		provider: "anthropic",
		model: "claude-sonnet-5",
		stage: "search/anthropic",
		...opts,
	});
	assert.equal(text, RAW);
	const u = usageTotals()["search/anthropic"];
	assert.equal(u.calls, 1);
	assert.equal(u.searchQueries, 2);
	assert.equal(u.cacheWriteTokens, 50);
	assert.ok(u.estimatedUsd > 0.02, "two searches at $0.01 each plus tokens");
});

test("a missing key throws LLMUnavailableError for every provider", async () => {
	const providers: (LLMProvider & { env: string })[] = [
		{
			provider: "anthropic",
			model: "claude-sonnet-5",
			env: "ANTHROPIC_API_KEY",
		},
		{ provider: "openai", model: "gpt-5-mini", env: "OPENAI_API_KEY" },
		{ provider: "perplexity", model: "sonar-pro", env: "PERPLEXITY_API_KEY" },
	];
	for (const { env, ...p } of providers) {
		const saved = process.env[env];
		delete process.env[env];
		try {
			await assert.rejects(
				ask("U", p),
				(err: unknown) =>
					err instanceof LLMUnavailableError && err.provider === p.provider,
			);
		} finally {
			if (saved !== undefined) process.env[env] = saved;
		}
	}
});

test("perplexity has no batch API", async () => {
	await assert.rejects(
		ask(["a"], { provider: "perplexity", model: "sonar-pro", batch: true }),
		BatchNotSupportedError,
	);
});

// --- batch adapters ----------------------------------------------------------

function deps(): BatchRunDeps & { recorded: Partial<StageUsage>[] } {
	const recorded: Partial<StageUsage>[] = [];
	return {
		provider: "anthropic",
		store: null,
		fallback: async () => [],
		record: (_stage, patch) => recorded.push(patch),
		now: () => 0,
		sleep: async () => {},
		pollMs: 0,
		recorded,
	};
}

test("anthropic batch: custom_id is the input index, results come back in order, errored items are rejections, web search allowed", async () => {
	const calls = { create: 0, retrieve: 0 };
	let submitted: Anthropic.Messages.BatchCreateParams | undefined;
	const client: AnthropicBatchClient = {
		create: async (body) => {
			calls.create++;
			submitted = body;
			return {
				id: "msgbatch_1",
				processing_status: "in_progress",
			} as Anthropic.Messages.MessageBatch;
		},
		retrieve: async () => {
			calls.retrieve++;
			return {
				id: "msgbatch_1",
				processing_status: calls.retrieve < 2 ? "in_progress" : "ended",
			} as Anthropic.Messages.MessageBatch;
		},
		results: async () =>
			(async function* () {
				yield {
					custom_id: "1",
					result: {
						type: "errored",
						error: {
							type: "error",
							error: { type: "invalid_request_error", message: "bad" },
						},
					},
				};
				yield {
					custom_id: "0",
					result: { type: "succeeded", message: message("first") },
				};
			})() as AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>,
		cancel: async () =>
			({
				id: "msgbatch_1",
				processing_status: "ended",
			}) as Anthropic.Messages.MessageBatch,
	};
	const opts = { search: true, maxOutputTokens: 100 };
	const requests = ["p0", "p1"].map((p) =>
		anthropicParams("claude-sonnet-5", p, opts),
	);
	const d = deps();
	const out = await runBatch(
		2,
		"key",
		"claude-sonnet-5",
		"rank",
		{},
		anthropicBatchTransport(
			client,
			requests,
			true,
			d.sleep as (ms: number) => Promise<void>,
			0,
		),
		d,
	);
	assert.equal(submitted?.requests[1].custom_id, "1");
	assert.equal(submitted?.requests[1].params.messages[0].content, "p1");
	assert.equal(out[0].status, "fulfilled");
	assert.equal(
		(out[0] as PromiseFulfilledResult<{ text: string; viaBatch: boolean }>)
			.value.text,
		"first",
	);
	assert.ok(
		(out[0] as PromiseFulfilledResult<{ viaBatch: boolean }>).value.viaBatch,
	);
	assert.equal(out[1].status, "rejected");
	assert.match(
		String((out[1] as PromiseRejectedResult).reason),
		/batch item 1: bad/,
	);
	// Batch rate: half the token price, the search fee undiscounted.
	assert.ok(
		d.recorded[0].estimatedUsd !== undefined &&
			d.recorded[0].estimatedUsd > 0.02,
	);
});

test("openai batch: JSONL upload against the endpoint of the sync branch, results by custom_id, web search refused", async () => {
	let uploaded = "";
	let created: OpenAI.Batches.BatchCreateParams | undefined;
	const body = response("done");
	const client: OpenAIBatchClient = {
		files: {
			create: async ({ file }) => {
				uploaded = await (file as File).text();
				return { id: "file_in" };
			},
			content: async (id) => ({
				text: async () =>
					id === "file_out"
						? `${JSON.stringify({ custom_id: "1", response: { status_code: 200, body } })}\n`
						: `${JSON.stringify({ custom_id: "0", response: { status_code: 400, body: null }, error: { message: "rejected" } })}\n`,
			}),
		},
		batches: {
			create: async (b) => {
				created = b;
				return { id: "batch_1", status: "validating" } as OpenAI.Batches.Batch;
			},
			retrieve: async () =>
				({
					id: "batch_1",
					status: "completed",
					output_file_id: "file_out",
					error_file_id: "file_err",
				}) as OpenAI.Batches.Batch,
			cancel: async () =>
				({ id: "batch_1", status: "cancelled" }) as OpenAI.Batches.Batch,
		},
	};
	const requests = ["p0", "p1"].map((p) =>
		openaiParams("gpt-5-mini", p, { maxOutputTokens: 50 }),
	);
	const d = { ...deps(), provider: "openai" as const };
	const out = await runBatch(
		2,
		"key",
		"gpt-5-mini",
		"rank",
		{},
		openaiBatchTransport(
			client,
			requests,
			false,
			d.sleep as (ms: number) => Promise<void>,
			0,
		),
		d,
	);
	assert.equal(created?.endpoint, "/v1/responses");
	assert.equal(created?.completion_window, "24h");
	const lines = uploaded
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.deepEqual(lines[1], {
		custom_id: "1",
		method: "POST",
		url: "/v1/responses",
		body: requests[1].params,
	});
	assert.equal(out[0].status, "rejected");
	assert.match(String((out[0] as PromiseRejectedResult).reason), /rejected/);
	assert.equal(
		(out[1] as PromiseFulfilledResult<{ text: string }>).value.text,
		"done",
	);
	assert.throws(
		() => openaiBatchTransport(client, requests, true, async () => {}, 0),
		BatchNotSupportedError,
	);
});
