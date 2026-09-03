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

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
	mapWithConcurrency,
	parseJsonArray,
	splitIntoBatches,
} from "../providers/base.ts";
import { geminiText } from "../providers/gemini.ts";
import type { PageExtractFn, RawCandidateFields } from "./types.ts";

const EXTRACT_MODEL = "gemini-3.1-flash-lite";
const MAX_OUTPUT_TOKENS = 16000;
/** Extraction calls per page — see the note in extractPage. */
const MAX_BATCHES_PER_PAGE = 4;
/** Below this much page text, an empty extraction is plausible rather than suspicious. */
const RETRY_MIN_TEXT = 2000;
/** Concurrent extraction calls per page. */
const MAX_CONCURRENT_CALLS = 3;

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

function isEmptyFields(f: RawCandidateFields): boolean {
	return !f.title && !f.startRaw && !f.url;
}

export interface ExtractorOptions {
	/**
	 * Retry once when a substantial page yields nothing. Right for scraping a
	 * listing page we already know is good; wrong for probing, where most
	 * candidate pages genuinely have no events and the retry doubles the cost
	 * of confirming the common negative.
	 */
	retryOnEmpty?: boolean;
	/** Extraction calls per page. Probing needs the top of the page only. */
	maxBatches?: number;
	/** Groups this extractor's spend in the usage summary. */
	stage?: string;
}

export function createGeminiPageExtractor(
	apiKey: string,
	options: ExtractorOptions = {},
): PageExtractFn {
	const {
		retryOnEmpty = true,
		maxBatches = MAX_BATCHES_PER_PAGE,
		stage = "extract",
	} = options;
	const ai = new GoogleGenAI({ apiKey });

	async function callModel(
		pageText: string,
		sourceName: string,
	): Promise<RawCandidateFields[]> {
		const label = `llmExtract/${sourceName}`;
		// systemInstruction is a module constant and identical on every call,
		// which is what lets provider prefix caching hit; only the page text
		// varies.
		const text = await geminiText(ai, {
			stage,
			model: EXTRACT_MODEL,
			contents: buildUserPrompt(pageText, sourceName),
			systemInstruction: SYSTEM_PROMPT,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			temperature: 0.1,
		});
		const events = parseJsonArray<RawCandidateFields>(text, label);
		// Drop entries that carry nothing usable — a stray heading or nav
		// fragment the model mistook for an event, not a real extraction.
		return events.filter((e) => !isEmptyFields(e));
	}

	/**
	 * Retries once when a substantial page yields nothing.
	 *
	 * An empty result is not a trustworthy answer: a page with thousands of
	 * characters of dated text that extracts to zero events is far more likely
	 * a dropped call than a genuinely empty listing. Observed live — Queensland
	 * Writers Centre reported "0 found" on a page that yields 12 events on the
	 * next attempt, and because an empty array looks exactly like a quiet week
	 * the source was silently marked barren.
	 */
	async function extractBatch(
		pageText: string,
		sourceName: string,
	): Promise<RawCandidateFields[]> {
		try {
			const events = await callModel(pageText, sourceName);
			if (
				events.length > 0 ||
				!retryOnEmpty ||
				pageText.length < RETRY_MIN_TEXT
			) {
				return events;
			}
			console.error(
				`  ⚠ [llmExtract/${sourceName}] nothing extracted from ${pageText.length} chars — retrying once`,
			);
		} catch (err) {
			console.error(
				`  ⚠ [llmExtract/${sourceName}] ${(err as Error).message} — retrying once`,
			);
		}
		try {
			return await callModel(pageText, sourceName);
		} catch (err) {
			console.error(
				`  ✗ [llmExtract/${sourceName}] extraction failed twice: ${(err as Error).message}`,
			);
			return [];
		}
	}

	/**
	 * Writes the exact text the model was given to a temp file and logs the
	 * path. When a substantial page extracts to nothing, the page text is the
	 * only thing that answers why — and it is gone the moment the run ends,
	 * which previously meant reproducing the whole fetch to investigate.
	 */
	function dumpForInspection(pageText: string, sourceName: string): void {
		const slug = sourceName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.slice(0, 40);
		const path = join(
			tmpdir(),
			`eventyr-empty-extraction-${slug}-${Date.now()}.txt`,
		);
		try {
			writeFileSync(path, pageText, "utf-8");
			console.error(
				`      ↳ page text (${pageText.length} chars) written for inspection: ${path}`,
			);
		} catch (err) {
			console.error(
				`      ↳ could not write page text: ${(err as Error).message}`,
			);
		}
	}

	return async function extractPage(
		pageText: string,
		sourceName: string,
	): Promise<RawCandidateFields[]> {
		// Cap the fan-out. A single 389 KB listing page reduced to 171 KB of
		// text produced 16 concurrent 12K-token calls, and page size is
		// entirely up to the site — across ~84 listing URLs per city that is
		// the difference between a bounded run and an open-ended bill. The
		// first batches hold the listing itself; later ones are footer and
		// related-content boilerplate.
		const batches = splitIntoBatches(pageText, 12000).slice(0, maxBatches);
		const results = await mapWithConcurrency(
			batches,
			MAX_CONCURRENT_CALLS,
			(batch) => extractBatch(batch, sourceName),
		);
		const events = results.flat();
		if (
			retryOnEmpty &&
			events.length === 0 &&
			pageText.length >= RETRY_MIN_TEXT
		) {
			console.error(
				`  ⚠ [llmExtract/${sourceName}] nothing extracted from ${pageText.length} chars of page text`,
			);
			dumpForInspection(pageText, sourceName);
		}
		return events;
	};
}
