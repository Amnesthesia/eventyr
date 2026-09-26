import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	ask,
	askDetailed,
	askJson,
	BatchError,
	BudgetExhaustedError,
	configureLLM,
	LLMUnavailableError,
	type StageUsage,
	usageTotals,
} from "./index.ts";
import { replayLine, resetLLM, responsePath } from "./testing.ts";

/** A replay dir with canned answers, so no test needs a key or the network. */
function replayDir(answers: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "llm-replay-"));
	mkdirSync(join(dir, "responses"));
	for (const [prompt, text] of Object.entries(answers)) {
		const line = replayLine({
			stage: "t",
			model: "gemini-3.1-flash-lite",
			contents: prompt,
		});
		writeFileSync(responsePath(dir, line), text);
	}
	return dir;
}

const GEMINI = {
	provider: "gemini",
	model: "gemini-3.1-flash-lite",
	stage: "t",
} as const;
let dir: string;

beforeEach(() => {
	resetLLM();
	dir = replayDir({ a: "alpha", b: "beta", c: "gamma", "[]": "[]" });
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetLLM();
});

test("V6: maxCalls 2 — the third call throws BudgetExhaustedError with the old message", async () => {
	configureLLM({ maxCalls: 2, replay: { dir, mode: "replay", latencyMs: 0 } });
	assert.equal(await ask("a", GEMINI), "alpha");
	assert.equal(await ask("b", GEMINI), "beta");
	await assert.rejects(ask("c", GEMINI), (err: Error) => {
		assert.ok(err instanceof BudgetExhaustedError);
		assert.equal(
			err.message,
			"Gemini call budget exhausted (2 calls). Progress is saved — rerun the same command to continue, or raise GEMINI_MAX_CALLS.",
		);
		return true;
	});
});

test("V6c: askDetailed metadata equals what the usage sink recorded", async () => {
	const recorded: [string, Partial<StageUsage>][] = [];
	configureLLM({
		replay: { dir, mode: "replay", latencyMs: 0 },
		usage: { record: (stage, patch) => recorded.push([stage, patch]) },
	});
	const r = await askDetailed("a", GEMINI);
	assert.equal(r.text, "alpha");
	assert.equal(r.provider, "gemini");
	assert.equal(r.stage, "t");
	assert.equal(r.attempts, 1);
	assert.equal(r.fromCache, false);
	assert.equal(r.viaBatch, false);
	const [stage, patch] = recorded[0];
	assert.equal(stage, "t");
	assert.equal(r.usage.inputTokens, patch.promptTokens);
	assert.equal(r.usage.outputTokens, patch.outputTokens);
	assert.equal(
		r.usage.totalTokens,
		(patch.promptTokens ?? 0) + (patch.outputTokens ?? 0),
	);
	assert.equal(r.usage.estimatedCostUsd, patch.estimatedUsd);
	assert.equal(usageTotals().t.calls, 1);
	assert.equal(usageTotals().t.promptTokens, patch.promptTokens);
});

test("replay records the request line, meta and a missing response leaves the request behind", async () => {
	configureLLM({ replay: { dir, mode: "replay", latencyMs: 0 } });
	await ask("a", GEMINI);
	await assert.rejects(ask("nope", GEMINI), /replay fixture missing/);
	const lines = readFileSync(join(dir, "requests.jsonl"), "utf-8")
		.trim()
		.split("\n");
	assert.equal(lines.length, 2);
	assert.equal(
		lines[0],
		'{"contents":"a","model":"gemini-3.1-flash-lite","stage":"t"}',
	);
	const meta = JSON.parse(
		readFileSync(join(dir, "requests.meta.json"), "utf-8"),
	);
	assert.equal(meta.calls, 2);
	assert.equal(meta.peakInFlight.gemini, 1);
	assert.equal(usageTotals().t.failures, 1);
	const missing = `${responsePath(dir, lines[1]).slice(0, -4)}.missing.json`;
	assert.equal(readFileSync(missing, "utf-8").trim(), lines[1]);
});

test("the replay line carries system, json, thinking and providerOptions the way the old wrapper did", async () => {
	configureLLM({ replay: { dir, mode: "replay", latencyMs: 0 } });
	await assert.rejects(
		ask("x", {
			...GEMINI,
			system: "S",
			json: true,
			thinking: "off",
			maxOutputTokens: 10,
			temperature: 0,
			providerOptions: { candidateCount: 1 },
		}),
	);
	const line = readFileSync(join(dir, "requests.jsonl"), "utf-8").trim();
	assert.equal(
		line,
		'{"contents":"x","extraConfig":{"candidateCount":1,"responseMimeType":"application/json","thinkingConfig":{"thinkingBudget":0}},"maxOutputTokens":10,"model":"gemini-3.1-flash-lite","stage":"t","systemInstruction":"S","temperature":0}',
	);
});

test("array form keeps order and runs concurrently under the limiter", async () => {
	configureLLM({
		replay: { dir, mode: "replay", latencyMs: 20 },
		concurrency: { gemini: 2 },
	});
	const started = performance.now();
	assert.deepEqual(await ask(["a", "b", "c"], GEMINI), [
		"alpha",
		"beta",
		"gamma",
	]);
	const meta = JSON.parse(
		readFileSync(join(dir, "requests.meta.json"), "utf-8"),
	);
	assert.equal(meta.peakInFlight.gemini, 2);
	assert.ok(
		performance.now() - started < 200,
		"three 20 ms calls at width 2 must not run serially",
	);
});

test("array form rejects with BatchError carrying per-index outcomes", async () => {
	configureLLM({ replay: { dir, mode: "replay", latencyMs: 0 } });
	await assert.rejects(ask(["a", "nope"], GEMINI), (err: BatchError) => {
		assert.ok(err instanceof BatchError);
		assert.equal(err.outcomes[0].status, "fulfilled");
		assert.equal(err.outcomes[1].status, "rejected");
		return true;
	});
	const settled = await askDetailed(["nope", "b"], GEMINI);
	assert.equal(settled[0].status, "rejected");
	assert.equal(
		(settled[1] as PromiseFulfilledResult<{ text: string }>).value.text,
		"beta",
	);
});

test("a missing key throws LLMUnavailableError before any call", async () => {
	const saved = process.env.GOOGLE_API_KEY;
	delete process.env.GOOGLE_API_KEY;
	try {
		await assert.rejects(ask("a", GEMINI), (err: Error) => {
			assert.ok(err instanceof LLMUnavailableError);
			assert.match(err.message, /GOOGLE_API_KEY/);
			return true;
		});
	} finally {
		if (saved !== undefined) process.env.GOOGLE_API_KEY = saved;
	}
});

test("askJson: json mode, parse, no retry when retryEmpty is false", async () => {
	configureLLM({ replay: { dir, mode: "replay", latencyMs: 0 } });
	// "[]" was canned without json mode; with json:true the line differs, so
	// author the json-mode answer here.
	const line = replayLine({
		stage: "t",
		model: "gemini-3.1-flash-lite",
		contents: "rows",
		extraConfig: { responseMimeType: "application/json" },
	});
	writeFileSync(responsePath(dir, line), '[{"i":0}]');
	assert.deepEqual(await askJson("rows", { ...GEMINI, retryEmpty: false }), [
		{ i: 0 },
	]);
	writeFileSync(responsePath(dir, line), "");
	assert.deepEqual(await askJson("rows", { ...GEMINI, retryEmpty: false }), []);
	assert.equal(usageTotals().t.calls, 2);
	// Default: an empty answer to a non-empty prompt is asked once more.
	assert.deepEqual(await askJson("rows", GEMINI), []);
	assert.equal(usageTotals().t.calls, 4);
});
