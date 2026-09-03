// Free-text event search, with enough fuzziness to survive a typo.
//
// No dependency: Fuse.js and friends bring an index, a scoring model and a
// configuration surface, and none of that is needed to filter a few hundred
// already-in-memory objects on every keystroke. What is needed is exactly two
// rules — tokens match in any order, and a token may be one edit out.

import type { Event } from "../types";

/**
 * Lowercased, diacritics stripped, punctuation flattened to spaces.
 *
 * The strip matters for real listings: "Café Cabaret" has to be findable by
 * typing "cafe", and "Henson's" by typing "hensons".
 */
export function normalise(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Everything a reader might search on, in one normalised string. */
export function haystackFor(event: Event): string {
	return normalise(
		[
			event.title,
			event.location,
			event.category,
			event.source,
			event.tags?.join(" ") ?? "",
			event.description,
		].join(" "),
	);
}

/**
 * Whether two words differ by at most one insertion, deletion, substitution or
 * transposition — Damerau-Levenshtein distance <= 1.
 *
 * Transposition is included because it is the typo people actually make:
 * "marekt" for "market" is two substitutions under plain Levenshtein and would
 * otherwise miss. Bounded at one edit, though — at two, four-letter queries
 * start matching unrelated words and the results stop looking like a search.
 */
export function withinOneEdit(a: string, b: string): boolean {
	if (a === b) return true;
	if (Math.abs(a.length - b.length) > 1) return false;
	// Walk both, allowing a single divergence.
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	const sameLength = short.length === long.length;
	let i = 0;
	let j = 0;
	let slack = 1;
	while (i < short.length && j < long.length) {
		if (short[i] === long[j]) {
			i++;
			j++;
			continue;
		}
		if (slack === 0) return false;
		slack--;
		if (sameLength && short[i] === long[j + 1] && short[i + 1] === long[j]) {
			// Two adjacent characters swapped: consume both sides.
			i += 2;
			j += 2;
			continue;
		}
		// Same length means a substitution; different means a deletion from the
		// longer side.
		if (sameLength) i++;
		j++;
	}
	return true;
}

/**
 * A token matches if it appears anywhere in the haystack, or — once it is long
 * enough for an edit to be meaningful — if some word in the haystack is one
 * edit away from it. Short tokens get the substring rule only: at three
 * characters, "one edit away" is most of the alphabet.
 */
function tokenMatches(
	token: string,
	haystack: string,
	words: string[],
): boolean {
	if (haystack.includes(token)) return true;
	if (token.length < 4) return false;
	return words.some(
		(word) =>
			Math.abs(word.length - token.length) <= 1 && withinOneEdit(token, word),
	);
}

/** Splits a raw query into the tokens every event must satisfy. */
export function queryTokens(query: string): string[] {
	const normalised = normalise(query);
	return normalised ? normalised.split(" ") : [];
}

/**
 * Every token must match, in any order — so "market west" finds "West End
 * Twilight Market". AND rather than OR because each extra word a reader types
 * is meant to narrow the list, not widen it.
 */
export function matchesQuery(event: Event, tokens: string[]): boolean {
	if (tokens.length === 0) return true;
	const haystack = haystackFor(event);
	const words = haystack.split(" ");
	return tokens.every((token) => tokenMatches(token, haystack, words));
}
