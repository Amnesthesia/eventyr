// The one editorial pass over scraped events: assigns the fixed CATEGORIES
// value, tags, and the four vibe booleans rank.ts and the frontend filter on.
//
// Everything factual (title, dates, venue, price, link) is already settled
// deterministically by normalise.ts and is NOT sent back out for rewriting —
// the model only sees what it needs to classify, and only its judgement
// fields are merged back. Mirrors the vibe/tag definitions in
// BaseProvider.buildFormatSystem so an adapter-sourced event scores the same
// way an AI-search one does.

import { GoogleGenAI } from "@google/genai";
import { CATEGORIES } from "../common.ts";
import {
	chunkArray,
	mapWithConcurrency,
	parseJsonArray,
} from "../providers/base.ts";
import { geminiText } from "../providers/gemini.ts";
import { isValidCategory } from "./normalise.ts";

const ANNOTATE_MODEL = "gemini-3.1-flash-lite";
// Annotation classifies each event independently — no cross-item
// reasoning — so a bigger batch costs accuracy far less than extraction
// would, and halves the calls.
const BATCH_SIZE = 40;
/** Concurrent annotate calls per source. */
const MAX_CONCURRENT_CALLS = 6;

export interface Annotation {
	category: string;
	tags: string[];
	social: boolean;
	intellectual: boolean;
	hands_on: boolean;
	creative: boolean;
	description?: string;
	drop: boolean;
}

export type AnnotateFn = (
	events: Record<string, unknown>[],
	sourceName: string,
) => Promise<Annotation[]>;

const SYSTEM_PROMPT = `You are classifying events that have already been extracted from a venue's own listing page. The factual details (title, date, venue, price, link) are already known and correct — do not restate, rewrite, or second-guess them.

For each event you are given, decide only:

- "category": EXACTLY one of ${CATEGORIES.map((c) => `"${c}"`).join(", ")}. Pick the closest fit; use "Community / Other" when nothing else fits.
- "tags": 3-4 short lowercase topic tags (e.g. "jazz", "free", "outdoor", "philosophy"). No hashes, no punctuation.
- "social": true if the main draw is meeting/being around other people (meetups, socials, parties, markets).
- "intellectual": true if it is talk-, idea- or learning-led (lectures, panels, debates, science/philosophy/history).
- "hands_on": true if attendees actively make or do something (workshops, classes, participatory sessions).
- "creative": true if it is arts-led (exhibitions, performance, film, music, literature, design).
  More than one of these may be true. All four may be false.
- "description": ONLY when the input description is empty — then write one plain sentence describing the event using nothing but the title, venue and category given. Invent no facts (no lineups, no prices, no times). If the input description is non-empty, omit this field entirely.
- "drop": true ONLY for things this digest never lists: spectator sport, MLM/network marketing, sales pitches or product demos, purely online/streamed events, and private hire/venue-booking listings. Everything else is false. Do NOT drop something for being niche, mainstream, small, or uninteresting.

Return ONLY a compact JSON array, one object per input event, in the same order, each with an "i" field echoing the input index. No markdown, no code fences, no commentary.`;

/** A missing/unparsable annotation must never lose the event — it falls back
 * to a usable, if unopinionated, classification. */
function defaultAnnotation(): Annotation {
	return {
		category: "Community / Other",
		tags: [],
		social: false,
		intellectual: false,
		hands_on: false,
		creative: false,
		drop: false,
	};
}

function coerce(raw: Record<string, unknown> | undefined): Annotation {
	if (!raw) return defaultAnnotation();
	const tags = Array.isArray(raw.tags)
		? raw.tags.filter((t): t is string => typeof t === "string").slice(0, 4)
		: [];
	const description =
		typeof raw.description === "string" && raw.description.trim()
			? raw.description.trim()
			: undefined;
	return {
		category: isValidCategory(raw.category)
			? raw.category
			: "Community / Other",
		tags,
		social: raw.social === true,
		intellectual: raw.intellectual === true,
		hands_on: raw.hands_on === true,
		creative: raw.creative === true,
		...(description ? { description } : {}),
		drop: raw.drop === true,
	};
}

export function createGeminiAnnotator(apiKey: string): AnnotateFn {
	const ai = new GoogleGenAI({ apiKey });

	return async function annotate(events, sourceName) {
		const batches = chunkArray(events, BATCH_SIZE);
		const results = await mapWithConcurrency(
			batches,
			MAX_CONCURRENT_CALLS,
			async (batch, batchIdx) => {
				const input = batch.map((e, i) => ({
					i,
					title: e.title,
					description: e.description,
					location: e.location,
					source: e.source,
				}));
				try {
					const text = await geminiText(ai, {
						stage: "annotate",
						model: ANNOTATE_MODEL,
						contents: `Source: ${sourceName}\n\nEvents:\n${JSON.stringify(input)}`,
						systemInstruction: SYSTEM_PROMPT,
						maxOutputTokens: 8000,
						temperature: 0.1,
					});
					const parsed = parseJsonArray<Record<string, unknown>>(text);
					const byIndex = new Map<number, Record<string, unknown>>();
					for (const p of parsed) {
						if (typeof p?.i === "number") byIndex.set(p.i, p);
					}
					return batch.map((_, i) => coerce(byIndex.get(i)));
				} catch (err) {
					console.error(
						`  ⚠ [annotate/${sourceName}] batch ${batchIdx + 1} failed: ${(err as Error).message} — keeping events unclassified`,
					);
					return batch.map(() => defaultAnnotation());
				}
			},
		);
		return results.flat();
	};
}

/** Merges judgement fields onto the deterministic event. Factual fields are
 * never touched; description is only filled when the page had none. */
export function applyAnnotation(
	event: Record<string, unknown>,
	a: Annotation,
): Record<string, unknown> {
	return {
		...event,
		category: a.category,
		tags: a.tags,
		social: a.social,
		intellectual: a.intellectual,
		hands_on: a.hands_on,
		creative: a.creative,
		description: (event.description as string) || (a.description ?? ""),
	};
}
