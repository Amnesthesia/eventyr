// scrape(): one listing URL in, fetch + parse metadata and normalised events
// out (PLAN §2.5). A thin composition of what the fetcher and the ladder
// already do; nothing new is measured beyond durationMs and bytes.

import { readFileSync } from "node:fs";
import { createFetcher } from "./fetch.ts";
import { BlockedError, extractListing, type LadderOutcome } from "./ladder.ts";
import { candidateToEvent, type ScrapedEvent } from "./normalise.ts";
import type { FeedFormat } from "./parsers/feeds.ts";
import type {
	CandidateEvent,
	Fetcher,
	PageExtractFn,
	ScrapeSource,
	SourceStrategy,
} from "./types.ts";

export interface ScrapeOptions {
	/** IANA, DST-aware. Page text states wall-clock times in this zone. */
	timeZone: string;
	strategy?: SourceStrategy;
	/** Default: one shared got-scraping fetcher, so rate limits are
	 * process-wide whoever calls. */
	fetcher?: Fetcher;
	/** The LLM rung, injected by the pipeline. Without one, a page with no
	 * structured data yields nothing. */
	fallback?: PageExtractFn;
	/** Rewrites an event's link before the http(s) check (the pipeline's
	 * councilEventUrl). */
	linkRewriter?: (url: string | null) => string | null;
	/** Stamped onto provenance, `source`, the venue fallback and the link
	 * fallback. Defaults to the URL's host. */
	source?: ScrapeSource;
	/** Reference clock for relative dates; injectable for replay. */
	now?: () => Date;
}

export interface ScrapeResult {
	url: string;
	source: string | null;
	fetch: {
		/** `not-modified` (a 304, parsed from the cached body) and `ok` both
		 * carry events; `blocked` and `failed` never do, and are different
		 * problems: a refusal, or a fetch that never completed. */
		status: "ok" | "not-modified" | "blocked" | "failed";
		httpStatus: number | null;
		bytes: number;
		durationMs: number;
		/** Fetched through a browser (strategy "render"). */
		rendered: boolean;
		error: string | null;
	};
	parse: {
		via: LadderOutcome["via"];
		format: FeedFormat | null;
		/** Candidates the ladder produced, before anything was dropped. */
		found: number;
		kept: number;
		/** Dropped before mapping. Only what needs no publishing window: the
		 * pipeline decides "past" and "later". */
		rejected: { reason: "no title" | "no date"; title: string | null }[];
	};
	/** Every candidate the ladder produced, for callers that re-map after
	 * enriching (the pipeline's detail-page pass). */
	candidates: CandidateEvent[];
	/** Normalised but NOT annotated: category/tags/vibes are placeholders
	 * until the pipeline fills them. */
	events: ScrapedEvent[];
}

let sharedFetcher: Fetcher | undefined;
/** One fetcher per process by default, so rate limits are process-wide. */
function defaultFetcher(): Fetcher {
	sharedFetcher ??= createFetcher();
	return sharedFetcher;
}

export async function scrape(
	url: string,
	opts: ScrapeOptions,
): Promise<ScrapeResult> {
	const started = Date.now();
	const strategy = opts.strategy ?? "html";
	const source: ScrapeSource = opts.source ?? {
		id: new URL(url).host,
		name: new URL(url).host,
	};
	const fetcher = opts.fetcher ?? defaultFetcher();
	const now = opts.now ?? (() => new Date());
	const fail = (
		status: "blocked" | "failed",
		error: string,
		httpStatus: number | null,
		bytes = 0,
	): ScrapeResult => ({
		url,
		source: source.id,
		fetch: {
			status,
			httpStatus,
			bytes,
			durationMs: Date.now() - started,
			rendered: strategy === "render",
			error,
		},
		parse: { via: null, format: null, found: 0, kept: 0, rejected: [] },
		candidates: [],
		events: [],
	});

	let raw: Awaited<ReturnType<Fetcher["fetch"]>>;
	try {
		raw = await fetcher.fetch(source.id, url, strategy);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return fail("failed", message, null);
	}
	// A hard failure with no body to read; the fetcher normally throws first.
	if (!raw.bodyPath) return fail("failed", "no response body", raw.status);
	const body = readFileSync(raw.bodyPath, "utf-8");
	const bytes = Buffer.byteLength(body);

	let outcome: LadderOutcome;
	try {
		outcome = await extractListing(
			body,
			raw,
			source,
			opts.timeZone,
			opts.fallback,
			now(),
		);
	} catch (err) {
		// The ladder throws BlockedError for a refusal; anything else is the
		// injected fallback failing, which is a failure to look, not a refusal.
		const message = err instanceof Error ? err.message : String(err);
		const status = err instanceof BlockedError ? "blocked" : "failed";
		return fail(status, message, raw.status, bytes);
	}

	const rejected: ScrapeResult["parse"]["rejected"] = [];
	const events: ScrapedEvent[] = [];
	for (const c of outcome.candidates) {
		if (!c.title?.trim()) {
			rejected.push({ reason: "no title", title: c.title });
			continue;
		}
		const event = candidateToEvent(c, source, opts.timeZone, opts.linkRewriter);
		if (!event.datetime_iso) {
			rejected.push({ reason: "no date", title: c.title });
			continue;
		}
		events.push(event);
	}

	return {
		url,
		source: source.id,
		fetch: {
			status: raw.notModified ? "not-modified" : "ok",
			httpStatus: raw.status,
			bytes,
			durationMs: Date.now() - started,
			rendered: strategy === "render",
			error: null,
		},
		parse: {
			via: outcome.via,
			format: outcome.format,
			found: outcome.candidates.length,
			kept: events.length,
			rejected,
		},
		candidates: outcome.candidates,
		events,
	};
}
