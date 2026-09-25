// The LLM half of dedupe.ts's stage 2. Kept separate so dedupe.ts stays a
// pure, network-free module that tests can drive with a stub.

import { askDetailed, parseJsonArray } from "@dothingslol/llm";
import { chunkArray } from "@dothingslol/utils/concurrency";
import {
	type CandidatePair,
	PAIR_BATCH_SIZE,
	type PairClassifyFn,
} from "./dedupe.ts";

const MODEL = "gemini-3.1-flash-lite";

const SYSTEM_PROMPT = `You decide whether two event listings describe the SAME real-world event, gathered from different sources that word things differently.

Same event: the same happening at the same venue on the same date, even if one title is longer, includes the lineup/act, drops or adds the venue name, uses different capitalisation, or one source lists a series name and the other the specific session.

Different events: different performances, different sessions of a run on different dates, a series versus one instalment where the dates clearly differ, or two unrelated things that merely share a generic name ("Trivia Night" at two different venues, "Life Drawing" at two different studios).

When the venues differ and neither is a plausible alias of the other, answer false.

For each numbered pair, output {"i": <index>, "same": true|false}. Return ONLY a compact JSON array, no markdown, no commentary.`;

function parseVerdicts(raw: string): Map<number, boolean> {
	const out = new Map<number, boolean>();
	for (const item of parseJsonArray<Record<string, unknown>>(raw)) {
		if (typeof item?.i === "number") out.set(item.i, item.same === true);
	}
	return out;
}

function summarise(e: Record<string, unknown>): Record<string, unknown> {
	return {
		title: e.title,
		venue: e.location,
		date: e.datetime_iso,
		source: e.source,
	};
}

export function createGeminiPairClassifier(): PairClassifyFn {
	return async function classify(pairs: CandidatePair[]): Promise<boolean[]> {
		const batches = chunkArray(pairs, PAIR_BATCH_SIZE);
		// One prompt per batch, all in flight under llm's Gemini limiter (the
		// process-wide ceiling; MAX_PAIRS allows ~100 batches and an uncapped
		// fan-out at that width just earns 429s).
		const outcomes = await askDetailed(
			batches.map((batch) =>
				JSON.stringify(
					batch.map((p, i) => ({ i, a: summarise(p.a), b: summarise(p.b) })),
				),
			),
			{
				provider: "gemini",
				model: MODEL,
				stage: "dedupe",
				system: SYSTEM_PROMPT,
				maxOutputTokens: 4000,
				temperature: 0,
			},
		);
		return batches.flatMap((batch, batchIdx) => {
			const outcome = outcomes[batchIdx];
			if (outcome.status === "rejected") {
				console.error(
					`  ⚠ [dedupe] pair batch ${batchIdx + 1} failed: ${(outcome.reason as Error).message} — keeping both sides`,
				);
				return batch.map(() => false);
			}
			const verdicts = parseVerdicts(outcome.value.text);
			// Unanswered pair → false: keeping both is recoverable (a visible
			// duplicate), wrongly merging is not (a lost event).
			return batch.map((_, i) => verdicts.get(i) === true);
		});
	};
}
