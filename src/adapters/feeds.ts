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
// parser owns every date in the pipeline. The only conversions are
// Squarespace's epoch-milliseconds and iCal's zoned times, machine-exact
// instants reformatted (not inferred) into ISO strings chrono reads back
// identically — verified — plus iCal RRULE expansion, done by ical.js.

import { XMLParser } from "fast-xml-parser";
import he from "he";
import ICAL from "ical.js";
import type { RawCandidateFields } from "./types.ts";

export type FeedFormat =
	| "events-calendar"
	| "modern-events-calendar"
	| "squarespace"
	| "trumba-json"
	| "opendatasoft"
	| "trumba-atom"
	| "fivestar"
	| "reading-cinemas"
	| "palace"
	| "ical";

export interface FeedResult {
	format: FeedFormat;
	/** Empty means the feed answered and has nothing — a verified negative. */
	events: RawCandidateFields[];
}

/**
 * One hostile response must not turn into unbounded downstream work. Feeds
 * legitimately paginate in the hundreds (beachhotel: 384) up to low
 * thousands for a citywide calendar (Brisbane City Council's Trumba feed:
 * ~2000), so this is well above any real page while still bounded.
 */
const MAX_EVENTS_PER_FEED = 2500;

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

/** Decodes entities and strips tags from the HTML fragments feeds put in
 * description fields (e.g. Trumba's JSON gives "&#39;"/"&amp;", not the
 * literal characters). */
function plain(value: unknown): string | null {
	const s = str(value);
	return s
		? (str(
				he
					.decode(s)
					.replace(/<[^>]*>/g, " ")
					.replace(/\s+/g, " "),
			) ?? null)
		: null;
}

/**
 * The first http(s) link in an HTML fragment. Council calendars keep the
 * event's real page — the organiser's site, the Eventbrite/Ticketmaster
 * listing — as an <a> inside a text field ("Bookings are required via <a
 * href=…>Ticketmaster</a>"), not as a URL field. ponytail: a regex over a
 * short, already-isolated fragment, not an HTML parser; mailto:/tel: and
 * anything unparseable fall through to the next candidate via safeUrl.
 * Google links (Maps directions, goo.gl shorteners) are skipped: descriptions
 * link the venue's map as often as the event, and a map is never the event.
 * So is the bare root of a council site: 48 Bookings fields pointed at
 * events.brisbane.qld.gov.au/, the booking portal's front page. An
 * organiser's own root (brisbaneillustrationfair.square.site/) is kept — for
 * a one-event site that is the event page.
 */
const NOT_AN_EVENT_PAGE = /(?:^|\.)(?:google\.[a-z.]+|goo\.gl|g\.page|g\.co)$/i;

const COUNCIL_HOST = /(?:^|\.)brisbane\.qld\.gov\.au$/i;

function firstHref(html: unknown): string | null {
	const s = str(html);
	if (!s) return null;
	for (const m of s.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gi)) {
		const u = safeUrl(he.decode(m[2]).trim());
		if (!u) continue;
		const { hostname, pathname, search } = new URL(u);
		if (NOT_AN_EVENT_PAGE.test(hostname)) continue;
		if (COUNCIL_HOST.test(hostname) && pathname === "/" && !search) continue;
		return u;
	}
	return null;
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

// --- Trumba calendars (JSON) ----------------------------------------------
// GET www.trumba.com/calendars/<name>.json → a bare array. Used by Brisbane
// City Council's citywide event calendars. Structured fields live in a
// label/value `customFields` array rather than as top-level keys — the same
// venue/cost/age metadata every Trumba-embedded page renders.

interface TrumbaCustomField {
	label?: unknown;
	value?: unknown;
}

interface TrumbaEvent {
	eventID?: unknown;
	title?: unknown;
	description?: unknown;
	location?: unknown;
	startDateTime?: unknown;
	endDateTime?: unknown;
	startTimeZoneOffset?: unknown;
	endTimeZoneOffset?: unknown;
	permaLinkUrl?: unknown;
	webLink?: unknown;
	eventImage?: { url?: unknown } | unknown;
	customFields?: unknown;
}

function trumbaCustomFieldRaw(fields: unknown, label: string): unknown {
	if (!Array.isArray(fields)) return null;
	const match = fields.find(
		(f) =>
			f &&
			typeof f === "object" &&
			str((f as TrumbaCustomField).label) === label,
	) as TrumbaCustomField | undefined;
	return match?.value ?? null;
}

function trumbaCustomField(fields: unknown, label: string): string | null {
	return plain(trumbaCustomFieldRaw(fields, label));
}

// Trumba's JSON gives a local wall-clock timestamp and a separate zone
// offset ("+1000") rather than one combined string. Concatenating the two
// is a reformat of values the source already gave, not an inference — same
// contract as Squarespace's epoch conversion above.
function trumbaTimestamp(dt: unknown, offset: unknown): string | null {
	const d = str(dt);
	if (!d) return null;
	const o = str(offset);
	if (!o) return d;
	return `${d}${o.length === 5 ? `${o.slice(0, 3)}:${o.slice(3)}` : o}`;
}

/**
 * The event's own page on Trumba's hosted calendar. The feeds' permalinks
 * point at the publisher's embed page instead (brisbane.qld.gov.au/trumba?
 * trumbaEmbed=view%3Devent…), which only renders the event when the embed
 * script runs and in practice lands on the council's event search. Trumba
 * answers `calendars/<name>?eventid=<id>` with the full event page for the
 * feed's own name — verified for brisbane-city-council, LIVE and
 * brisbane-events-rss (the Atom feed, which carries no other calendar name).
 * Null when the feed URL is not a Trumba calendar, so callers keep their
 * fallback.
 */
function trumbaEventUrl(
	feedUrl: string,
	eventId: string | null,
): string | null {
	if (!eventId || !/^\d+$/.test(eventId)) return null;
	try {
		const u = new URL(feedUrl);
		if (!/(?:^|\.)trumba\.com$/i.test(u.hostname)) return null;
		const name = /^\/calendars\/([^/]+?)\.(?:json|xml|rss)$/i.exec(
			u.pathname,
		)?.[1];
		return name
			? `https://www.trumba.com/calendars/${encodeURIComponent(name)}?eventid=${eventId}`
			: null;
	} catch {
		return null;
	}
}

function trumbaJsonToFields(
	e: TrumbaEvent,
	feedUrl: string,
): RawCandidateFields | null {
	const title = plain(e.title);
	const startRaw = trumbaTimestamp(e.startDateTime, e.startTimeZoneOffset);
	if (!title || !startRaw) return null;
	const image = (e.eventImage ?? {}) as { url?: unknown };
	return {
		...empty,
		title,
		description: plain(e.description),
		startRaw,
		endRaw: trumbaTimestamp(e.endDateTime, e.endTimeZoneOffset),
		venueName: trumbaCustomField(e.customFields, "Venue") ?? str(e.location),
		address: trumbaCustomField(e.customFields, "Venue address"),
		// The event's own page first: `webLink` is the organiser's site (an <a>,
		// not a URL — 21 of 2000 events), then the booking link inside the
		// Bookings field (917 of 2000: Eventbrite, Bookwhen, Ticketmaster…), then
		// a description link ("For more information, see <a…>" — 564 of 2000),
		// and only then Trumba's page for the event.
		url:
			firstHref(e.webLink) ??
			safeUrl(e.webLink) ??
			firstHref(trumbaCustomFieldRaw(e.customFields, "Bookings")) ??
			firstHref(e.description) ??
			trumbaEventUrl(feedUrl, str(e.eventID)) ??
			safeUrl(e.permaLinkUrl),
		price: trumbaCustomField(e.customFields, "Cost"),
		imageUrl: safeUrl(image.url),
		category:
			trumbaCustomField(e.customFields, "Primary event type") ??
			trumbaCustomField(e.customFields, "Event type"),
		sourceEventId: str(e.eventID),
	};
}

// --- Opendatasoft ------------------------------------------------------------
// GET data.brisbane.qld.gov.au/api/records/1.0/search/?dataset=… — the
// council's open-data mirror of its Trumba calendars. Datetimes arrive with
// their offset ("2026-09-25T18:00:00+10:00"). `web_link` is the same council
// embed permalink the Trumba feeds carry; the real page is an <a> in
// `bookings` (the exact Ticketmaster event, for Riverstage) or the description.

interface OdsRecord {
	recordid?: unknown;
	fields?: Record<string, unknown>;
}

function odsToFields(r: OdsRecord): RawCandidateFields | null {
	const f = r.fields ?? {};
	const title = plain(f.subject);
	const startRaw = str(f.start_datetime);
	if (!title || !startRaw) return null;
	return {
		...empty,
		title,
		description: plain(f.description),
		startRaw,
		endRaw: str(f.end_datetime),
		venueName: plain(f.venue) ?? plain(f.location),
		address: plain(f.venueaddress),
		url:
			firstHref(f.bookings) ?? firstHref(f.description) ?? safeUrl(f.web_link),
		price: plain(f.cost),
		imageUrl: safeUrl(f.eventimage),
		category: plain(f.primaryeventtype),
		sourceEventId: str(r.recordid),
	};
}

// --- Trumba calendars (Atom/GData RSS) -------------------------------------
// GET www.trumba.com/calendars/<name>.rss / brisbane-events-rss.xml → an Atom
// feed carrying Google GData calendar extensions (gd:*) plus Trumba's own
// flat gc:* fields per entry. Recognised by the x-trumba namespace
// declaration on the root <feed> — specific enough not to misfire on an
// unrelated Atom/RSS feed, same shape-not-URL rule as everything else here.
//
// Needs real XML parsing rather than regex: several gc:* tags repeat with
// different `type` attributes for unrelated values (e.g. two <gc:eventtype>
// elements, one numeric and one the actual category string), which only a
// structural parse can tell apart correctly.
const TRUMBA_ATOM_ROOT = /<feed\b[^>]*\bxmlns:x-trumba=/i;

function atomText(node: unknown): string | null {
	if (node == null) return null;
	if (typeof node === "string" || typeof node === "number") return str(node);
	if (typeof node === "object")
		return str((node as { "#text"?: unknown })["#text"]);
	return null;
}

function atomAttr(node: unknown, attr: string): string | null {
	if (!node || typeof node !== "object") return null;
	return str((node as Record<string, unknown>)[`@_${attr}`]);
}

function asArray<T>(v: T | T[] | undefined): T[] {
	if (v === undefined || v === null) return [];
	return Array.isArray(v) ? v : [v];
}

function trumbaAtomEntryToFields(
	e: Record<string, unknown>,
	feedUrl: string,
): RawCandidateFields | null {
	const title = plain(atomText(e.title));
	const when = e["gd:when"];
	const startRaw = atomAttr(when, "startTime");
	if (!title || !startRaw) return null;

	const links = asArray(e.link);
	const altLink = links.find((l) => atomAttr(l, "rel") === "alternate");

	const category =
		asArray(e["gc:eventtype"])
			.map((t) => (atomAttr(t, "type") === "string" ? atomText(t) : null))
			.find(Boolean) ?? null;

	const idMatch = /\/event\/(\d+)/.exec(str(e.id) ?? "");

	return {
		...empty,
		title,
		description: plain(atomText(e["gc:notes"])) ?? plain(atomText(e.content)),
		startRaw,
		endRaw: atomAttr(when, "endTime"),
		venueName:
			plain(atomText(e["gc:venue"])) ?? atomAttr(e["gd:where"], "valueString"),
		address: plain(atomText(e["gc:venueaddress"])),
		// Same order as the JSON feed; the Atom feed has no webLink field.
		url:
			firstHref(atomText(e["gc:bookings"])) ??
			firstHref(atomText(e["gc:notes"])) ??
			firstHref(atomText(e.content)) ??
			trumbaEventUrl(feedUrl, idMatch?.[1] ?? null) ??
			safeUrl(atomAttr(altLink, "href")),
		price: plain(atomText(e["gc:cost"])),
		imageUrl: safeUrl(atomText(e["gc:eventimage"])),
		category,
		sourceEventId: idMatch?.[1] ?? null,
	};
}

function parseTrumbaAtom(body: string, url: string): FeedResult | null {
	const trimmed = body.replace(/^﻿/, "").trimStart();
	if (!trimmed.startsWith("<?xml") && !trimmed.startsWith("<feed")) {
		return null;
	}
	if (!TRUMBA_ATOM_ROOT.test(trimmed)) return null;

	let doc: unknown;
	try {
		doc = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
		}).parse(trimmed);
	} catch {
		return null;
	}
	const feed = (doc as { feed?: Record<string, unknown> } | undefined)?.feed;
	if (!feed) return null;

	return {
		format: "trumba-atom",
		events: asArray(feed.entry)
			.slice(0, MAX_EVENTS_PER_FEED)
			.map((e) => trumbaAtomEntryToFields(e as Record<string, unknown>, url))
			.filter((f): f is RawCandidateFields => f !== null),
	};
}

// --- Cinema session APIs ---------------------------------------------------
// Cinemas list every session of every film — New Farm Cinemas alone runs ~108
// a week — so a cinema feed is filtered to the screenings that are events in
// their own right: a film with at most SPECIAL_MAX_SESSIONS sessions in the
// whole published programme (retro nights, festival slots, advance
// screenings, a book-club screening), or a session the cinema itself tags as
// special. Measured on both chains below: every such film had 1–2 sessions,
// every ordinary release 9+, so the threshold sits in a wide gap.
const SPECIAL_MAX_SESSIONS = 2;
/**
 * The session-count rule also needs the film to be *new* at that session. An
 * ordinary release at the tail of its run drops to 1–2 sessions too, and Five
 * Star lists a "Ticket Swap" placeholder (released 2021, one session in 2027).
 * Every measured special carries its screening date as its release date,
 * give or take a day, so two weeks of slack is generous.
 */
const SPECIAL_RELEASE_SLACK_DAYS = 14;

/** True when `release` (YYYY-MM-DD) is at most the slack before `first`. A
 * missing or unreadable date is not evidence of a special. */
function releasedForOccasion(release: unknown, first: unknown): boolean {
	const r = Date.parse(`${str(release) ?? ""}T00:00:00Z`);
	const f = Date.parse(`${(str(first) ?? "").slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(r) || Number.isNaN(f)) return false;
	return f - r <= SPECIAL_RELEASE_SLACK_DAYS * 86_400_000;
}

/** Five Star's own session attributes that mark a one-off screening. "NFT"
 * (no free tickets) and "Premium" (seating) describe the room, not the
 * occasion, and are deliberately absent. */
const FIVESTAR_SPECIAL_ATTRS = new Set([
	"Classic",
	"Festival",
	"Premiere",
	"Sneak Peek",
	"Q&A Panel",
	"35mm Film",
]);

// Five Star Cinemas (New Farm, Red Hill, Elizabeth, Regal, Yatala). The site
// is a client-rendered Next.js export whose HTML is an empty loader, which is
// why probe filed it unscrapable. Its own API answers plain HTTP, but picks
// the cinema from a `multisiteDomainv3` cookie, not the URL — so the source
// lists the human page (fivestarcinemas.com.au/red-hill) and the request is
// rewritten here.
const FIVESTAR_HOST = /(?:^|\.)fivestarcinemas\.com\.au$/i;

interface FiveStarSession {
	_id?: unknown;
	date?: unknown;
	time?: unknown;
	bookingLink?: unknown;
	attributes?: unknown;
}

interface FiveStarFilm {
	url?: unknown;
	title?: unknown;
	synopsisShort?: unknown;
	imageHorizontalUrl?: unknown;
	imageVerticalUrl?: unknown;
	releaseDate?: unknown;
	sessionTimes?: unknown;
}

function fivestarSite(url: string): string | null {
	try {
		const u = new URL(url);
		if (!FIVESTAR_HOST.test(u.hostname)) return null;
		const site = u.pathname.split("/").filter(Boolean)[0];
		return site && site !== "api" ? site : null;
	} catch {
		return null;
	}
}

function parseFiveStar(films: unknown[], url: string): FeedResult {
	const site = fivestarSite(url);
	const events: RawCandidateFields[] = [];
	for (const f of films.slice(0, MAX_EVENTS_PER_FEED) as FiveStarFilm[]) {
		const title = plain(f.title);
		const sessions = (
			Array.isArray(f.sessionTimes) ? f.sessionTimes : []
		) as FiveStarSession[];
		if (!title) continue;
		const slug = str(f.url);
		const firstDate = sessions
			.map((s) => str(s.date))
			.filter((d): d is string => !!d)
			.sort()[0];
		const fewSessions =
			sessions.length <= SPECIAL_MAX_SESSIONS &&
			releasedForOccasion(f.releaseDate, firstDate);
		for (const s of sessions) {
			const labels = (Array.isArray(s.attributes) ? s.attributes : [])
				.map((a) => str((a as { shortName?: unknown })?.shortName))
				.filter((a): a is string => !!a && FIVESTAR_SPECIAL_ATTRS.has(a));
			if (!fewSessions && labels.length === 0) continue;
			const date = str(s.date);
			const time = str(s.time);
			if (!date) continue;
			const synopsis = plain(f.synopsisShort);
			events.push({
				...empty,
				title,
				// The cinema's own label says why this one is an occasion; rank
				// reads the description, and "Classic · 35mm Film" is the signal.
				description:
					[labels.length ? `${labels.join(" · ")} screening.` : null, synopsis]
						.filter(Boolean)
						.join(" ") || null,
				startRaw: time ? `${date} ${time}` : date,
				url:
					site && slug
						? safeUrl(
								`https://www.fivestarcinemas.com.au/${site}/movie/${encodeURIComponent(slug)}`,
							)
						: safeUrl(s.bookingLink),
				imageUrl: safeUrl(f.imageHorizontalUrl) ?? safeUrl(f.imageVerticalUrl),
				category: "Film",
				sourceEventId: str(s._id),
			});
		}
	}
	return { format: "fivestar", events: events.slice(0, MAX_EVENTS_PER_FEED) };
}

// Reading Cinemas' platform, which runs Angelika (AFC South City Square,
// Woolloongabba). Also a client-rendered shell; the API wants a bearer token,
// but the site's public settings endpoint hands out an anonymous read-scoped
// one, so the source lists the films API URL itself and the token is added
// here. No session attributes are published, so only the session-count rule
// applies — which on the measured programme kept exactly the Archive,
// Hitchcocktober, book-club and marathon screenings.
const READING_API = /^prod-api\.readingcinemas\.com\.au$/i;
/** Which consumer site a Reading countryId belongs to, for event links. */
const READING_SITE: Record<string, string> = {
	"3": "https://angelikacinemas.com.au",
};

interface ReadingFilm {
	slug?: unknown;
	name?: unknown;
	synopsis?: unknown;
	film_image_large_size?: unknown;
	release_date?: unknown;
	showdates?: unknown;
}

function readingShowtimes(film: ReadingFilm): { id: unknown; at: unknown }[] {
	const out: { id: unknown; at: unknown }[] = [];
	for (const d of Array.isArray(film.showdates) ? film.showdates : []) {
		const types = (d as { showtypes?: unknown })?.showtypes;
		for (const t of Array.isArray(types) ? types : []) {
			const times = (t as { showtimes?: unknown })?.showtimes;
			for (const s of Array.isArray(times) ? times : []) {
				const st = s as { id?: unknown; date_time?: unknown };
				out.push({ id: st.id, at: st.date_time });
			}
		}
	}
	return out;
}

function parseReading(films: unknown[], url: string): FeedResult {
	const country = (() => {
		try {
			return new URL(url).searchParams.get("countryId") ?? "";
		} catch {
			return "";
		}
	})();
	const site = READING_SITE[country] ?? null;
	const events: RawCandidateFields[] = [];
	for (const f of films.slice(0, MAX_EVENTS_PER_FEED) as ReadingFilm[]) {
		const title = plain(f.name);
		const times = readingShowtimes(f);
		const firstAt = times
			.map((t) => str(t.at))
			.filter((d): d is string => !!d)
			.sort()[0];
		if (
			!title ||
			times.length > SPECIAL_MAX_SESSIONS ||
			!releasedForOccasion(f.release_date, firstAt)
		) {
			continue;
		}
		const slug = str(f.slug);
		for (const t of times) {
			const startRaw = str(t.at);
			if (!startRaw) continue;
			events.push({
				...empty,
				title,
				description: plain(f.synopsis),
				startRaw,
				url:
					site && slug
						? safeUrl(`${site}/movies/details/${encodeURIComponent(slug)}`)
						: null,
				imageUrl: safeUrl(f.film_image_large_size),
				category: "Film",
				sourceEventId: str(t.id),
			});
		}
	}
	return { format: "reading-cinemas", events };
}

// Palace Cinemas (Barracks, James St). A Next.js page whose __NEXT_DATA__
// carries two lists: `cinema.upcomingEvents`, the curated occasions, and
// `sessions`, every session per film. The occasions' only date,
// `startDateUTC`, is when the promotion starts (20 Aug for a 24 Sep
// premiere) — the generic hydration extractor took that for the event date,
// which is why every Palace event read as past. Sessions carry the real dates;
// an occasion only lends its title and caption to the session it names.
const PALACE_HOST = /(?:^|\.)palacecinemas\.com\.au$/i;
/** Palace's own session labels that mark an occasion. RECLINER and OPEN
 * CAPTIONS describe the room or access, not the screening. */
const PALACE_SPECIAL_ATTRS = new Set([
	"SPECIAL EVENT",
	"Sneak",
	"MOVIE CLUB",
	"RETRO",
]);
/** Festival films are titled "IFF26 Holy Cannoli" while the occasion says
 * "…Opening Night Premiere: Holy Cannoli". */
const FESTIVAL_PREFIX = /^[A-Z]{2,4}\d{2}\s+/;

interface PalaceSession {
	date?: unknown;
	sessionId?: unknown;
	isSpecialEvent?: unknown;
	displayAttributeText?: unknown;
}

interface PalaceFilm {
	slug?: unknown;
	title?: unknown;
	synopsis?: unknown;
	releaseDateUtc?: unknown;
	sessions?: unknown;
}

interface PalaceOccasion {
	title?: unknown;
	caption?: unknown;
}

function palaceKey(title: string): string {
	return title.replace(FESTIVAL_PREFIX, "").toLowerCase().replace(/\s+/g, " ");
}

function parsePalace(body: string, url: string): FeedResult | null {
	const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(body);
	if (!m) return null;
	let props: { sessions?: unknown; cinema?: { upcomingEvents?: unknown } };
	try {
		props = JSON.parse(m[1])?.props?.pageProps ?? {};
	} catch {
		return null;
	}
	if (!Array.isArray(props.sessions)) return null;
	const occasions = (
		Array.isArray(props.cinema?.upcomingEvents)
			? props.cinema.upcomingEvents
			: []
	) as PalaceOccasion[];
	const origin = new URL(url).origin;
	const events: RawCandidateFields[] = [];
	for (const f of props.sessions.slice(
		0,
		MAX_EVENTS_PER_FEED,
	) as PalaceFilm[]) {
		const title = plain(f.title);
		if (!title) continue;
		const sessions = (
			Array.isArray(f.sessions) ? f.sessions : []
		) as PalaceSession[];
		const firstDate = sessions
			.map((s) => str(s.date))
			.filter((d): d is string => !!d)
			.sort()[0];
		const fewSessions =
			sessions.length <= SPECIAL_MAX_SESSIONS &&
			releasedForOccasion(str(f.releaseDateUtc)?.slice(0, 10), firstDate);
		// Only a unique match lends its name: Sense and Sensibility has both a
		// "Fine Wine Preview" and a "Matinee Preview", and nothing says which
		// session is which.
		const key = palaceKey(title);
		const matches = occasions.filter((o) => {
			const t = plain(o.title);
			if (!t) return false;
			const k = palaceKey(t);
			return k === key || k.endsWith(`: ${key}`);
		});
		const occasion = matches.length === 1 ? matches[0] : null;
		const slug = str(f.slug);
		for (const s of sessions) {
			const label = str(s.displayAttributeText);
			const special =
				s.isSpecialEvent === true ||
				(label !== null && PALACE_SPECIAL_ATTRS.has(label));
			if (!special && !fewSessions) continue;
			// The trailing Z is false: "2026-09-24T18:15:00.000Z" renders on the
			// page as "6:15 pm". It is the city's wall-clock time, so it goes to
			// dates.ts as wall-clock text rather than as an instant.
			const startRaw = str(s.date)?.replace(/(\.\d+)?Z$/, "") ?? null;
			if (!startRaw) continue;
			events.push({
				...empty,
				title: plain(occasion?.title) ?? title,
				description:
					[
						special && label ? `${label.toLowerCase()} screening.` : null,
						plain(occasion?.caption),
						plain(f.synopsis),
					]
						.filter(Boolean)
						.join(" ") || null,
				startRaw,
				url: slug
					? safeUrl(`${origin}/movies/${encodeURIComponent(slug)}`)
					: null,
				category: "Film",
				sourceEventId: str(s.sessionId),
			});
		}
	}
	return { format: "palace", events: events.slice(0, MAX_EVENTS_PER_FEED) };
}

// --- iCalendar (RFC 5545) --------------------------------------------------
// A public calendar's .ics export — e.g. the Google Calendar House Conspiracy
// embeds on its /calendar page, which no other rung could read. Parsed with
// ical.js rather than by hand: line folding, escaping, VTIMEZONE and
// RRULE/EXDATE/RECURRENCE-ID are exactly what a hand parser gets silently
// wrong. Recurrence expansion is the library's arithmetic, not ours.

/** Recurring events are expanded this far ahead: past the two-week
 * publishing window with room to spare, not a whole weekly series to 2030. */
const ICAL_EXPAND_DAYS = 60;
/** Steps through one RRULE before giving up. A daily series started in 2021
 * takes ~2000 steps to reach today; an unbounded rule must not spin forever. */
const ICAL_MAX_STEPS = 5000;

/** All-day and floating times name no instant, so they go out as wall-clock
 * text for dates.ts. Zoned and UTC times are exact instants, reformatted to
 * ISO like Squarespace's epoch. ponytail: a TZID with no VTIMEZONE in the file
 * parses as floating, i.e. local time — right for this city's calendars, wrong
 * for a calendar kept in another zone; register the zone from IANA if one
 * shows up. */
function icalTimeToRaw(t: ICAL.Time): string {
	if (t.isDate || t.zone === ICAL.Timezone.localTimezone) return t.toString();
	return t.toJSDate().toISOString();
}

function icalFields(
	e: ICAL.Event,
	start: ICAL.Time,
	end: ICAL.Time | null,
	id: string,
): RawCandidateFields | null {
	const title = plain(e.summary);
	if (!title) return null;
	return {
		...empty,
		title,
		description: plain(e.description),
		startRaw: icalTimeToRaw(start),
		endRaw: end ? icalTimeToRaw(end) : null,
		address: plain(e.location),
		url: safeUrl(e.component.getFirstPropertyValue("url")),
		sourceEventId: id,
	};
}

export function parseIcal(body: string, now = new Date()): FeedResult | null {
	if (!body.replace(/^﻿/, "").trimStart().startsWith("BEGIN:VCALENDAR")) {
		return null;
	}
	let root: ICAL.Component;
	try {
		root = new ICAL.Component(ICAL.parse(body));
	} catch {
		return null;
	}
	for (const tz of root.getAllSubcomponents("vtimezone")) {
		ICAL.TimezoneService.register(tz);
	}
	const masters = new Map<string, ICAL.Event>();
	const overrides: ICAL.Component[] = [];
	for (const v of root.getAllSubcomponents("vevent")) {
		if (v.getFirstPropertyValue("status") === "CANCELLED") continue;
		if (v.hasProperty("recurrence-id")) overrides.push(v);
		else masters.set(String(v.getFirstPropertyValue("uid")), new ICAL.Event(v));
	}
	for (const o of overrides) {
		masters.get(String(o.getFirstPropertyValue("uid")))?.relateException(o);
	}

	const from = ICAL.Time.fromJSDate(new Date(now.getTime() - 86_400_000), true);
	const until = now.getTime() + ICAL_EXPAND_DAYS * 86_400_000;
	const events: RawCandidateFields[] = [];
	for (const [uid, e] of masters) {
		if (events.length >= MAX_EVENTS_PER_FEED) break;
		if (!e.isRecurring()) {
			// One-offs are all kept, past ones included: the window filter
			// downstream decides, as for Squarespace.
			const f = icalFields(e, e.startDate, e.endDate, uid);
			if (f) events.push(f);
			continue;
		}
		const it = e.iterator();
		for (
			let step = 0, next = it.next();
			next && step < ICAL_MAX_STEPS;
			step++, next = it.next()
		) {
			if (next.compare(from) < 0) continue;
			if (next.toJSDate().getTime() > until) break;
			const d = e.getOccurrenceDetails(next);
			const f = icalFields(
				d.item,
				d.startDate,
				d.endDate,
				`${uid}@${next.toString()}`,
			);
			if (f) events.push(f);
		}
	}
	return { format: "ical", events: events.slice(0, MAX_EVENTS_PER_FEED) };
}

// ponytail: one token per process; it is valid for an hour and a collect run
// takes minutes. Refresh on 401 if runs ever get that long.
let readingToken: Promise<string | null> | undefined;

async function fetchReadingToken(
	country: string,
	fetchImpl: typeof fetch,
): Promise<string | null> {
	const res = await fetchImpl(
		`https://prod-api.readingcinemas.com.au/settings/${encodeURIComponent(country)}`,
	);
	if (!res.ok) return null;
	const body = (await res.json()) as {
		data?: { settings?: { token?: unknown } };
	};
	return str(body?.data?.settings?.token);
}

/**
 * The request that actually answers a listing URL, for the few event APIs
 * that select their content by something other than the URL itself. Null for
 * everything else, which is fetched as-is.
 */
export async function apiRequestFor(
	url: string,
	fetchImpl: typeof fetch,
): Promise<{ url: string; headers: Record<string, string> } | null> {
	const site = fivestarSite(url);
	if (site) {
		return {
			url: "https://www.fivestarcinemas.com.au/api/movie/playing-now",
			headers: {
				Cookie: `multisiteDomainv3=${encodeURIComponent(`fivestarcinemas.com.au/${site}`)}`,
			},
		};
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (READING_API.test(parsed.hostname) && parsed.pathname === "/films") {
		readingToken ??= fetchReadingToken(
			parsed.searchParams.get("countryId") ?? "",
			fetchImpl,
		).catch(() => null);
		const token = await readingToken;
		// No token means the API will answer 401, which the adapter reports as
		// blocked — a failed look, never a quiet week.
		return { url, headers: token ? { Authorization: `Bearer ${token}` } : {} };
	}
	return null;
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
	if (!parsed) {
		// Gated by host: a __NEXT_DATA__ blob with a `sessions` array is too
		// generic a shape to claim on its own.
		const host = (() => {
			try {
				return new URL(url).hostname;
			} catch {
				return "";
			}
		})();
		if (PALACE_HOST.test(host)) return parsePalace(body, url);
		return parseIcal(body) ?? parseTrumbaAtom(body, url);
	}
	const origin = (() => {
		try {
			return new URL(url).origin;
		} catch {
			return "https://invalid.invalid";
		}
	})();

	// The Events Calendar: an `events` array plus its own `rest_url`/`total`.
	if (!Array.isArray(parsed)) {
		// Reading Cinemas: `{statusCode, data: [film with showdates]}`. An empty
		// `data` is ambiguous on shape alone, so that case is gated by host.
		const data = parsed.data;
		if (
			"statusCode" in parsed &&
			Array.isArray(data) &&
			((data.length > 0 &&
				"showdates" in (data[0] as Record<string, unknown>)) ||
				(data.length === 0 &&
					/^https:\/\/prod-api\.readingcinemas\.com\.au\//i.test(url)))
		) {
			return parseReading(data, url);
		}

		// Opendatasoft (data.brisbane.qld.gov.au — the council's Riverstage
		// dataset): `{nhits, parameters: {dataset}, records: [{fields}]}`.
		const records = parsed.records;
		if (
			Array.isArray(records) &&
			"nhits" in parsed &&
			typeof parsed.parameters === "object" &&
			parsed.parameters !== null &&
			"dataset" in parsed.parameters
		) {
			return {
				format: "opendatasoft",
				events: records
					.slice(0, MAX_EVENTS_PER_FEED)
					.map((r) => odsToFields(r as OdsRecord))
					.filter((f): f is RawCandidateFields => f !== null),
			};
		}

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

	// Five Star: a bare array of films each carrying `sessionTimes`. Empty is
	// gated by host, as for MEC.
	if (
		(parsed.length > 0 &&
			"sessionTimes" in (parsed[0] as Record<string, unknown>)) ||
		(parsed.length === 0 && fivestarSite(url) !== null)
	) {
		return parseFiveStar(parsed, url);
	}

	// Trumba calendar JSON: a bare array whose items carry Trumba's own
	// eventID/startDateTime fields. Shape-matched on a non-empty array (an
	// empty one is ambiguous the same way MEC's is, so that case is gated by
	// host instead).
	if (
		(parsed.length > 0 &&
			"eventID" in (parsed[0] as Record<string, unknown>) &&
			"startDateTime" in (parsed[0] as Record<string, unknown>)) ||
		(parsed.length === 0 && /(?:^|\.)trumba\.com\//i.test(url))
	) {
		return {
			format: "trumba-json",
			events: parsed
				.slice(0, MAX_EVENTS_PER_FEED)
				.map((e) => trumbaJsonToFields(e as TrumbaEvent, url))
				.filter((f): f is RawCandidateFields => f !== null),
		};
	}
	return null;
}

/**
 * Candidate feed URLs for a host, cheapest question first.
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
