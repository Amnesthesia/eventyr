// Generic, source-agnostic adapter: given a SourceDefinition (really, just
// its listingUrls) it fetches deterministically via the shared fetch layer,
// then extracts events from whatever it gets back — JSON-LD first (fully
// deterministic, most trustworthy), falling back to LLM extraction over the
// reduced page text when a page publishes none. This is what "html"-
// strategy sources actually run: rather than hand-writing CSS selectors
// per site, the LLM here does the same "copy fields off the page" job
// selectors would, just described in a prompt instead of code — see
// llmExtract.ts for the "never invent, null if absent" contract that keeps
// this consistent with "adapters never guess".
//
// Order is strictly cheapest-first: a site's own event feed/API (feeds.ts),
// then JSON-LD, then embedded hydration JSON (embeddedJson.ts), then the LLM
// over reduced page text.
//
// A source with real structured data (JSON-LD on every page) never touches
// the LLM path at all — this only falls through to it per-listing, so one
// page adapter can serve a source that's inconsistent about publishing
// JSON-LD without misclassifying the whole source as "html".

import { readFileSync } from "node:fs";
import { provenanceFor, toCandidateEvent } from "./candidate.ts";
import { blockedReason } from "./fetch.ts";
import { extractFromEmbeddedJson } from "./parsers/embeddedJson.ts";
import { type FeedFormat, parseFeed } from "./parsers/feeds.ts";
import {
	extractJsonLdBlocks,
	findEventNodes,
	jsonLdNodeToRawFields,
} from "./parsers/jsonLd.ts";
import { stripToReadableText } from "./parsers/text.ts";
import type {
	CandidateEvent,
	EventSourceAdapter,
	ExtractionStrategy,
	Fetcher,
	PageExtractFn,
	RawCandidateFields,
	RawListing,
	ScrapeSource,
	SourceStrategy,
} from "./types.ts";

export interface PageAdapterDeps {
	fetcher: Fetcher;
	extractPage: PageExtractFn;
	/** Injectable for tests; defaults to the real clock. */
	now?: () => Date;
}

/** The response was a refusal (a 4xx/5xx, a challenge page, a reload
 * shell), not a listing. Carries blockedReason's text. */
export class BlockedError extends Error {}

/** Which rung produced the candidates, and for a feed, which format. */
export interface LadderOutcome {
	via: "feed" | "jsonld" | "embedded" | "fallback" | null;
	format: FeedFormat | null;
	candidates: CandidateEvent[];
}

/**
 * The ladder over one fetched body, cheapest rung first. Throws for a
 * blocked response: "nothing there" and "we were refused" need different
 * remedies, and returning [] put a 403 challenge page and a genuinely quiet
 * venue into barren.json as identical bare names.
 */
export async function extractListing(
	body: string,
	raw: RawListing,
	source: Pick<ScrapeSource, "id" | "name">,
	timeZone: string,
	extractPage: PageExtractFn | undefined,
	referenceDate: Date,
): Promise<LadderOutcome> {
	const blocked = blockedReason(
		raw.status,
		body,
		stripToReadableText(body, raw.url).length,
	);
	if (blocked) throw new BlockedError(blocked);

	const candidate = (
		fields: RawCandidateFields,
		strategy: ExtractionStrategy,
	) =>
		toCandidateEvent(
			fields,
			provenanceFor(source, raw, strategy),
			referenceDate,
			timeZone,
		);

	// A site's own event API, when a listing URL points at one. Recognised
	// by response shape rather than by URL or content-type, so a feed
	// served as text/html still parses and a URL that merely looks like
	// an API cannot fake its way in.
	//
	// Note the empty case is deliberately NOT a fall-through: a feed that
	// answered with nothing is a verified negative, and continuing down
	// the ladder would spend an LLM call re-reading a JSON body as prose.
	const feed = parseFeed(body, raw.url);
	if (feed) {
		return {
			via: "feed",
			format: feed.format,
			candidates: feed.events.map((f) => candidate(f, "feed")),
		};
	}

	const jsonLdNodes = findEventNodes(extractJsonLdBlocks(body));
	if (jsonLdNodes.length > 0) {
		return {
			via: "jsonld",
			format: null,
			candidates: jsonLdNodes.map((node) =>
				candidate(jsonLdNodeToRawFields(node), "jsonld"),
			),
		};
	}

	// Client-rendered pages hide their listings in embedded hydration
	// state; recovering that is still deterministic, so it goes ahead of
	// the LLM fallback.
	const embedded = extractFromEmbeddedJson(body, raw.url);
	if (embedded.length > 0) {
		return {
			via: "embedded",
			format: null,
			candidates: embedded.map((f) => candidate(f, "api")),
		};
	}

	const pageText = stripToReadableText(body, raw.url);
	if (!pageText || !extractPage)
		return { via: null, format: null, candidates: [] };
	const fields = await extractPage(pageText, source.name);
	return {
		via: "fallback",
		format: null,
		candidates: fields.map((f) => candidate(f, "html")),
	};
}

/** A source plus what the old registry entry carried for the ladder itself. */
export interface LadderSource extends ScrapeSource {
	listingUrls: string[];
	strategy: SourceStrategy;
	/** The city's IANA zone: page text states wall-clock times. */
	timeZone: string;
}

export function createPageAdapter(
	source: LadderSource,
	deps: PageAdapterDeps,
): EventSourceAdapter {
	const now = deps.now ?? (() => new Date());

	return {
		id: source.id,

		async discover(): Promise<RawListing[]> {
			const listings: RawListing[] = [];
			for (const url of source.listingUrls) {
				listings.push(
					await deps.fetcher.fetch(source.id, url, source.strategy),
				);
			}
			return listings;
		},

		async extract(raw: RawListing): Promise<CandidateEvent[]> {
			// A 304 still carries the cached body path — parse it. Returning []
			// here overwrote the source's output with an empty payload whenever
			// a listing page legitimately hadn't changed.
			if (!raw.bodyPath) return [];
			const body = readFileSync(raw.bodyPath, "utf-8");
			const { candidates } = await extractListing(
				body,
				raw,
				source,
				source.timeZone,
				deps.extractPage,
				now(),
			);
			return candidates;
		},
	};
}
