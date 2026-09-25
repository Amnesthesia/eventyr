// Provider-native batch transport (D14). One job per ask(prompts, { batch })
// call; results come back in input order at the provider's batch price. Not
// used by any stage in PR 1 — the parity check compares requests byte for
// byte and a batch request looks different. 1.13 flips rank and annotate
// onto it.
//
// The runner here is provider-neutral: submit, persist the job id, poll with
// backoff, collect in input order, and on deadline either reject or cancel
// and run the leftovers as normal calls. Each provider file supplies a
// BatchJobTransport; what each one can carry:
//   - Gemini (ai.google.dev/gemini-api/docs/batch-mode and /pricing, checked
//     2026-09-25): systemInstruction, JSON mode and thinking config go through
//     unchanged. Google Search grounding: the batch guide shows a `tools`
//     config, but the pricing page says grounding is "not available" for
//     Gemini 3.x batch requests, and every model this pipeline calls is 3.x.
//     Refused rather than silently dropped — a search prompt without search
//     is a different answer. Inline requests up to 20 MB. ponytail: above
//     that the API wants a JSONL file through the Files API; that path is
//     refused here, not implemented — rank's largest city is ~400 KB. Add
//     file input when a stage needs it.
//   - Anthropic: web search supported (providers/anthropic.ts).
//   - OpenAI: web search not documented for batches, refused
//     (providers/openai.ts).
//   - Perplexity: no batch API (client.ts).

import { createHash } from "node:crypto";
import { sleep } from "@dothingslol/utils/time";
import type { BatchJob, InlinedRequest } from "@google/genai";
import { BatchError, BatchNotSupportedError } from "./errors.ts";
import { estimateUsd } from "./pricing.ts";
import {
	geminiConfig,
	readGeminiResponse,
	replayRequestOf,
} from "./providers/gemini.ts";
import type { ProviderResult } from "./providers/transport.ts";
import { replayLine } from "./replay.ts";
import type {
	AskOptions,
	BatchOptions,
	BatchStore,
	LLMResponse,
	ProviderName,
	StageUsage,
} from "./types.ts";

const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const FIRST_POLL_MS = 5_000;
const MAX_POLL_MS = 60_000;
const TERMINAL = new Set([
	"JOB_STATE_SUCCEEDED",
	"JOB_STATE_FAILED",
	"JOB_STATE_CANCELLED",
	"JOB_STATE_EXPIRED",
]);

/** Results by input index: a provider result, an error, or undefined when
 * the provider returned nothing for that index. */
export interface BatchOutcome {
	ok: boolean;
	error?: string;
	results: (ProviderResult | { error: string } | undefined)[];
}

/** One provider's batch job, from the client's point of view. */
export interface BatchJobTransport {
	/** Submits the job; returns its id. */
	submit(): Promise<string>;
	/** Null while the job is still running. */
	poll(job: string): Promise<BatchOutcome | null>;
	/** Cancels and returns what had finished by then. */
	cancel(job: string): Promise<BatchOutcome>;
}

export interface BatchRunDeps {
	provider: ProviderName;
	store: BatchStore | null;
	/** Runs the given prompt indices as normal calls (cancel-and-sync). */
	fallback: (indices: number[]) => Promise<PromiseSettledResult<LLMResponse>[]>;
	record: (stage: string, patch: Partial<StageUsage>) => void;
	/** Injectable for tests; default: real clock and real sleeps. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollMs?: number;
}

export function batchRequestKey(model: string, lines: string[]): string {
	return createHash("sha256")
		.update(`${model}\n${lines.join("\n")}`)
		.digest("hex");
}

function rejected(reason: unknown): PromiseRejectedResult {
	return { status: "rejected", reason };
}

export async function runBatch(
	count: number,
	key: string,
	model: string,
	stage: string,
	batch: BatchOptions,
	transport: BatchJobTransport,
	deps: BatchRunDeps,
): Promise<PromiseSettledResult<LLMResponse>[]> {
	const now = deps.now ?? (() => Date.now());
	const wait = deps.sleep ?? sleep;
	const deadlineMs = batch.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const onDeadline = batch.onDeadline ?? "cancel-and-sync";

	// Resume: a stored job for the same requests is collected, not resubmitted.
	const stored = await deps.store?.get(key);
	let name: string;
	if (stored) {
		name = stored.jobName;
	} else {
		name = await transport.submit();
		// Persisted before the first poll: a run killed while waiting must
		// find the job, not pay for it again.
		await deps.store?.set(key, {
			provider: deps.provider,
			model,
			stage,
			jobName: name,
			count,
			createdAt: new Date().toISOString(),
		});
	}

	const startedAt = now();
	let outcome = await transport.poll(name);
	let pollMs = deps.pollMs ?? FIRST_POLL_MS;
	while (!outcome) {
		if (now() - startedAt >= deadlineMs) {
			if (onDeadline === "reject") {
				throw new BatchError(
					`batch job ${name} not finished after ${deadlineMs} ms; left running for a later collect`,
					Array.from({ length: count }, () =>
						rejected(new Error("batch deadline")),
					),
				);
			}
			return cancelAndSync(name, count, model, stage, transport, deps, key);
		}
		await wait(pollMs);
		pollMs = Math.min(MAX_POLL_MS, pollMs * 2);
		outcome = await transport.poll(name);
	}
	await deps.store?.delete(key);
	if (!outcome.ok) {
		deps.record(stage, { failures: count });
		throw new BatchError(
			`batch job ${name} failed: ${outcome.error}`,
			Array.from({ length: count }, () =>
				rejected(new Error(`batch job ${name}: ${outcome?.error}`)),
			),
		);
	}
	return mapResults(outcome, count, model, stage, deps);
}

/** Results in input order; a missing or errored item is a rejection, never a
 * shifted neighbour. Usage is recorded at the batch rate. */
function mapResults(
	outcome: BatchOutcome,
	count: number,
	model: string,
	stage: string,
	deps: BatchRunDeps,
): PromiseSettledResult<LLMResponse>[] {
	return Array.from({ length: count }, (_, i) => {
		const item = outcome.results[i];
		if (!item || "error" in item) {
			deps.record(stage, { failures: 1 });
			return rejected(
				new Error(`batch item ${i}: ${item?.error ?? "no response returned"}`),
			);
		}
		const call: Partial<StageUsage> = { calls: 1, ...item.usage };
		call.estimatedUsd = estimateUsd(model, call, true);
		deps.record(stage, call);
		return {
			status: "fulfilled",
			value: {
				text: item.text,
				provider: deps.provider,
				model,
				stage,
				usage: toLLMUsage(call),
				attempts: 1,
				durationMs: 0,
				finishReason: item.finishReason,
				fromCache: false,
				viaBatch: true,
			},
		};
	});
}

/** Deadline passed: cancel, keep what finished, run the rest as normal calls. */
async function cancelAndSync(
	name: string,
	count: number,
	model: string,
	stage: string,
	transport: BatchJobTransport,
	deps: BatchRunDeps,
	key: string,
): Promise<PromiseSettledResult<LLMResponse>[]> {
	const outcome = await transport.cancel(name);
	await deps.store?.delete(key);
	const finished = Array.from({ length: count }, (_, i) => {
		const item = outcome.results[i];
		return Boolean(item && !("error" in item));
	});
	const partial = mapResults(outcome, count, model, stage, deps);
	const unfinished = finished.flatMap((done, i) => (done ? [] : [i]));
	if (unfinished.length === 0) return partial;
	const rest = await deps.fallback(unfinished);
	return partial.map((r, i) => {
		const at = unfinished.indexOf(i);
		return at === -1 ? r : rest[at];
	});
}

export function toLLMUsage(u: Partial<StageUsage>): LLMResponse["usage"] {
	const inputTokens = u.promptTokens ?? 0;
	const outputTokens = u.outputTokens ?? 0;
	const thoughtTokens = u.thoughtTokens ?? 0;
	return {
		inputTokens,
		outputTokens,
		thoughtTokens,
		cachedInputTokens: u.cachedTokens ?? 0,
		cacheWriteTokens: u.cacheWriteTokens ?? 0,
		totalTokens: inputTokens + outputTokens + thoughtTokens,
		searchQueries: u.searchQueries ?? 0,
		estimatedCostUsd: u.estimatedUsd ?? 0,
	};
}

// --- Gemini Batch Mode ------------------------------------------------------

/** The three calls this needs from `ai.batches`, so tests can hand in
 * recorded jobs instead of a client. */
export interface GeminiBatchClient {
	create(params: {
		model: string;
		src: InlinedRequest[];
		config?: { displayName?: string };
	}): Promise<BatchJob>;
	get(params: { name: string }): Promise<BatchJob>;
	cancel(params: { name: string }): Promise<void>;
}

export interface BatchDeps extends Omit<BatchRunDeps, "provider"> {
	client: GeminiBatchClient;
}

function geminiOutcome(job: BatchJob): BatchOutcome {
	return {
		ok: job.state === "JOB_STATE_SUCCEEDED",
		error: job.error?.message ?? job.state,
		results: (job.dest?.inlinedResponses ?? []).map((item) =>
			item.response
				? readGeminiResponse(item.response, false)
				: { error: item.error?.message ?? "no response returned" },
		),
	};
}

export function geminiBatchTransport(
	client: GeminiBatchClient,
	model: string,
	stage: string,
	requests: InlinedRequest[],
): BatchJobTransport {
	return {
		submit: async () => {
			const job = await client.create({
				model,
				src: requests,
				config: { displayName: `${stage} ${new Date().toISOString()}` },
			});
			if (!job.name) throw new Error("batch create returned no job name");
			return job.name;
		},
		poll: async (name) => {
			const job = await client.get({ name });
			return TERMINAL.has(job.state ?? "") ? geminiOutcome(job) : null;
		},
		cancel: async (name) => {
			await client.cancel({ name });
			return geminiOutcome(await client.get({ name }));
		},
	};
}

export async function runGeminiBatch(
	prompts: string[],
	model: string,
	stage: string,
	opts: AskOptions,
	batch: BatchOptions,
	deps: BatchDeps,
): Promise<PromiseSettledResult<LLMResponse>[]> {
	if (opts.search) {
		throw new BatchNotSupportedError(
			"search",
			"Google Search grounding is not available in Gemini batch requests (pricing page, Gemini 3.x)",
		);
	}
	const config = geminiConfig(opts);
	const requests: InlinedRequest[] = prompts.map((contents) => ({
		contents,
		config,
	}));
	const bytes = Buffer.byteLength(JSON.stringify(requests));
	if (bytes > INLINE_LIMIT_BYTES) {
		throw new BatchNotSupportedError(
			"payload",
			`${bytes} bytes of inline requests exceeds the 20 MB inline limit (JSONL file input is not implemented)`,
		);
	}
	const key = batchRequestKey(
		model,
		prompts.map((contents) =>
			replayLine(replayRequestOf(stage, model, contents, opts)),
		),
	);
	const { client, ...rest } = deps;
	return runBatch(
		prompts.length,
		key,
		model,
		stage,
		batch,
		geminiBatchTransport(client, model, stage, requests),
		{ ...rest, provider: "gemini" },
	);
}
