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
// A source with real structured data (JSON-LD on every page) never touches
// the LLM path at all — this only falls through to it per-listing, so one
// page adapter can serve a source that's inconsistent about publishing
// JSON-LD without misclassifying the whole source as "html".

import { readFileSync } from "node:fs";
import { provenanceFor, toCandidateEvent } from "./candidate.ts";
import {
	extractJsonLdBlocks,
	findEventNodes,
	jsonLdNodeToRawFields,
} from "./extract.ts";
import { stripToReadableText } from "./readableText.ts";
import type {
	CandidateEvent,
	EventSourceAdapter,
	Fetcher,
	PageExtractFn,
	RawListing,
	SourceDefinition,
} from "./types.ts";

export interface PageAdapterDeps {
	fetcher: Fetcher;
	extractPage: PageExtractFn;
	/** Injectable for tests; defaults to the real clock. */
	now?: () => Date;
}

export function createPageAdapter(
	source: SourceDefinition,
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
			if (raw.notModified || !raw.bodyPath) return [];
			const body = readFileSync(raw.bodyPath, "utf-8");
			const referenceDate = now();

			const jsonLdNodes = findEventNodes(extractJsonLdBlocks(body));
			if (jsonLdNodes.length > 0) {
				return jsonLdNodes.map((node) =>
					toCandidateEvent(
						jsonLdNodeToRawFields(node),
						provenanceFor(source, raw, "jsonld"),
						referenceDate,
					),
				);
			}

			const pageText = stripToReadableText(body, raw.url);
			if (!pageText) return [];
			const fields = await deps.extractPage(pageText, source.name);
			return fields.map((f) =>
				toCandidateEvent(f, provenanceFor(source, raw, "html"), referenceDate),
			);
		},
	};
}
