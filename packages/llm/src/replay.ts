// Record/replay: the permanent form of the 1.6 step 1 seam. The line format
// is the contract the goldens in test/golden/llm are stored in, so it must
// not change without re-recording them.
//
//   record → append one sorted-key JSON line per call to <dir>/requests.jsonl,
//            then make the real call.
//   replay → same line, but answer from <dir>/responses/<sha256(line)>.txt
//            after `latencyMs`; no network. A missing response throws and
//            leaves the request behind as <hash>.missing.json so it can be
//            authored by hand.
//
// Usage in replay is derived from text lengths so the cost report is
// deterministic. <dir>/requests.meta.json records peak in-flight calls per
// provider and the first-call → last-call wall-clock (PLAN §9).

import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sleep } from "@dothingslol/utils/time";
import type { ProviderName, ReplayConfig, StageUsage } from "./types.ts";

/** Everything that decides what a provider is asked. */
export interface ReplayRequest {
	stage: string;
	model: string;
	contents: string;
	systemInstruction?: string;
	maxOutputTokens?: number;
	temperature?: number;
	search?: boolean;
	extraConfig?: Record<string, unknown>;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
		);
	}
	return value;
}

export function replayLine(req: ReplayRequest): string {
	return JSON.stringify(
		sortKeys({
			stage: req.stage,
			model: req.model,
			contents: req.contents,
			systemInstruction: req.systemInstruction,
			maxOutputTokens: req.maxOutputTokens,
			temperature: req.temperature,
			search: req.search,
			extraConfig: req.extraConfig,
		}),
	);
}

/**
 * The line for a provider whose request is its SDK's own params object:
 * `{provider, stage, model, ...body}` with keys sorted. Gemini keeps the
 * GeminiCallOptions-shaped line above; the goldens pin both.
 */
export function providerReplayLine(
	provider: Exclude<ProviderName, "gemini">,
	stage: string,
	body: object,
): string {
	return JSON.stringify(sortKeys({ provider, stage, ...body }));
}

export function replayHash(line: string): string {
	return createHash("sha256").update(line).digest("hex");
}

export function responsePath(dir: string, line: string): string {
	return join(dir, "responses", `${replayHash(line)}.txt`);
}

/** Deterministic stand-in for a provider's usage metadata. */
export function replayUsage(
	req: ReplayRequest,
	text: string,
): Partial<StageUsage> {
	return {
		promptTokens: Math.ceil(
			(req.contents.length + (req.systemInstruction?.length ?? 0)) / 4,
		),
		outputTokens: Math.ceil(text.length / 4),
		thoughtTokens: 0,
		cachedTokens: 0,
		searchQueries: req.search ? 1 : 0,
	};
}

export class Replay {
	private readonly latencyMs: number;
	private calls = 0;
	private inFlight = 0;
	private readonly peakInFlight: Partial<Record<ProviderName, number>> = {};
	private startedAt = 0;
	private wallClockMs = 0;

	constructor(readonly config: ReplayConfig) {
		if (!config.dir) throw new Error("replay needs a dir");
		this.latencyMs = config.latencyMs ?? 200;
	}

	get mode(): ReplayConfig["mode"] {
		return this.config.mode;
	}

	/** Logs the request and opens an in-flight slot. */
	begin(line: string, provider: ProviderName): void {
		mkdirSync(this.config.dir, { recursive: true });
		appendFileSync(
			join(this.config.dir, "requests.jsonl"),
			`${line}\n`,
			"utf-8",
		);
		if (this.calls === 0) this.startedAt = performance.now();
		this.calls++;
		this.inFlight++;
		this.peakInFlight[provider] = Math.max(
			this.peakInFlight[provider] ?? 0,
			this.inFlight,
		);
	}

	/** Closes the slot and rewrites the meta file (one writer, every call). */
	end(): void {
		this.inFlight--;
		this.wallClockMs = Math.round(performance.now() - this.startedAt);
		writeFileSync(
			join(this.config.dir, "requests.meta.json"),
			JSON.stringify(
				{
					calls: this.calls,
					peakInFlight: this.peakInFlight,
					wallClockMs: this.wallClockMs,
				},
				null,
				2,
			),
			"utf-8",
		);
	}

	async answer(line: string, stage: string): Promise<string> {
		const path = responsePath(this.config.dir, line);
		await sleep(this.latencyMs);
		if (!existsSync(path)) {
			// Leave the request behind so the fixture can be authored by hand.
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(`${path.slice(0, -4)}.missing.json`, `${line}\n`, "utf-8");
			throw new Error(`replay fixture missing: ${path} (stage ${stage})`);
		}
		return readFileSync(path, "utf-8");
	}
}
