// The LLM half of dedupe.ts's stage 2. Kept separate so dedupe.ts stays a
// pure, network-free module that tests can drive with a stub.

import { GoogleGenAI } from "@google/genai";
import {
	type CandidatePair,
	PAIR_BATCH_SIZE,
	type PairClassifyFn,
} from "./dedupe.ts";
import {
	chunkArray,
	mapWithConcurrency,
	parseJsonArray,
} from "./providers/base.ts";
import { geminiText } from "./providers/gemini.ts";

const MODEL = "gemini-3.1-flash-lite";
/** Concurrent classifier calls. Bounded because MAX_PAIRS allows ~67 batches,
 * and an uncapped fan-out at that width just earns 429s. */
const MAX_CONCURRENT_CALLS = 6;

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

export function createGeminiPairClassifier(apiKey: string): PairClassifyFn {
	const ai = new GoogleGenAI({ apiKey });

	return async function classify(pairs: CandidatePair[]): Promise<boolean[]> {
		const batches = chunkArray(pairs, PAIR_BATCH_SIZE);
		const results = await mapWithConcurrency(
			batches,
			MAX_CONCURRENT_CALLS,
			async (batch, batchIdx) => {
				const input = batch.map((p, i) => ({
					i,
					a: summarise(p.a),
					b: summarise(p.b),
				}));
				try {
					const text = await geminiText(ai, {
						stage: "dedupe",
						model: MODEL,
						contents: JSON.stringify(input),
						systemInstruction: SYSTEM_PROMPT,
						maxOutputTokens: 4000,
						temperature: 0,
					});
					const verdicts = parseVerdicts(text);
					// Unanswered pair → false: keeping both is recoverable (a visible
					// duplicate), wrongly merging is not (a lost event).
					return batch.map((_, i) => verdicts.get(i) === true);
				} catch (err) {
					console.error(
						`  ⚠ [dedupe] pair batch ${batchIdx + 1} failed: ${(err as Error).message} — keeping both sides`,
					);
					return batch.map(() => false);
				}
			},
		);
		return results.flat();
	};
}
