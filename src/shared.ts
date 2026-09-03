// Constants shared between the Node pipeline and the browser bundle.
//
// This file must stay free of node: imports. src/common.ts — which the
// pipeline uses — reads the filesystem, so importing it from app/ code drags
// node:fs/path/url into the Vite bundle and the build fails. That is why the
// site used to keep its own duplicate copies of these values, which then
// drifted (the site treated a top pick as score >= 8 while the markdown and
// digest used 7).

export const CATEGORIES = [
	"Public Lecture",
	"Workshop / Class",
	"Concert / Music",
	"Social / Meetup",
	"Arts / Exhibition",
	"Community / Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_EMOJI: Record<string, string> = {
	"Public Lecture": "🎓",
	"Workshop / Class": "🛠️",
	"Concert / Music": "🎵",
	"Social / Meetup": "🤝",
	"Arts / Exhibition": "🎨",
	"Community / Other": "📌",
};

export const TOP_PICK_THRESHOLD = 7;
/** Below this a score is "low": the optional site filter hides these. */
export const LOW_SCORE_THRESHOLD = 4;

export const SITE_URL = "https://www.dothings.lol";

/** City key → the slug used in public URLs. Shared so the site, the sitemap
 * and the RSS feeds can't disagree about a city's address. */
export const KEY_TO_SLUG: Record<string, string> = {
	brisbane: "brisbane",
	goldcoast: "gold-coast",
	sunnycoast: "sunshine-coast",
};

/**
 * The minimum an event has to look like to be identified. Declared
 * structurally rather than as Record<string, unknown> so both the pipeline's
 * loose payloads and app/types.ts's Event interface satisfy it — an interface
 * with declared fields is not assignable to an index-signature type.
 */
export interface IdentifiableEvent {
	title?: unknown;
	datetime_iso?: unknown;
	location?: unknown;
}

function str(event: IdentifiableEvent, key: keyof IdentifiableEvent): string {
	const value = event[key];
	return typeof value === "string" ? value : "";
}

/**
 * Stable identity for one event, shared by every consumer that needs to name
 * it: the iCal UID, the RSS guid and the share URL.
 *
 * Location is part of the basis, not decoration. Generic titles repeat across
 * venues on the same night — "Live Music" appeared five times on one date at
 * five different pubs — and without the venue those collapse to one id, so a
 * calendar client showed one event and silently dropped four.
 *
 * DO NOT change the basis or the algorithm. ical.ts and rss.ts both derived
 * their ids from exactly this, so any change rewrites every UID and guid at
 * once: calendar clients re-add all 643 events and feed readers re-notify on
 * all of them. src/shared.test.ts pins the output against a fixture.
 *
 * ponytail: 32-bit rolling hash; a collision merges two events. Switch to a
 * sha1 prefix if two ever collide — but that is the rewrite described above,
 * so it needs to be worth it.
 */
export function eventHash(cityKey: string, event: IdentifiableEvent): string {
	const basis = [
		cityKey,
		str(event, "title"),
		str(event, "datetime_iso"),
		str(event, "location"),
	].join("|");
	let hash = 0;
	for (let i = 0; i < basis.length; i++) {
		hash = (hash * 31 + basis.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/**
 * Lowercased, diacritics stripped, everything else collapsed to single
 * hyphens. Used for URL segments; app/utils/search.ts shares the same
 * normalisation for its query matching.
 */
export function normaliseText(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export function slugify(text: string): string {
	// Capped so one absurd title cannot produce an absurd path. The hash that
	// follows it is what actually makes the slug unique, so truncating the
	// readable part costs nothing.
	return normaliseText(text).slice(0, 60).trim().replace(/ /g, "-");
}

/** URL segment identifying one event: readable title plus the stable hash. */
export function eventSlug(cityKey: string, event: IdentifiableEvent): string {
	const title = slugify(str(event, "title"));
	const hash = eventHash(cityKey, event);
	return title ? `${title}-${hash}` : hash;
}

/** The two fields the site's ordering depends on. */
export interface SortableEvent {
	score?: unknown;
	datetime_iso?: unknown;
}

/**
 * The canonical order: best fit first, and within one score the soonest event
 * first.
 *
 * The date half was missing. Four separate places sorted on score alone, and
 * because Array#sort is stable that left same-score events in whatever order
 * dedupe happened to produce — so a run of 8s could open with something ten
 * days out while tonight's sat below it. Undated events sink to the bottom of
 * their score rather than sorting as if they were the epoch.
 *
 * Lives here so rank.ts (which writes the order into data/{city}.json) and the
 * three Astro pages that re-sort cannot disagree about it.
 */
export function byScoreThenSoonest(a: SortableEvent, b: SortableEvent): number {
	const score =
		(typeof b.score === "number" ? b.score : 0) -
		(typeof a.score === "number" ? a.score : 0);
	if (score !== 0) return score;
	const left =
		typeof a.datetime_iso === "string" && a.datetime_iso
			? a.datetime_iso
			: "9999";
	const right =
		typeof b.datetime_iso === "string" && b.datetime_iso
			? b.datetime_iso
			: "9999";
	return left.localeCompare(right);
}

/**
 * Cost values that carry no information: they neither name a price nor say the
 * event is free, so a pill showing one is a pill worth removing.
 *
 * "See link" alone is 294 of 643 events — normalise.ts uses it as the fallback
 * when a page gave no price at all — and the rest add another ~60.
 */
const UNINFORMATIVE_COST =
	/^(?:see (?:link|website|site)|check (?:website|site|ticket price|prices?)|tba|tbc|unknown|not specified|paid|price on application|poa|varies|various|buy tickets?|tickets?|ticketed|book(?: now)?|register|n\/?a|—|-|\?+)$/i;

/** Free, however the source spelled it — including a zero price with a
 * currency code or symbol in front, which 11 events had as "USD 0". */
const FREE_COST =
	/\bfree\b|^(?:[a-z]{3}\s*)?[$\u20ac\u00a3\u00a5]?\s*0(?:[.,]00?)?$/i;

/**
 * The locale and currency an event's price is written in.
 *
 * Config rather than a constant: this pipeline happens to be Australian, but
 * nothing in the code should assume it. Set per city in `sources/{city}.yml`;
 * curate copies them into `data/{city}.json` so the browser has them too.
 */
export interface CostLocale {
	locale: string;
	currency: string;
}

export const DEFAULT_COST_LOCALE: CostLocale = {
	locale: "en-AU",
	currency: "AUD",
};

/**
 * Whether a string is a real ISO 4217 code — asked of Intl rather than of a
 * hand-written list, because there are 162 of them and any list I wrote would
 * miss SGD, JPY and the rest.
 */
export function isCurrencyCode(code: string): boolean {
	if (!/^[A-Za-z]{3}$/.test(code)) return false;
	// Narrowed locally rather than by widening the app's tsconfig `lib` to
	// ES2022: this is the only ES2022 Intl API in the bundle, and the runtime
	// check is needed anyway for older browsers.
	const intl = Intl as typeof Intl & {
		supportedValuesOf?: (key: string) => string[];
	};
	if (typeof intl.supportedValuesOf !== "function") return true;
	try {
		return intl.supportedValuesOf("currency").includes(code.toUpperCase());
	} catch {
		// An engine that has the method but rejects the key: assume valid rather
		// than silently rewriting a currency we cannot verify.
		return true;
	}
}

/**
 * Rewrites a foreign ISO currency code to the city's own.
 *
 * Every source in a city's list is a venue in that city, so a different
 * currency is the venue's markup being wrong rather than a real price — The
 * Cave Inn declares `priceCurrency: "USD"` on all of its events, which reached
 * the site as "USD 0". Only a *valid* ISO code is rewritten; anything else is
 * left as written, since three letters before a number might just be words.
 */
export function normaliseCurrency(
	value: unknown,
	currency: string = DEFAULT_COST_LOCALE.currency,
): string {
	if (typeof value !== "string" || !value) return "";
	return value.replace(
		/\b([A-Za-z]{3})\b(?=\s*[\d.$])/g,
		(match, code: string) =>
			isCurrencyCode(code) && code.toUpperCase() !== currency.toUpperCase()
				? currency
				: match,
	);
}

/**
 * A price that can be rendered numerically: an optional ISO code or symbol,
 * then one amount, and nothing else. A range or "$10 online | $15 door" is
 * left alone, because reformatting it would lose the labels that make it
 * useful.
 */
const SINGLE_AMOUNT =
	/^(?:([A-Za-z]{3})\s*)?[$\u20ac\u00a3\u00a5]?\s*(\d+(?:[.,]\d{1,2})?)$/;

/**
 * What to show in an event's cost pill, or null to show nothing.
 *
 * Presentation only: the raw value stays in the JSON and in the feeds, where
 * "See link" at least tells a reader to open the link. On a card it is a pill
 * saying nothing.
 *
 * A single numeric amount goes through Intl.NumberFormat, so "AUD 25" renders
 * as "$25" in en-AU — the symbol, the separators and where they sit are the
 * locale's business rather than something to concatenate by hand.
 */
export function costLabel(
	raw: unknown,
	{ locale, currency }: CostLocale = DEFAULT_COST_LOCALE,
): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (!value) return null;
	if (FREE_COST.test(value)) return "free";
	if (UNINFORMATIVE_COST.test(value)) return null;

	const amount = SINGLE_AMOUNT.exec(value);
	if (amount) {
		const parsed = Number(amount[2].replace(",", "."));
		if (Number.isFinite(parsed)) {
			const declared = amount[1];
			const code =
				declared && isCurrencyCode(declared)
					? declared.toUpperCase()
					: currency;
			try {
				return new Intl.NumberFormat(locale, {
					style: "currency",
					currency: code,
					// A whole amount reads better without ".00" on a dense card, but
					// a real 12.50 has to keep its cents.
					minimumFractionDigits: Number.isInteger(parsed) ? 0 : 2,
					maximumFractionDigits: 2,
				}).format(parsed);
			} catch {
				// Unsupported locale or currency: fall through to the raw text
				// rather than losing the price.
			}
		}
	}
	return value;
}

/**
 * Turns one of the pipeline's naive wall-clock strings into a full ISO 8601
 * instant with the city's UTC offset, for schema.org.
 *
 * `startDate: "2026-09-05T19:30:00"` is ambiguous — a crawler is entitled to
 * read it as UTC, which puts a 7:30pm gig at 5:30am the next day and makes the
 * event rich result wrong. The offset comes from Intl for the actual date, so
 * a DST city gets the right one rather than a constant.
 */
export function isoWithOffset(
	naive: unknown,
	timeZone = "Australia/Brisbane",
): string | undefined {
	if (typeof naive !== "string" || !naive) return undefined;
	const value = naive.length === 10 ? `${naive}T00:00:00` : naive;
	// Parsed as if UTC purely to have an instant to ask Intl about; only the
	// calendar date matters for picking the offset.
	const probe = new Date(`${value}Z`);
	if (Number.isNaN(probe.getTime())) return undefined;
	try {
		const name = new Intl.DateTimeFormat("en", {
			timeZone,
			timeZoneName: "longOffset",
		})
			.formatToParts(probe)
			.find((part) => part.type === "timeZoneName")?.value;
		// "GMT+10:00" → "+10:00". Plain "GMT" means UTC.
		const offset = name?.replace("GMT", "") || "Z";
		return `${value}${offset === "Z" ? "Z" : offset}`;
	} catch {
		// Unknown timezone: better an offsetless string than none at all.
		return value;
	}
}

/**
 * `[label](anything)` → `label`.
 *
 * The target is matched loosely on purpose: the thing in the parentheses is
 * often not a valid URL at all — a truncated href, a relative path, or an
 * empty `()` — and a pattern that insisted on `https://…` left the broken
 * ones on the card verbatim.
 */
const MARKDOWN_LINK = /\[([^\]]{1,120})\]\([^)]{0,300}\)/g;

/**
 * A URL on its own, with the brackets or trailing punctuation that usually
 * surround it. `readableText.ts` deliberately keeps every `<a href>` as
 * "label (resolved URL)" so the extraction prompt can copy ticket links
 * verbatim, which is how descriptions end up carrying
 * "Book your place (https://events.humanitix.com/…) ."
 */
/* {0,300} rather than {1,300}: a description carrying only "(https://)" or
 * "(https://..)" is a broken link the extractor produced, and a pattern that
 * required a host after the slashes left exactly those on the card. */
const PARENTHESISED_URL =
	/[([]\s*(?:https?:\/*|\/\/|www\.)[^)\]\s]{0,300}\s*[)\]]/gi;
const BARE_URL = /(?:https?:\/*|\/\/)[^\s)\]]{0,300}/g;
/** A scheme-less URL, which is how a lot of listings write one. Requires the
 * www. prefix on purpose: matching any bare `word.tld` would eat prose like
 * "see dothings.lol" and, worse, sentence-ending abbreviations. */
const WWW_URL = /\bwww\.[^\s)\]]{2,300}/gi;

/** Runs of markdown emphasis. Two or more only: a single asterisk appears in
 * real titles ("3 * 3"), where "****Tickets" never does. */
const MARKDOWN_EMPHASIS = /(\*{2,}|_{2,}|`{1,3})/g;
/** Heading and blockquote markers, only where markdown puts them. */
const MARKDOWN_BLOCK = /(^|\n)\s*(?:#{1,6}|>)\s+/g;

/**
 * Strips what a card or an event page should not show: URLs and markdown
 * artefacts.
 *
 * Presentation only, and deliberately not done in the pipeline. The URL stays
 * in the JSON because a description is often the only place a ticket link
 * appears — `event.link` is frequently just the venue homepage — so the feeds
 * and the stored data keep it, and only the rendered text drops it.
 *
 * Lives here rather than in text.ts so the browser bundle does not have to
 * pull in `he` for a job that needs no entity decoding: curate already did
 * that.
 */
export function stripForDisplay(value: unknown): string {
	if (typeof value !== "string" || !value) return "";
	return (
		value
			.replace(MARKDOWN_LINK, "$1")
			// Parenthesised first, or BARE_URL eats the URL and leaves "( )".
			.replace(PARENTHESISED_URL, " ")
			.replace(BARE_URL, " ")
			.replace(WWW_URL, " ")
			.replace(MARKDOWN_BLOCK, "$1")
			.replace(MARKDOWN_EMPHASIS, "")
			.replace(/\s+/g, " ")
			// Punctuation the removals strand: " .", an empty "()", a doubled stop.
			.replace(/\(\s*\)|\[\s*\]/g, "")
			.replace(/\s+([.,;:!?])/g, "$1")
			.replace(/([.,;:!?])\1+/g, "$1")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/**
 * Whether a scraped image URL is worth showing.
 *
 * Requires https and a real image extension on the path. Measured, not
 * cautious-by-instinct: of 139 Brisbane images, all 78 whose path ended in an
 * image extension returned 200 image/jpeg, and all 61 without one were dead
 * (404 or 400). The extension-less ones are an extraction fault — a slug or
 * caption resolved against the site root, e.g.
 * `brisbanefestival.com.au/qagoma_the-jim-henson-company-exhibition_1920x1080`
 * — and Brisbane Festival alone accounts for 47 of them.
 *
 * Used at both ends: curate.ts drops these from the data, and the render path
 * checks again so existing data is fixed without re-running the pipeline. A
 * URL with content negotiation and no extension would be a false negative;
 * that fails to "no image", which is the safe direction.
 */
export function isLikelyImageUrl(value: unknown): boolean {
	if (typeof value !== "string" || !/^https:\/\//i.test(value)) return false;
	// Query strings and fragments are stripped before looking at the extension:
	// `photo.jpg?w=800` is still a jpg.
	const path = value.split(/[?#]/)[0];
	return /\.(jpe?g|png|webp|gif|avif)$/i.test(path);
}

/**
 * Site-root-relative path to one event's own page.
 *
 * With the trailing slash, because that is the URL the server actually
 * answers 200 to. Astro's default build format writes `<path>/index.html`, and
 * GitHub Pages 301s `/path` to `/path/` — so the slash-less form made every
 * sitemap entry, canonical and og:url point at a redirect.
 */
export function eventPath(cityKey: string, event: IdentifiableEvent): string {
	const city = KEY_TO_SLUG[cityKey] ?? cityKey;
	return `/${city}/e/${eventSlug(cityKey, event)}/`;
}
