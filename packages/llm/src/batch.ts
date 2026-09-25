// Provider-native batch transport, Gemini Batch Mode (D14). One job per
// ask(prompts, { batch }) call; results come back in input order at half
// price. Not used by any stage in PR 1 — the parity check compares requests
// byte for byte and a batch request looks different. 1.13 flips rank and
// annotate onto it.
//
// What batch mode can carry, per ai.google.dev/gemini-api/docs/batch-mode and
// /pricing (checked 2026-09-25):
//   - systemInstruction, JSON mode (responseMimeType) and thinking config are
//     part of the per-request GenerateContentConfig and go through unchanged.
//   - Google Search grounding: the batch guide shows a `tools` config, but the
//     pricing page says grounding is "not available" for Gemini 3.x batch
//     requests, and every model this pipeline calls is 3.x. Refused rather than
//     silently dropped — a search prompt without search is a different answer.
//   - Inline requests up to 20 MB. ponytail: above that the API wants a JSONL
//     file through the Files API; that path is refused here, not implemented —
//     rank's largest city is ~400 KB. Add file input when a stage needs it.

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
import { replayLine } from "./replay.ts";
import type {
	AskOptions,
	BatchOptions,
	BatchStore,
	LLMResponse,
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

export interface BatchDeps {
	client: GeminiBatchClient;
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
	const now = deps.now ?? (() => Date.now());
	const wait = deps.sleep ?? sleep;
	const deadlineMs = batch.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const onDeadline = batch.onDeadline ?? "cancel-and-sync";

	// Resume: a stored job for the same requests is collected, not resubmitted.
	const key = batchRequestKey(
		model,
		prompts.map((contents) =>
			replayLine(replayRequestOf(stage, model, contents, opts)),
		),
	);
	const stored = await deps.store?.get(key);
	let name: string;
	if (stored) {
		name = stored.jobName;
	} else {
		const job = await deps.client.create({
			model,
			src: requests,
			config: { displayName: `${stage} ${new Date().toISOString()}` },
		});
		if (!job.name) throw new Error("batch create returned no job name");
		name = job.name;
		// Persisted before the first poll: a run killed while waiting must
		// find the job, not pay for it again.
		await deps.store?.set(key, {
			provider: "gemini",
			model,
			stage,
			jobName: name,
			count: prompts.length,
			createdAt: new Date().toISOString(),
		});
	}

	const startedAt = now();
	let job = await deps.client.get({ name });
	let pollMs = deps.pollMs ?? FIRST_POLL_MS;
	while (!TERMINAL.has(job.state ?? "")) {
		if (now() - startedAt >= deadlineMs) {
			if (onDeadline === "reject") {
				throw new BatchError(
					`batch job ${name} not finished after ${deadlineMs} ms; left running for a later collect`,
					prompts.map(() => rejected(new Error("batch deadline"))),
				);
			}
			return cancelAndSync(name, prompts, model, stage, deps, key);
		}
		await wait(pollMs);
		pollMs = Math.min(MAX_POLL_MS, pollMs * 2);
		job = await deps.client.get({ name });
	}
	await deps.store?.delete(key);
	if (job.state !== "JOB_STATE_SUCCEEDED") {
		const why = job.error?.message ?? job.state;
		const outcomes = prompts.map(() =>
			rejected(new Error(`batch job ${name}: ${why}`)),
		);
		deps.record(stage, { failures: prompts.length });
		throw new BatchError(
			`batch job ${name} ended ${job.state}: ${why}`,
			outcomes,
		);
	}
	return mapResults(job, prompts.length, model, stage, deps);
}

/** Results in input order; a missing or errored item is a rejection, never a
 * shifted neighbour. Usage is recorded at the batch rate. */
function mapResults(
	job: BatchJob,
	count: number,
	model: string,
	stage: string,
	deps: BatchDeps,
): PromiseSettledResult<LLMResponse>[] {
	const inlined = job.dest?.inlinedResponses ?? [];
	return Array.from({ length: count }, (_, i) => {
		const item = inlined[i];
		if (!item?.response) {
			deps.record(stage, { failures: 1 });
			return rejected(
				new Error(
					`batch item ${i}: ${item?.error?.message ?? "no response returned"}`,
				),
			);
		}
		const result = readGeminiResponse(item.response, false);
		const call: Partial<StageUsage> = { calls: 1, ...result.usage };
		call.estimatedUsd = estimateUsd(model, call, true);
		deps.record(stage, call);
		return {
			status: "fulfilled",
			value: {
				text: result.text,
				provider: "gemini",
				model,
				stage,
				usage: toLLMUsage(call),
				attempts: 1,
				durationMs: 0,
				finishReason: result.finishReason,
				fromCache: false,
				viaBatch: true,
			},
		};
	});
}

/** Deadline passed: cancel, keep what finished, run the rest as normal calls. */
async function cancelAndSync(
	name: string,
	prompts: string[],
	model: string,
	stage: string,
	deps: BatchDeps,
	key: string,
): Promise<PromiseSettledResult<LLMResponse>[]> {
	await deps.client.cancel({ name });
	const job = await deps.client.get({ name });
	await deps.store?.delete(key);
	const inlined = job.dest?.inlinedResponses ?? [];
	const finished = prompts.map((_, i) => Boolean(inlined[i]?.response));
	const partial = mapResults(job, prompts.length, model, stage, deps);
	const unfinished = prompts.map((_, i) => i).filter((i) => !finished[i]);
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
		totalTokens: inputTokens + outputTokens + thoughtTokens,
		searchQueries: u.searchQueries ?? 0,
		estimatedCostUsd: u.estimatedUsd ?? 0,
	};
}
