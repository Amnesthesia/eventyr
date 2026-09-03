// Turns scraped text into what a reader should actually see.
//
// Two things kept reaching the site as literal markup:
//
//   "Dice Rolls &#038; Flagons &#8211; Casual Board Game Meetup"
//   "&lt;p&gt;Join us for Dice Rolls &amp; Flagons, a social board game…"
//
// The first is a numeric character reference — WordPress emits &#038; and
// &#8211; rather than &amp; and &ndash;, and readableText.ts's hand-written
// seven-entity table (its own ponytail: comment predicted this) passed them
// straight through. The second is HTML that a source escaped into its own
// JSON-LD description field, so one decode pass yields real tags that then
// have to be removed rather than displayed.
//
// Decoding is via `he` rather than a regex: numeric refs come in decimal and
// hex, with and without the trailing semicolon, and astral codepoints need
// surrogate pairs. That is a spec, not a pattern.

import he from "he";

/** Tags a source escaped into a text field. Only ever applied to text that
 * has already been decoded, so this never sees real page HTML — that is
 * readableText.ts's job. */
const TAG = /<[^>]*>/g;

/**
 * Decodes entities until the string stops changing, so double-encoded text
 * ("&amp;#038;" → "&#038;" → "&") comes out clean.
 *
 * Bounded at three passes: a fixpoint loop over attacker-controlled text is
 * how you get a hang, and nothing legitimate is encoded three times.
 */
function decodeFully(text: string): string {
	let out = text;
	for (let i = 0; i < 3; i++) {
		const next = he.decode(out);
		if (next === out) return out;
		out = next;
	}
	return out;
}

/**
 * Backslash escapes that leaked out of a JSON string embedded in a page —
 * "Netherworld\'s" and a literal two-character "\n" both reached the site.
 */
const JSON_ESCAPE = /\\(['"nrt\\])/g;
const JSON_ESCAPE_MAP: Record<string, string> = {
	"'": "'",
	'"': '"',
	n: " ",
	r: " ",
	t: " ",
	"\\": "\\",
};

/**
 * Corrects text that arrived wrong: entities the source double-encoded, tags
 * it escaped into a text field, JSON escapes that leaked out of an embedded
 * string, and the whitespace those leave behind.
 *
 * Deliberately does NOT strip URLs or markdown. A description is often the
 * only place a ticket URL appears — `event.link` is frequently just the venue
 * homepage — so removing it here would destroy the data. That is a
 * presentation concern: see stripForDisplay in src/shared.ts, which the cards
 * and the event page apply at render time.
 */
export function cleanText(value: unknown): string {
	if (typeof value !== "string" || !value)
		return typeof value === "string" ? value : "";
	return decodeFully(value)
		.replace(TAG, " ")
		.replace(JSON_ESCAPE, (_m, ch: string) => JSON_ESCAPE_MAP[ch] ?? ch)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * For URLs: decode only. "?a=1&amp;b=2" is a real URL once decoded, and
 * stripping angle brackets or collapsing whitespace would corrupt it.
 */
export function cleanUrl(value: unknown): string {
	if (typeof value !== "string" || !value) return "";
	const url = decodeFully(value).trim();
	// Same scheme guard the rest of the pipeline uses: this string ends up in
	// an href, and decoding must not be a way to smuggle javascript: past it.
	return /^https?:\/\//i.test(url) ? url : "";
}
