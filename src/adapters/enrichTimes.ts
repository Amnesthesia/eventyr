// Recovers the time of day for candidates that only got a date.
//
// Listing pages very often print just "Sat 5 Sep" while the event's own page
// says "Saturday 05 Sep 2026, 10:30AM". 280 of 643 events — 43% — came
// through date-only for exactly this reason, and 279 of them carry a URL we
// can follow. Nothing here is a parsing problem: dates.ts reads the detail
// page's string correctly the moment it sees it.
//
// Deterministic and LLM-free: JSON-LD if the page has it, otherwise dates.ts
// over datetime-shaped substrings of the page text.
//
// The safety property that makes this worth doing: an enriched candidate may
// only gain a TIME on the day it already had. A detail page is full of other
// dates — related events, "posted on", a footer — so a value whose calendar
// day differs is discarded rather than trusted. The worst case is that a
// candidate stays exactly as the listing had it.

import { readFileSync } from "node:fs";
import { mapWithConcurrency } from "../providers/base.ts";
import { parseSingleDateTime } from "./dates.ts";
import { extractJsonLdBlocks, findEventNodes } from "./extract.ts";
import { stripToReadableText } from "./readableText.ts";
import type { CandidateEvent, Fetcher, SourceDefinition } from "./types.ts";

/** Detail pages fetched at once. The fetcher applies its own per-host limit;
 * this only bounds how much of the queue is in flight. */
const CONCURRENCY = 4;
/** Per source, so one listing with 200 undated rows cannot open 200 fetches. */
const MAX_FETCHES_PER_SOURCE = 40;

/**
 * Datetime-shaped substrings, requiring a time — a date alone is no use here.
 * Both orders, because a detail page may write either.
 */
const DATETIME_WITH_TIME =
	/(?:[A-Za-z]{3,9},?\s+)?\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4},?\s*(?:at\s*)?\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?|(?:[A-Za-z]{3,9},?\s+)?[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4},?\s*(?:at\s*)?\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?/gi;

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

/** The page's own structured start, if it published one. */
function fromJsonLd(body: string, referenceDate: Date): string | null {
	for (const node of findEventNodes(extractJsonLdBlocks(body))) {
		const raw = node.startDate;
		if (typeof raw !== "string" || !raw) continue;
		const parsed = parseSingleDateTime(raw, referenceDate);
		if (parsed && hasTime(parsed)) return parsed;
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
		const parsed = parseSingleDateTime(match[0], referenceDate);
		// Same day as the listing already told us, and actually carrying a time.
		if (parsed && hasTime(parsed) && sameDay(parsed, want)) return parsed;
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
			const found =
				fromJsonLd(body, referenceDate) ??
				fromText(body, url, want, referenceDate);
			// JSON-LD is trusted for the day as well as the time — it is the
			// page's own structured claim — but text is only ever allowed to add
			// a time to the day we already had.
			if (found && (sameDay(found, want) || fromJsonLd(body, referenceDate))) {
				upgrades.set(candidate, found);
			}
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
