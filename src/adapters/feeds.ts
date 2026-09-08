// Deterministic event feeds: the rung that asks a site for its own
// machine-readable answer before anything guesses at its HTML.
//
// This exists because the ladder (JSON-LD → hydration JSON → LLM over text)
// had no rung for the API a site advertises about itself, and that turned out
// to be where the events actually were. The case that motivated it:
// beachhotel.com.au serves a 76-character JS-reload shell for every HTML URL
// — probe filed it "spa-empty", i.e. unscrapable — while
// /wp-json/tribe/events/v1/events answers plain curl with 384 upcoming events,
// exact timestamps and per-event URLs. The bot wall guards the HTML only.
//
// Two things of value here, and the second is the one the pipeline lacked:
//
//  1. Exact structured data, free, with no model call and no date guessing.
//  2. A *certain* negative. A feed that responds `{"total":0}` is proof there
//     is nothing on this week — not a failed look. Those two were previously
//     indistinguishable, so a source with genuinely nothing on burned an AI
//     search every week to rediscover that.
//
// Hence `null` (not a feed — fall through the ladder) is a different return
// from `{ events: [] }` (a feed that says there is nothing).
//
// Dates are never computed here. Every format's date is copied out verbatim
// as `startRaw` and resolved by dates.ts like any other extraction, so one
// parser owns every date in the pipeline. The only conversion is Squarespace's
// epoch-milliseconds, which is a machine-exact instant reformatted (not
// inferred) into an ISO string chrono reads back identically — verified.

import type { RawCandidateFields } from "./types.ts";

export type FeedFormat =
	| "events-calendar"
	| "modern-events-calendar"
	| "squarespace";

export interface FeedResult {
	format: FeedFormat;
	/** Empty means the feed answered and has nothing — a verified negative. */
	events: RawCandidateFields[];
}

/**
 * One hostile response must not turn into unbounded downstream work. Feeds
 * legitimately paginate in the hundreds (beachhotel: 384), so this is well
 * above any real page while still bounded.
 */
const MAX_EVENTS_PER_FEED = 500;

/** Feed content is third-party text. Anything heading for an href gets
 * scheme-checked here rather than downstream. */
function safeUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const u = new URL(value);
		return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
	} catch {
		return null;
	}
}

function str(value: unknown): string | null {
	if (typeof value === "string") {
		const t = value.trim();
		return t ? t : null;
	}
	if (typeof value === "number") return String(value);
	return null;
}

/** Strips tags from the HTML fragments feeds put in description fields. */
function plain(value: unknown): string | null {
	const s = str(value);
	return s
		? (str(s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")) ?? null)
		: null;
}

const empty: RawCandidateFields = {
	title: null,
	description: null,
	startRaw: null,
	endRaw: null,
	venueName: null,
	address: null,
	url: null,
	price: null,
	imageUrl: null,
	organiser: null,
	category: null,
	sourceEventId: null,
};

// --- The Events Calendar (WordPress) -------------------------------------
// GET /wp-json/tribe/events/v1/events → { events: [...], total, total_pages }
// Dates arrive as local wall-clock strings ("2026-09-08 16:00:00"), which is
// exactly what dates.ts expects to resolve.

interface TecEvent {
	id?: unknown;
	title?: unknown;
	description?: unknown;
	excerpt?: unknown;
	url?: unknown;
	start_date?: unknown;
	end_date?: unknown;
	cost?: unknown;
	image?: { url?: unknown } | unknown;
	venue?: { venue?: unknown; address?: unknown } | unknown;
	categories?: unknown;
}

function tecToFields(e: TecEvent): RawCandidateFields {
	const venue = (e.venue ?? {}) as { venue?: unknown; address?: unknown };
	const image = (e.image ?? {}) as { url?: unknown };
	const cats = Array.isArray(e.categories) ? e.categories : [];
	const firstCat = cats
		.map((c) =>
			c && typeof c === "object" ? str((c as { name?: unknown }).name) : null,
		)
		.find(Boolean);
	return {
		...empty,
		title: plain(e.title),
		description: plain(e.description) ?? plain(e.excerpt),
		startRaw: str(e.start_date),
		endRaw: str(e.end_date),
		venueName: str(venue.venue),
		address: plain(venue.address),
		url: safeUrl(e.url),
		price: str(e.cost),
		imageUrl: safeUrl(image.url),
		category: firstCat ?? null,
		sourceEventId: str(e.id),
	};
}

// --- Modern Events Calendar ----------------------------------------------
// GET /wp-json/mec/v1/events → an array. Field names vary by version, so this
// reads defensively: a title-ish key plus a date-ish key, or nothing.

function mecToFields(e: Record<string, unknown>): RawCandidateFields | null {
	const title =
		plain(e.title) ??
		plain((e.post as { post_title?: unknown } | undefined)?.post_title);
	const meta = (e.meta ?? e.date ?? {}) as Record<string, unknown>;
	const start =
		str(e.start_date) ??
		str(e.start) ??
		str((meta.start as { date?: unknown } | undefined)?.date) ??
		str(meta.start);
	if (!title || !start) return null;
	return {
		...empty,
		title,
		description: plain(e.content) ?? plain(e.excerpt),
		startRaw: start,
		endRaw:
			str(e.end_date) ??
			str((meta.end as { date?: unknown } | undefined)?.date),
		url: safeUrl(e.permalink) ?? safeUrl(e.url),
		sourceEventId: str(e.id) ?? str(e.ID),
	};
}

// --- Squarespace ----------------------------------------------------------
// GET <any collection path>?format=json
//
// The trap: event collections leave `items` EMPTY and split the events into
// top-level `upcoming` and `past` arrays. Reading `items` reports every
// Squarespace source as having nothing, which looks exactly like a working
// integration — verified against bangalowhall.com (items 0, past 30).

interface SqspItem {
	id?: unknown;
	title?: unknown;
	excerpt?: unknown;
	body?: unknown;
	fullUrl?: unknown;
	assetUrl?: unknown;
	startDate?: unknown;
	endDate?: unknown;
	location?: { addressTitle?: unknown; addressLine1?: unknown } | unknown;
}

/** Squarespace dates are epoch milliseconds — a machine-exact instant. It is
 * reformatted to ISO (never inferred) and handed to dates.ts, which reads the
 * UTC designator back to the same instant. */
function epochToRaw(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sqspToFields(
	item: SqspItem,
	origin: string,
): RawCandidateFields | null {
	const title = plain(item.title);
	const startRaw = epochToRaw(item.startDate);
	if (!title) return null;
	const loc = (item.location ?? {}) as {
		addressTitle?: unknown;
		addressLine1?: unknown;
	};
	const full = str(item.fullUrl);
	return {
		...empty,
		title,
		description: plain(item.excerpt) ?? plain(item.body),
		// Product-style collections carry the date in the title instead; leaving
		// startRaw null lets dates.ts read the title downstream rather than
		// inventing a date here.
		startRaw,
		endRaw: epochToRaw(item.endDate),
		venueName: str(loc.addressTitle),
		address: str(loc.addressLine1),
		url: full ? safeUrl(new URL(full, origin).href) : null,
		imageUrl: safeUrl(item.assetUrl),
		sourceEventId: str(item.id),
	};
}

// --- dispatch -------------------------------------------------------------

function asRecord(body: string): Record<string, unknown> | unknown[] | null {
	const t = body.trimStart();
	if (!t.startsWith("{") && !t.startsWith("[")) return null;
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

/**
 * Parses a feed response into raw candidate fields, or returns null when the
 * body is not a feed we recognise (the caller then continues down the ladder).
 *
 * Recognition is by response *shape*, not by URL or content-type: a feed
 * served as text/html still parses, and a URL that merely looks like an API
 * cannot fake its way in.
 */
export function parseFeed(body: string, url: string): FeedResult | null {
	const parsed = asRecord(body);
	if (!parsed) return null;
	const origin = (() => {
		try {
			return new URL(url).origin;
		} catch {
			return "https://invalid.invalid";
		}
	})();

	// The Events Calendar: an `events` array plus its own `rest_url`/`total`.
	if (!Array.isArray(parsed)) {
		const events = parsed.events;
		if (Array.isArray(events) && ("total" in parsed || "rest_url" in parsed)) {
			return {
				format: "events-calendar",
				events: events
					.slice(0, MAX_EVENTS_PER_FEED)
					.map((e) => tecToFields(e as TecEvent))
					.filter((f) => f.title && f.startRaw),
			};
		}

		// Squarespace: upcoming/past beside a collection descriptor.
		const hasCollection =
			typeof parsed.collection === "object" && parsed.collection !== null;
		const upcoming = Array.isArray(parsed.upcoming) ? parsed.upcoming : [];
		const past = Array.isArray(parsed.past) ? parsed.past : [];
		const items = Array.isArray(parsed.items) ? parsed.items : [];
		if (
			hasCollection &&
			(upcoming.length || past.length || items.length || "upcoming" in parsed)
		) {
			// Past events are read as well as upcoming: the window filter
			// downstream is what decides, and dropping them here would hide the
			// difference between "an archive" and "a feed that failed".
			const all = [...upcoming, ...items, ...past].slice(
				0,
				MAX_EVENTS_PER_FEED,
			);
			return {
				format: "squarespace",
				events: all
					.map((i) => sqspToFields(i as SqspItem, origin))
					.filter(
						(f): f is RawCandidateFields => f !== null && f.startRaw !== null,
					),
			};
		}
		return null;
	}

	// Modern Events Calendar: a bare array. An empty array is ambiguous on its
	// own, so it only counts as a feed when the URL says which API answered.
	if (/\/wp-json\/mec\//i.test(url) || /\/wp\/v2\/mec-events/i.test(url)) {
		return {
			format: "modern-events-calendar",
			events: parsed
				.slice(0, MAX_EVENTS_PER_FEED)
				.map((e) => mecToFields(e as Record<string, unknown>))
				.filter((f): f is RawCandidateFields => f !== null),
		};
	}
	return null;
}

/**
 * Candidate feed URLs for a host, cheapest question first.
 *
 * Deliberately not handled yet: iCal. Only 4 of 43 hosts with any feed
 * candidate in a byron run advertised one (`?ical=1` / `.ics`), and the first
 * one checked by hand — drillhalltheatre.org.au — answered 200 with a
 * zero-byte body. Correct iCal means a dependency for folding, escaping, TZID
 * and RRULE expansion, and recurrence is the part most likely to be silently
 * wrong. Not worth it at 4 hosts; revisit if a run shows more. Unrecognised
 * candidates are logged by host, so the evidence accumulates either way.
 *
 * `/wp-json/` is asked for its own route list rather than being guessed at:
 * guessing the tribe path across 24 hosts scored 1/24, while the root probe
 * found Modern Events Calendar on two of those same hosts. A site's own
 * route index cannot invent a route that does not exist.
 */
export function wpJsonRoutesToFeedUrls(body: string, origin: string): string[] {
	const parsed = asRecord(body);
	if (!parsed || Array.isArray(parsed)) return [];
	const routes =
		parsed.routes && typeof parsed.routes === "object" ? parsed.routes : {};
	const names = [
		...Object.keys(routes as Record<string, unknown>),
		...(Array.isArray(parsed.namespaces) ? parsed.namespaces.map(String) : []),
	];
	const out = new Set<string>();
	for (const name of names) {
		if (/tribe\/events\/v1/.test(name)) {
			out.add(new URL("/wp-json/tribe/events/v1/events", origin).href);
		}
		if (/mec\/v1/.test(name)) {
			out.add(new URL("/wp-json/mec/v1/events", origin).href);
		}
	}
	return [...out];
}

/** Feed URLs a page advertises about itself, from its `<link rel>` tags. */
export function feedUrlsFromHtml(html: string, pageUrl: string): string[] {
	const out = new Set<string>();
	const linkTag = /<link\b[^>]*>/gi;
	for (const [tag] of html.matchAll(linkTag)) {
		if (!/rel=["'][^"']*alternate/i.test(tag)) continue;
		const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
		if (!href) continue;
		const type = /type=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
		// Self-describing WordPress endpoints: oembed and wp/v2/pages|posts
		// return *this page's* metadata, and a bare namespace root
		// (wp-json/tribe/events/v1/) returns a route index. None can yield a
		// dated event, and each one costs a fetch — measured on
		// beachhotel.com.au, which advertises two of them.
		if (/oembed/i.test(href) || /oembed/i.test(type)) continue;
		if (/\/wp-json\/wp\/v2\/(pages|posts|media)\b/i.test(href)) continue;
		// WordPress advertises /feed/ and /comments/feed/ on every page, and
		// they syndicate blog posts, not events. Nothing here parses RSS, so
		// fetching them was 77 wasted requests across one byron run — the
		// largest single category of unrecognised feed candidate. Drop the
		// filter if an RSS parser ever lands.
		if (/\/(comments\/)?feed\/?$/i.test(new URL(href, pageUrl).pathname)) {
			continue;
		}
		// Namespaces nest: tribe/events/v1 is two segments deep before the
		// version, so this must not assume a single one.
		if (/\/wp-json\/(?:[^/]+\/)*v\d+\/?$/i.test(href)) continue;
		try {
			const abs = new URL(href, pageUrl).href;
			if (safeUrl(abs)) out.add(abs);
		} catch {
			// A malformed href in third-party HTML is not an error worth raising.
		}
	}
	return [...out];
}
