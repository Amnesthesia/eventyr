// The Gemini batch transport against recorded job shapes: submit, persist the
// job id, resume without resubmitting, map results in order, deadline
// handling. No network, no key.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatchJob, InlinedRequest } from "@google/genai";
import {
	BatchError,
	BatchNotSupportedError,
	type BatchStore,
	type LLMResponse,
	type StageUsage,
	type StoredBatchJob,
} from "./index.ts";
import {
	type BatchDeps,
	type GeminiBatchClient,
	runGeminiBatch,
} from "./testing.ts";

/** What batches.get returns for a finished inline job (recorded shape). */
function succeeded(name: string, texts: (string | null)[]): BatchJob {
	return {
		name,
		state: "JOB_STATE_SUCCEEDED",
		dest: {
			inlinedResponses: texts.map((text) =>
				text === null
					? { error: { code: 13, message: "internal" } }
					: {
							response: {
								candidates: [
									{ content: { parts: [{ text }] }, finishReason: "STOP" },
								],
								usageMetadata: {
									promptTokenCount: 10,
									candidatesTokenCount: 5,
								},
								text,
							},
						},
			),
		},
	} as unknown as BatchJob;
}

function memoryStore(): BatchStore & { jobs: Map<string, StoredBatchJob> } {
	const jobs = new Map<string, StoredBatchJob>();
	return {
		jobs,
		get: async (key) => jobs.get(key) ?? null,
		set: async (key, job) => {
			jobs.set(key, job);
		},
		delete: async (key) => {
			jobs.delete(key);
		},
	};
}

/** A client that replays a scripted sequence of batches.get answers. */
function scriptedClient(states: BatchJob[]) {
	const calls = { create: 0, get: 0, cancel: 0 };
	let created: InlinedRequest[] = [];
	const client: GeminiBatchClient = {
		create: async ({ src }) => {
			calls.create++;
			created = src;
			return { name: "batches/job-1", state: "JOB_STATE_PENDING" } as BatchJob;
		},
		get: async () => {
			calls.get++;
			return states[Math.min(calls.get - 1, states.length - 1)];
		},
		cancel: async () => {
			calls.cancel++;
		},
	};
	return { client, calls, created: () => created };
}

function deps(
	client: GeminiBatchClient,
	store: BatchStore | null,
	extra: Partial<BatchDeps> = {},
): BatchDeps & { recorded: Partial<StageUsage>[] } {
	const recorded: Partial<StageUsage>[] = [];
	return {
		client,
		store,
		fallback: async (indices) =>
			indices.map((i) => ({
				status: "fulfilled",
				value: { text: `sync-${i}`, viaBatch: false } as LLMResponse,
			})),
		record: (_stage, patch) => recorded.push(patch),
		now: () => 0,
		sleep: async () => {},
		pollMs: 0,
		recorded,
		...extra,
	};
}

const OPTS = { system: "S", json: true, thinking: "off" as const };

test("submit → job id persisted before polling → results in input order at batch price", async () => {
	const pending = {
		name: "batches/job-1",
		state: "JOB_STATE_RUNNING",
	} as BatchJob;
	const { client, calls, created } = scriptedClient([
		pending,
		succeeded("batches/job-1", ["one", "two"]),
	]);
	const store = memoryStore();
	let storedBeforeFirstGet = false;
	const d = deps(client, store);
	const get = client.get;
	client.get = async (p) => {
		storedBeforeFirstGet ||= store.jobs.size === 1;
		return get(p);
	};
	const out = await runGeminiBatch(
		["p1", "p2"],
		"gemini-3.1-flash-lite",
		"rank",
		OPTS,
		{},
		d,
	);
	assert.equal(calls.create, 1);
	assert.ok(
		storedBeforeFirstGet,
		"the job id must be on disk before the first poll",
	);
	assert.deepEqual(created()[0].config, {
		systemInstruction: "S",
		responseMimeType: "application/json",
		thinkingConfig: { thinkingBudget: 0 },
	});
	assert.deepEqual(
		out.map((o) => (o as PromiseFulfilledResult<LLMResponse>).value.text),
		["one", "two"],
	);
	assert.ok(
		out.every((o) => (o as PromiseFulfilledResult<LLMResponse>).value.viaBatch),
	);
	assert.equal(store.jobs.size, 0, "a collected job is forgotten");
	// 10 in + 5 out at the flash-lite batch rate (0.05 / 0.2 per million).
	assert.equal(d.recorded[0].estimatedUsd, (10 * 0.05 + 5 * 0.2) / 1_000_000);
});

test("resume: a stored job for the same requests is collected, not resubmitted", async () => {
	// First run: capture the key the transport stores the job under.
	const first = scriptedClient([succeeded("batches/old", ["x"])]);
	const spy = memoryStore();
	let key = "";
	spy.set = async (k, job) => {
		key = k;
		spy.jobs.set(k, job);
	};
	await runGeminiBatch(
		["p"],
		"gemini-3.1-flash-lite",
		"rank",
		OPTS,
		{},
		deps(first.client, spy),
	);
	assert.equal(first.calls.create, 1);
	assert.equal(key.length, 64);

	// Second run, as after a kill: the store still holds the job.
	const resumed = memoryStore();
	resumed.jobs.set(key, {
		provider: "gemini",
		model: "gemini-3.1-flash-lite",
		stage: "rank",
		jobName: "batches/old",
		count: 1,
		createdAt: "2026-09-25T00:00:00.000Z",
	});
	const second = scriptedClient([succeeded("batches/old", ["x"])]);
	const out = await runGeminiBatch(
		["p"],
		"gemini-3.1-flash-lite",
		"rank",
		OPTS,
		{},
		deps(second.client, resumed),
	);
	assert.equal(second.calls.create, 0, "resumed, not resubmitted");
	assert.equal((out[0] as PromiseFulfilledResult<LLMResponse>).value.text, "x");
	assert.equal(resumed.jobs.size, 0);
});

test("a per-item error is a rejection at that index, never a shifted neighbour", async () => {
	const { client } = scriptedClient([
		succeeded("batches/job-1", ["one", null, "three"]),
	]);
	const d = deps(client, null);
	const out = await runGeminiBatch(
		["a", "b", "c"],
		"gemini-3.1-flash-lite",
		"rank",
		OPTS,
		{},
		d,
	);
	assert.equal(out[0].status, "fulfilled");
	assert.equal(out[1].status, "rejected");
	assert.match(
		String((out[1] as PromiseRejectedResult).reason),
		/batch item 1: internal/,
	);
	assert.equal(
		(out[2] as PromiseFulfilledResult<LLMResponse>).value.text,
		"three",
	);
	assert.equal(d.recorded.filter((p) => p.failures).length, 1);
});

test("deadline with onDeadline: reject throws BatchError and leaves the job running", async () => {
	const running = {
		name: "batches/job-1",
		state: "JOB_STATE_RUNNING",
	} as BatchJob;
	const { client, calls } = scriptedClient([running, running, running]);
	const store = memoryStore();
	let t = 0;
	const d = deps(client, store, { now: () => (t += 1000) });
	await assert.rejects(
		runGeminiBatch(
			["a", "b"],
			"gemini-3.1-flash-lite",
			"rank",
			OPTS,
			{ deadlineMs: 1500, onDeadline: "reject" },
			d,
		),
		(err: BatchError) => {
			assert.ok(err instanceof BatchError);
			assert.equal(err.outcomes.length, 2);
			assert.ok(err.outcomes.every((o) => o.status === "rejected"));
			return true;
		},
	);
	assert.equal(calls.cancel, 0);
	assert.equal(store.jobs.size, 1, "kept for a later collect");
});

test("deadline with cancel-and-sync: keeps what finished, runs the rest as normal calls", async () => {
	const running = {
		name: "batches/job-1",
		state: "JOB_STATE_RUNNING",
	} as BatchJob;
	// After cancel, the job reports one finished item and one not.
	const afterCancel = {
		...succeeded("batches/job-1", ["done-0"]),
		state: "JOB_STATE_CANCELLED",
	} as BatchJob;
	const { client, calls } = scriptedClient([running, running, afterCancel]);
	const store = memoryStore();
	let t = 0;
	const d = deps(client, store, { now: () => (t += 1000) });
	const out = await runGeminiBatch(
		["a", "b"],
		"gemini-3.1-flash-lite",
		"rank",
		OPTS,
		{ deadlineMs: 1500 },
		d,
	);
	assert.equal(calls.cancel, 1);
	const values = out.map(
		(o) => (o as PromiseFulfilledResult<LLMResponse>).value,
	);
	assert.equal(values[0].text, "done-0");
	assert.equal(values[0].viaBatch, true);
	assert.equal(values[1].text, "sync-1");
	assert.equal(values[1].viaBatch, false);
	assert.equal(store.jobs.size, 0);
});

test("search grounding and oversized payloads are refused, never dropped", async () => {
	const { client, calls } = scriptedClient([]);
	await assert.rejects(
		runGeminiBatch(
			["a"],
			"gemini-3.1-flash-lite",
			"discover",
			{ search: true },
			{},
			deps(client, null),
		),
		(err: BatchNotSupportedError) =>
			err instanceof BatchNotSupportedError && err.option === "search",
	);
	await assert.rejects(
		runGeminiBatch(
			["x".repeat(21 * 1024 * 1024)],
			"gemini-3.1-flash-lite",
			"rank",
			{},
			{},
			deps(client, null),
		),
		(err: BatchNotSupportedError) =>
			err instanceof BatchNotSupportedError && err.option === "payload",
	);
	assert.equal(calls.create, 0);
});
