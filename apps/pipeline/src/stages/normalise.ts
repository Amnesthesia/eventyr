// The pipeline's half of normalisation: the publishing window, the council
// link rewrite and the deterministic pre-pass that applies both to what the
// scraper extracted. The CandidateEvent → event mapping itself is
// @dothingslol/scraper's (candidateToEvent); this file decides which of those
// events belong to the week being published.

import { CATEGORIES, type Category } from "@dothingslol/core/shared";
import {
	type CandidateEvent,
	candidateToEvent,
	type ScrapedEvent,
} from "@dothingslol/scraper";
import type { SourceDefinition } from "../sources/types.js";

/**
 * Keeps events overlapping the publishing window, which runs from TODAY (not
 * the Monday — a Wednesday run must not resurrect Monday's finished events)
 * through the end of next week. Showing next week's events early is harmless;
 * showing last night's is not.
 *
 * Interval overlap rather than start-only, so a multi-day exhibition that
 * opened last month and runs through next week still surfaces — but a one-off
 * that has already happened does not.
 */
export function withinWindow(
	startNaive: string | null,
	endNaive: string | null,
	from: string,
	to: string,
): boolean {
	if (!startNaive) return false;
	const start = startNaive.slice(0, 10);
	const end = (endNaive ?? startNaive).slice(0, 10);
	return start <= to && end >= from;
}

/** Whether an event has already finished, which is the signal that a listing
 * URL points at an archive rather than a programme. */
export function isPast(
	startNaive: string | null,
	endNaive: string | null,
	from: string,
): boolean {
	if (!startNaive) return false;
	return (endNaive ?? startNaive).slice(0, 10) < from;
}

/**
 * Brisbane City Council's event links point at its Trumba embed page
 * (brisbane.qld.gov.au/trumba?trumbaEmbed=view%3Devent%26eventid%3D…), which
 * lands on the council's event search rather than the event. Every council
 * calendar is a child of `brisbane-city-council`, whose hosted page renders any
 * of their events — verified for events from the citywide, LIVE and parks
 * feeds. Matches the unescaped form too, in case a source hands it over decoded.
 * feeds.ts already builds these for Trumba feeds; curate.ts's cleanEvent
 * applies this to every other path that carries the same link — Riverstage's
 * open-data records, AI-search results, and events carried forward.
 */
const COUNCIL_TRUMBA_EMBED =
	/^https?:\/\/(?:www\.)?brisbane\.qld\.gov\.au\/[^?#]*\?trumbaEmbed=view(?:%3D|=)event(?:%26|&)eventid(?:%3D|=)(\d+)/i;

export function councilEventUrl(url: string | null | undefined): string | null {
	const id = url ? COUNCIL_TRUMBA_EMBED.exec(url)?.[1] : undefined;
	return id
		? `https://www.trumba.com/calendars/brisbane-city-council?eventid=${id}`
		: (url ?? null);
}

export function isValidCategory(v: unknown): v is Category {
	return CATEGORIES.includes(v as Category);
}

export interface PreparedCandidate {
	event: ScrapedEvent;
	candidate: CandidateEvent;
}

export interface PrepareStats {
	total: number;
	noTitle: number;
	noDate: number;
	/** Already finished. Non-zero means the listing URL is probably an archive. */
	past: number;
	/** Upcoming, but beyond the window — normal for a venue listing its season. */
	later: number;
	kept: number;
}

/**
 * Deterministic pre-pass: drop what can't be used, week-filter, map fields.
 * The council link rewrite is applied here too, so a scraped event's link is
 * final before annotation (curate applies the same rewrite to every path).
 *
 * Dropping null-date candidates is not just tidiness — common.ts's
 * fingerprintEvent yields date:"" for them and isDuplicateEvent only bails
 * early when BOTH dates are present and differ, so a dateless event matches
 * any similarly-titled event on any date and would swallow real ones during
 * the merge.
 */
export interface Rejection {
	reason: "no title" | "no date" | "past" | "later";
	title: string | null;
	startRaw: string | null;
	startISO: string | null;
	url: string | null;
}

export function prepareCandidates(
	candidates: CandidateEvent[],
	source: SourceDefinition | undefined,
	from: string,
	to: string,
	timeZone: string,
): {
	prepared: PreparedCandidate[];
	stats: PrepareStats;
	rejected: Rejection[];
} {
	const stats: PrepareStats = {
		total: candidates.length,
		noTitle: 0,
		noDate: 0,
		past: 0,
		later: 0,
		kept: 0,
	};
	const prepared: PreparedCandidate[] = [];
	// Kept so a bad yield is diagnosable from a file instead of re-running the
	// extraction: the reason 391 candidates were lost to "no date" took offline
	// forensics precisely because these were thrown away.
	const rejected: Rejection[] = [];
	const reject = (
		reason: Rejection["reason"],
		c: CandidateEvent,
		startISO: string | null,
	): void => {
		rejected.push({
			reason,
			title: c.title,
			startRaw: c.startRaw,
			startISO,
			url: c.url,
		});
	};

	for (const c of candidates) {
		if (!c.title?.trim()) {
			stats.noTitle++;
			reject("no title", c, null);
			continue;
		}
		const event = candidateToEvent(c, source, timeZone, councilEventUrl);
		const startNaive = event.datetime_iso || null;
		if (!startNaive) {
			stats.noDate++;
			reject("no date", c, null);
			continue;
		}
		const endNaive = event.datetime_end_iso || null;
		if (isPast(startNaive, endNaive, from)) {
			stats.past++;
			reject("past", c, startNaive);
			continue;
		}
		if (!withinWindow(startNaive, endNaive, from, to)) {
			stats.later++;
			reject("later", c, startNaive);
			continue;
		}
		prepared.push({ event, candidate: c });
	}
	stats.kept = prepared.length;
	return { prepared, stats, rejected };
}
