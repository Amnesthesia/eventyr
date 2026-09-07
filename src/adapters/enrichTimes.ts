// Recovers the time of day for candidates that only got a date.
//
// Listing pages very often print just "Sat 5 Sep" while the event's own page
// says "Saturday 05 Sep 2026, 10:30AM". 280 of 643 events — 43% — came
// through date-only for exactly this reason, and 279 of them carry a URL we
// can follow. Nothing here is a parsing problem: dates.ts reads the detail
// page's string correctly the moment it sees it.
//
// Deterministic and LLM-free: JSON-LD if the page has it, then the page's own
// hydration JSON, then a labelled time in the text, then a full datetime in
// the text. Every one of them hands its find to dates.ts — nothing here does
// date arithmetic of its own.
//
// The four extractors exist because the first two versions of this file only
// looked for a date and a time sitting NEXT to each other with a four-digit
// year, and most pages do not write them that way. Good Chat Comedy writes
// "Date: Sep 15 2026" and "Time: 7:00pm - 8:00pm" in separate fields; The
// Triffid writes a bare "5PM". Both were invisible, and both are the common
// case, so 0 of 24 and 0 of 6 of their events ever gained a time.
//
// The safety property that makes this worth doing: an enriched candidate may
// only gain a TIME on the day it already had. A detail page is full of other
// dates — related events, "posted on", a footer — so a value whose calendar
// day differs is discarded rather than trusted. The worst case is that a
// candidate stays exactly as the listing had it.

import { readFileSync } from "node:fs";
import { mapWithConcurrency } from "../providers/base.ts";
import { parseSingleDateTime } from "./dates.ts";
import { extractEmbeddedJson } from "./embeddedJson.ts";
import { extractJsonLdBlocks, findEventNodes } from "./extract.ts";
import { stripToReadableText } from "./readableText.ts";
import type { CandidateEvent, Fetcher, SourceDefinition } from "./types.ts";

/** Detail pages fetched at once. The fetcher applies its own per-host limit;
 * this only bounds how much of the queue is in flight. */
const CONCURRENCY = 4;
/** Per source, so one listing with 200 undated rows cannot open 200 fetches.
 * 80 rather than 40 because Brisbane Festival alone lists 54 date-only events
 * and the tail was never even attempted. */
const MAX_FETCHES_PER_SOURCE = 80;

/**
 * Datetime-shaped substrings, requiring a time — a date alone is no use here.
 * Both orders, because a detail page may write either.
 */
const DATETIME_WITH_TIME =
	/(?:[A-Za-z]{3,9},?\s+)?\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4},?\s*(?:at\s*)?\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?|(?:[A-Za-z]{3,9},?\s+)?[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4},?\s*(?:at\s*)?\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?/gi;

/**
 * A clock reading under a label that says it is the event's own start.
 *
 * Labelled rather than "the first time on the page" on purpose: a venue page
 * carries opening hours, a box-office number and a footer, and any of those
 * would win a first-match race and put a confidently wrong start time on the
 * site. A label is the page telling us which one it means.
 */
const LABELLED_TIME =
	/\b(?:times?|doors?(?:\s+open)?|starts?|start(?:ing)?\s+time|show(?:time)?|session|kick[\s-]?off)\b\s*[:\-–—]?\s*(\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?|\d{1,2}\s*[ap]\.?m\.?|\d{1,2}:\d{2})/gi;

/** A clock reading with no date attached, which is what both the JSON and the
 * labelled-text extractors find. */
const TIME_ONLY = /^\d{1,2}(?:[:.]\d{2})?\s*(?:[ap]\.?m\.?)?$/i;

/** JSON keys that hold a start, a door time or a session time. Matched by
 * pattern for the same reason embeddedJson.ts does it: every site names these
 * differently, and an exhaustive literal list is a losing game. */
const TIME_KEY =
	/^(?:start|begin|door|show|session)?_?(?:date_?)?times?$|^(?:starts?|begins?|doors?)(?:_?at)?$/i;

/** A candidate whose start is midnight has a date but no time.
 * ponytail: a genuine midnight event is indistinguishable — the same
 * limitation normalise.ts's brisbaneNaive already documents. */
function needsTime(candidate: CandidateEvent): boolean {
	const iso = candidate.startISO;
	if (!iso) return false;
	return /T00:00:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})?$/.test(iso);
}

function sameDay(a: string, b: string): boolean {
	return a.slice(0, 10) === b.slice(0, 10);
}

function hasTime(iso: string): boolean {
	return !/T00:00:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})?$/.test(iso);
}

/**
 * Resolves one found string against the day we already have.
 *
 * A bare clock reading is grafted onto that day by handing dates.ts the date
 * it is missing, rather than by building an instant here: date arithmetic is
 * the parser's job, and every previous attempt to shortcut it in this codebase
 * became a bug. Anything with its own date is parsed whole and then has to
 * agree with the day we started from.
 */
function timeOnDay(
	raw: string,
	want: string,
	referenceDate: Date,
): string | null {
	const text = raw.trim();
	if (!text) return null;
	const parsed = parseSingleDateTime(
		TIME_ONLY.test(text) ? `${want.slice(0, 10)} ${text}` : text,
		referenceDate,
	);
	return parsed && hasTime(parsed) && sameDay(parsed, want) ? parsed : null;
}

/** The page's own structured start, if it published one. Trusted for the day
 * as well as the time — it is the page's own machine-readable claim. */
function fromJsonLd(body: string, referenceDate: Date): string | null {
	for (const node of findEventNodes(extractJsonLdBlocks(body))) {
		const raw = node.startDate;
		if (typeof raw !== "string" || !raw) continue;
		const parsed = parseSingleDateTime(raw, referenceDate);
		if (parsed && hasTime(parsed)) return parsed;
	}
	return null;
}

/**
 * The hydration state a Next.js/Nuxt page ships, where a listing's bare date
 * is often accompanied by the time the rendered HTML never spells out.
 *
 * Only string values under a time-shaped key are considered, and the walk is
 * depth-capped: a 400 KB blob must not be able to open an unbounded search.
 */
function fromEmbeddedJson(
	body: string,
	want: string,
	referenceDate: Date,
): string | null {
	const seen = new Set<unknown>();
	function visit(node: unknown, depth: number): string | null {
		if (depth > 12 || node === null || typeof node !== "object") return null;
		if (seen.has(node)) return null;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const item of node) {
				const found = visit(item, depth + 1);
				if (found) return found;
			}
			return null;
		}
		for (const [key, value] of Object.entries(node)) {
			if (typeof value === "string" && TIME_KEY.test(key)) {
				const found = timeOnDay(value, want, referenceDate);
				if (found) return found;
			} else if (value && typeof value === "object") {
				const found = visit(value, depth + 1);
				if (found) return found;
			}
		}
		return null;
	}
	for (const blob of extractEmbeddedJson(body)) {
		const found = visit(blob, 0);
		if (found) return found;
	}
	return null;
}

/** A clock reading the page labelled as the start. This is the case that
 * recovers "Date: Sep 15 2026   Time: 7:00pm - 8:00pm", where the date and the
 * time are in different fields and no regex spanning both can see them. */
function fromLabelledTime(
	body: string,
	url: string,
	want: string,
	referenceDate: Date,
): string | null {
	const text = stripToReadableText(body, url);
	for (const match of text.matchAll(LABELLED_TIME)) {
		const found = timeOnDay(match[1], want, referenceDate);
		if (found) return found;
	}
	return null;
}

/** Otherwise, the first datetime in the page text that has a time on it. */
function fromText(
	body: string,
	url: string,
	want: string,
	referenceDate: Date,
): string | null {
	const text = stripToReadableText(body, url);
	for (const match of text.matchAll(DATETIME_WITH_TIME)) {
		const found = timeOnDay(match[0], want, referenceDate);
		if (found) return found;
	}
	return null;
}

export interface EnrichStats {
	/** Candidates that had a date but no time. */
	eligible: number;
	/** Detail pages actually fetched. */
	fetched: number;
	/** Candidates that gained a time. */
	upgraded: number;
	/** Which extractor found it. A ratio per extractor is the only way to see
	 * that one of them has rotted — a total alone cannot. */
	via: Record<Extractor, number>;
}

type Extractor = "jsonLd" | "embedded" | "label" | "text";

/**
 * Cheapest and most trustworthy first, and the first hit wins.
 *
 * JSON-LD is the page's own structured claim; hydration JSON is the same data
 * one layer down; a labelled time is the page saying so in prose; a bare
 * datetime match is the weakest and stays last.
 */
function findTime(
	body: string,
	url: string,
	want: string,
	referenceDate: Date,
): { iso: string; via: Extractor } | null {
	const jsonLd = fromJsonLd(body, referenceDate);
	// JSON-LD is trusted for the day as well as the time; the rest may only add
	// a time to the day the listing already gave us, which timeOnDay enforces.
	if (jsonLd) return { iso: jsonLd, via: "jsonLd" };
	const embedded = fromEmbeddedJson(body, want, referenceDate);
	if (embedded) return { iso: embedded, via: "embedded" };
	const label = fromLabelledTime(body, url, want, referenceDate);
	if (label) return { iso: label, via: "label" };
	const text = fromText(body, url, want, referenceDate);
	return text ? { iso: text, via: "text" } : null;
}

export async function enrichCandidateTimes(
	candidates: CandidateEvent[],
	source: SourceDefinition | undefined,
	fetcher: Fetcher,
	referenceDate: Date = new Date(),
): Promise<{ candidates: CandidateEvent[]; stats: EnrichStats }> {
	const eligible = candidates.filter(
		(c) => needsTime(c) && (c.url ?? "").startsWith("http"),
	);
	const stats: EnrichStats = {
		eligible: eligible.length,
		fetched: 0,
		upgraded: 0,
		via: { jsonLd: 0, embedded: 0, label: 0, text: 0 },
	};
	if (!source || eligible.length === 0) return { candidates, stats };

	const queue = eligible.slice(0, MAX_FETCHES_PER_SOURCE);
	const upgrades = new Map<CandidateEvent, string>();

	await mapWithConcurrency(queue, CONCURRENCY, async (candidate) => {
		const url = candidate.url as string;
		const want = candidate.startISO as string;
		try {
			const listing = await fetcher.fetch(source.id, url, "html");
			stats.fetched++;
			if (!listing.bodyPath) return;
			const body = readFileSync(listing.bodyPath, "utf-8");
			const found = findTime(body, url, want, referenceDate);
			if (!found) return;
			upgrades.set(candidate, found.iso);
			stats.via[found.via]++;
		} catch {
			// A detail page that will not load leaves the candidate as it was.
		}
	});

	stats.upgraded = upgrades.size;
	return {
		candidates: candidates.map((c) => {
			const better = upgrades.get(c);
			return better ? { ...c, startISO: better } : c;
		}),
		stats,
	};
}
