// The LLM half of dedupe.ts's stage 2. Kept separate so dedupe.ts stays a
// pure, network-free module that tests can drive with a stub.

import { GoogleGenAI } from "@google/genai";
import { chunkArray } from "./providers/base.ts";
import { type CandidatePair, PAIR_BATCH_SIZE, type PairClassifyFn } from "./dedupe.ts";

const MODEL = "gemini-3.1-flash-lite";

const SYSTEM_PROMPT = `You decide whether two event listings describe the SAME real-world event, gathered from different sources that word things differently.

Same event: the same happening at the same venue on the same date, even if one title is longer, includes the lineup/act, drops or adds the venue name, uses different capitalisation, or one source lists a series name and the other the specific session.

Different events: different performances, different sessions of a run on different dates, a series versus one instalment where the dates clearly differ, or two unrelated things that merely share a generic name ("Trivia Night" at two different venues, "Life Drawing" at two different studios).

When the venues differ and neither is a plausible alias of the other, answer false.

For each numbered pair, output {"i": <index>, "same": true|false}. Return ONLY a compact JSON array, no markdown, no commentary.`;

function parseVerdicts(raw: string): Map<number, boolean> {
	const out = new Map<number, boolean>();
	const cleaned = raw.replace(/```json|```/g, "").trim();
	const start = cleaned.indexOf("[");
	if (start === -1) return out;
	let jsonStr = cleaned.slice(start);
	const end = jsonStr.lastIndexOf("]");
	if (end !== -1) jsonStr = jsonStr.slice(0, end + 1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		const lastComplete = jsonStr.lastIndexOf("},");
		if (lastComplete === -1) return out;
		try {
			parsed = JSON.parse(`${jsonStr.slice(0, lastComplete + 1)}]`);
		} catch {
			return out;
		}
	}
	if (!Array.isArray(parsed)) return out;
	for (const item of parsed) {
		const rec = item as Record<string, unknown>;
		if (typeof rec?.i === "number") out.set(rec.i, rec.same === true);
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
		const results = await Promise.all(
			batches.map(async (batch, batchIdx) => {
				const input = batch.map((p, i) => ({
					i,
					a: summarise(p.a),
					b: summarise(p.b),
				}));
				try {
					const response = await ai.models.generateContent({
						model: MODEL,
						contents: JSON.stringify(input),
						config: {
							systemInstruction: SYSTEM_PROMPT,
							maxOutputTokens: 4000,
							temperature: 0,
						},
					});
					const verdicts = parseVerdicts(response.text ?? "");
					// Unanswered pair → false: keeping both is recoverable (a visible
					// duplicate), wrongly merging is not (a lost event).
					return batch.map((_, i) => verdicts.get(i) === true);
				} catch (err) {
					console.error(
						`  ⚠ [dedupe] pair batch ${batchIdx + 1} failed: ${(err as Error).message} — keeping both sides`,
					);
					return batch.map(() => false);
				}
			}),
		);
		return results.flat();
	};
}
