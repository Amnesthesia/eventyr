// Reduces a fetched HTML page to plain, LLM-friendly text before it's ever
// sent to the extraction model: strips script/style/nav/header/footer
// boilerplate, and — importantly — keeps every <a href> as inline "label
// (resolved URL)" text rather than throwing links away, since the
// extraction prompt is asked to copy ticket/event URLs verbatim and can
// only do that if they're still visible in the text it's given.

import he from "he";

// Entity decoding is `he` (see src/text.ts): the seven-entity table that
// used to live here let every numeric reference through, so "&#8217;" reached
// the extraction prompt — and the event titles — verbatim.
const decodeEntities = (text: string): string => he.decode(text);

const BOILERPLATE_TAGS =
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
