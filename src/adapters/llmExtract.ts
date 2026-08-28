// LLM-backed extraction for the "html" strategy fallback: turns already-
// fetched, already-reduced page text into RawCandidateFields. This is the
// only place in the adapter framework an LLM is invoked, and it never
// fetches or searches anything — the page text is handed to it complete.
// Mirrors the existing extract pass in src/providers/base.ts
// (buildExtractSystem/parseEvents) — same "copy, don't invent" contract —
// just fed from our own deterministic fetch instead of a search tool's
// output, which is the whole point of this refactor.
//
// Dates are asked for as raw text only and are never trusted from the
// model's own output — candidate.ts resolves startRaw/endRaw through
// dates.ts afterwards, same as the JSON-LD path.

import { GoogleGenAI } from "@google/genai";
import { splitIntoBatches } from "../providers/base.ts";
import type { PageExtractFn, RawCandidateFields } from "./types.ts";

const EXTRACT_MODEL = "gemini-3.1-flash-lite";
const MAX_OUTPUT_TOKENS = 16000;

const SYSTEM_PROMPT = `You are extracting structured event data from the text of one already-fetched web page. You have no ability to browse, search, or fetch anything else — work only from the text given to you.

Your ONLY job is extraction. Do not filter, judge relevance, or categorise. Do not clean up, shorten, or rewrite anything.

Rules — follow these strictly:
- Copy every field's value EXACTLY as written on the page. Never invent, infer, paraphrase, or compute a value.
- If a field is not present on the page for a given event, output null for it. Never guess, default, or fill it from another field (e.g. never invent a date from the title).
- For dates and times, copy the raw text exactly as it appears (e.g. "Sat 14 Jun, 7:00 PM" or "5 – 19 September"). Do NOT convert it to ISO format or compute what date it means — that happens elsewhere.
- Extract every distinct event on the page, including every row of a list or table. If the same event is mentioned more than once, list it once.
- If the page text describes a single exhibition/season with multiple listed session dates, that is still one event — extraction here is about full listing pages showing many different events, not about splitting one event's sessions apart.
- If the page has no events at all, or is just a listing shell with no separately identifiable events (e.g. navigation, an empty calendar view), output an empty array.

For each event found, produce a JSON object with exactly these fields:
{
  "title": string or null,
  "description": string or null,
  "startRaw": string or null,
  "endRaw": string or null,
  "venueName": string or null,
  "address": string or null,
  "url": string or null,
  "price": string or null,
  "imageUrl": string or null,
  "organiser": string or null,
  "category": string or null,
  "sourceEventId": string or null
}

Output ONLY a valid compact JSON array of these objects — no markdown, no code fences, no explanation, no whitespace/newlines between elements.`;

function buildUserPrompt(pageText: string, sourceName: string): string {
	return `Source: ${sourceName}\n\nPage text:\n${pageText}`;
}

/** Same truncation-recovery approach as BaseProvider.parseEvents in
 * src/providers/base.ts — kept local since that method is tied to the
 * provider/search abstraction, not exported standalone. */
function parseJsonArray(raw: string, label: string): RawCandidateFields[] {
	const cleaned = raw.replace(/```json|```/g, "").trim();
	const start = cleaned.indexOf("[");
	if (start === -1) return [];
	let jsonStr = cleaned.slice(start);
	const end = jsonStr.lastIndexOf("]");
	if (end !== -1) jsonStr = jsonStr.slice(0, end + 1);
	try {
		return JSON.parse(jsonStr) as RawCandidateFields[];
	} catch {
		const lastComplete = jsonStr.lastIndexOf("},");
		if (lastComplete === -1) {
			console.log(
				`  ✗ [${label}] Could not parse or recover JSON from extraction response`,
			);
			return [];
		}
		try {
			return JSON.parse(
				`${jsonStr.slice(0, lastComplete + 1)}]`,
			) as RawCandidateFields[];
		} catch {
			console.log(`  ✗ [${label}] Could not recover from truncated JSON`);
			return [];
		}
	}
}

function isEmptyFields(f: RawCandidateFields): boolean {
	return !f.title && !f.startRaw && !f.url;
}

export function createGeminiPageExtractor(apiKey: string): PageExtractFn {
	const ai = new GoogleGenAI({ apiKey });

	async function extractBatch(
		pageText: string,
		sourceName: string,
	): Promise<RawCandidateFields[]> {
		const label = `llmExtract/${sourceName}`;
		const response = await ai.models.generateContent({
			model: EXTRACT_MODEL,
			contents: buildUserPrompt(pageText, sourceName),
			config: {
				systemInstruction: SYSTEM_PROMPT,
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				temperature: 0.1,
			},
		});
		const events = parseJsonArray(response.text ?? "", label);
		// Drop entries that carry nothing usable — a stray heading or nav
		// fragment the model mistook for an event, not a real extraction.
		return events.filter((e) => !isEmptyFields(e));
	}

	return async function extractPage(
		pageText: string,
		sourceName: string,
	): Promise<RawCandidateFields[]> {
		const batches = splitIntoBatches(pageText, 12000);
		const results = await Promise.all(
			batches.map((batch) => extractBatch(batch, sourceName)),
		);
		return results.flat();
	};
}
