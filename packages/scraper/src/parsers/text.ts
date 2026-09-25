// Reduces a fetched HTML page to plain, LLM-friendly text before it's ever
// sent to the extraction model: strips script/style/nav/header/footer
// boilerplate, and — importantly — keeps every <a href> as inline "label
// (resolved URL)" text rather than throwing links away, since the
// extraction prompt is asked to copy ticket/event URLs verbatim and can
// only do that if they're still visible in the text it's given.

import he from "he";
import { countDateHits } from "./dates.ts";

// Entity decoding is `he` (see src/text.ts): the seven-entity table that
// used to live here let every numeric reference through, so "&#8217;" reached
// the extraction prompt — and the event titles — verbatim.
const decodeEntities = (text: string): string => he.decode(text);

export const BOILERPLATE_TAGS =
	/<(script|style|noscript|svg|header|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi;
const LINK_TAG = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
export function stripToReadableText(html: string, baseUrl: string): string {
	let text = html.replace(BOILERPLATE_TAGS, " ");

	text = text.replace(LINK_TAG, (_match, href: string, inner: string) => {
		let resolved = href;
		try {
			resolved = new URL(href, baseUrl).toString();
		} catch {
			// leave href as-is if it's not a resolvable URL (e.g. "javascript:void(0)")
		}
		const label = decodeEntities(inner.replace(/<[^>]+>/g, " "))
			.replace(/\s+/g, " ")
			.trim();
		return label ? ` ${label} (${resolved}) ` : ` ${resolved} `;
	});

	text = text.replace(/<[^>]+>/g, " ");
	text = decodeEntities(text);
	text = text
		// he decodes &nbsp; to U+00A0, which [ \t] does not match — so without
		// this a page using &nbsp; for layout reaches the prompt with runs of
		// non-breaking spaces that look like one word.
		.replace(/\u00A0/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
	return text;
}

/**
 * The `size`-character window of `text` containing the most date-shaped
 * fragments, snapped to a paragraph boundary.
 *
 * Taking the *first* window instead is what made several listing pages look
 * empty: classbento.com.au carries 3832 date-shaped fragments and none of them
 * in its first 12 KB, so a probe reading from position 0 concluded the page
 * listed no events. theurbanlist's what's-on had 15 of 100. Both are long
 * pages that open with navigation, hero copy and editorial before the listing
 * starts.
 *
 * Deterministic and free — countDateHits is a regex count — so this is spent
 * before any model call rather than in place of one.
 */
export function densestWindow(text: string, size: number): string {
	if (text.length <= size) return text;
	// Coarse steps: a listing block is thousands of characters long, so a
	// finer scan costs more counting for the same answer.
	const step = Math.max(1000, Math.floor(size / 4));
	let bestStart = 0;
	let bestHits = -1;
	for (let start = 0; start + 1 < text.length; start += step) {
		const hits = countDateHits(text.slice(start, start + size));
		if (hits > bestHits) {
			bestHits = hits;
			bestStart = start;
		}
	}
	const unsnapped = text.slice(bestStart, bestStart + size);
	// Snap forward to a paragraph break so the slice does not begin
	// mid-sentence, which reads as truncated context to the extractor. But
	// never at the cost of content: advancing the start pushes the same amount
	// off the end, which cost theurbanlist's what's-on a date hit (15 → 14).
	// Cosmetics do not get to lose data.
	const snap = text.indexOf("\n\n", bestStart);
	if (snap === -1 || snap - bestStart >= step) return unsnapped;
	const snapped = text.slice(snap + 2, snap + 2 + size);
	return countDateHits(snapped) < bestHits ? unsnapped : snapped;
}
