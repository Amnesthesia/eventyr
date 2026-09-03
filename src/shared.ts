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

/** Site-root-relative path to one event's own page. */
export function eventPath(cityKey: string, event: IdentifiableEvent): string {
	const city = KEY_TO_SLUG[cityKey] ?? cityKey;
	return `/${city}/e/${eventSlug(cityKey, event)}`;
}
