// The extraction ladder: given one fetched body it extracts events — a
// site's own feed first, then JSON-LD (fully deterministic, most
// trustworthy), then embedded hydration JSON, then the injected fallback
// over the reduced page text when a page publishes none of those. That
// fallback is what "html"-strategy sources actually run: rather than
// hand-writing CSS selectors per site, the pipeline's LLM rung does the same
// "copy fields off the page" job selectors would, described in a prompt
// instead of code — see the pipeline's llmExtract.ts for the "never invent,
// null if absent" contract that keeps this consistent with "adapters never
// guess".
//
// Order is strictly cheapest-first: a site's own event feed/API (feeds.ts),
// then JSON-LD, then embedded hydration JSON (embeddedJson.ts), then the
// fallback over reduced page text.
//
// A source with real structured data (JSON-LD on every page) never touches
// the fallback at all — the ladder only falls through to it per-listing, so
// one source that's inconsistent about publishing JSON-LD is not
// misclassified as "html" as a whole.

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
	ExtractionStrategy,
	PageExtractFn,
	RawCandidateFields,
	RawListing,
	ScrapeSource,
} from "./types.ts";

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
