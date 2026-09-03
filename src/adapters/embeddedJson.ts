// Third extraction strategy, between JSON-LD and the LLM: recover the JSON a
// JavaScript-rendered page ships inline.
//
// A lot of these venue sites render their listings client-side, so
// stripToReadableText sees a shell with no events in it and the page looks
// empty — but the data is usually right there in the HTML, embedded as state
// for the framework to hydrate from. Deterministic and free where it works,
// which is why it runs before the LLM fallback.
//
// Covers what a survey of the real sources actually turned up:
//   - __NEXT_DATA__                     Next.js pages router
//   - self.__next_f.push([...])         Next.js app router (RSC flight data)
//   - window.__NUXT__                   Nuxt
//   - __remixContext / __sveltekit_*    Remix, SvelteKit
//   - <script type="application/json">  generic hydration blobs
//
// Not covered, deliberately: data fetched over XHR/GraphQL after load (e.g.
// State Library of Queensland POSTs to a Drupal GraphQL endpoint). Nothing is
// in the HTML to find, so those stay on the LLM/search path unless someone
// writes a per-site adapter.

import type { RawCandidateFields } from "./types.ts";

// Key matching is by pattern, not by a fixed list: every site names these
// fields differently (runDateStart, starts_at, eventDate, firstDate...), and
// an exhaustive literal list is a losing game. END is checked before START so
// "runDateEnd" can't be mistaken for a start.
const KEY = {
	title: /^(title|name|event_?name|heading|label|headline)$/i,
	end: /(end|until|finish|last)(_?date|_?time|s_?at)?$|^run_?date_?end$/i,
	// Metadata dates, never an event's start. Without this, dateModified or
	// datePublished wins (pick() takes the first matching key) and the event
	// is dated to when the page was edited.
	metaDate: /(modified|published|created|updated|crawled|indexed|expires?)/i,
	start:
		/^(start|begin|from|date|datetime|when|event_?date|first_?date|run_?date_?start|show_?date)/i,
	description:
		/^(description|summary|excerpt|body|teaser|subtitle|blurb|synopsis)$/i,
	url: /^(url|link|permalink|href|path|slug|uri|detail_?url)$/i,
	image: /^(image|image_?url|thumbnail|featured_?image|img|hero|poster)/i,
	venue:
		/^(venue|location|place|venue_?name|venue_?summary|where|space|room)$/i,
	price: /^(price|cost|ticket_?price|price_?range|admission|fee)$/i,
	category: /^(category|categories|type|event_?type|genre|tags?|codename)$/i,
	id: /^(id|nid|uuid|event_?id|post_?id|external_?id)$/i,
	organiser: /^(organiser|organizer|presenter|promoter|producer|company)$/i,
} as const;

/** Pulls every inline JSON blob a page ships, parsed. Anything that doesn't
 * parse is skipped rather than failing the page. */
export function extractEmbeddedJson(html: string): unknown[] {
	const blobs: unknown[] = [];
	const push = (raw: string | undefined): void => {
		if (!raw?.trim()) return;
		try {
			blobs.push(JSON.parse(raw));
		} catch {
			// not JSON (or a JS object literal we deliberately don't eval)
		}
	};

	// <script id="__NEXT_DATA__"> and any generic application/json blob.
	const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
	let m: RegExpExecArray | null = scriptRe.exec(html);
	while (m !== null) {
		const attrs = m[1] ?? "";
		const body = m[2] ?? "";
		const isJsonType = /type=["']application\/json["']/i.test(attrs);
		const isNextData = /id=["']__NEXT_DATA__["']/i.test(attrs);
		// ld+json is the JSON-LD strategy's job, not this one.
		const isLd = /type=["']application\/ld\+json["']/i.test(attrs);
		if ((isJsonType || isNextData) && !isLd) push(body);
		m = scriptRe.exec(html);
	}

	// window.__NUXT__ = {...} / __remixContext = {...} / __sveltekit_x = {...}
	for (const re of [
		/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
		/window\.__remixContext\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
		/__sveltekit_[a-z0-9]+\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
	]) {
		const match = re.exec(html);
		if (match?.[1]) push(match[1]);
	}

	blobs.push(...extractFlightData(html));
	return blobs;
}

/**
 * Next.js app-router pages stream their server payload as a series of
 * `self.__next_f.push([1,"<chunk>"])` calls. Concatenating the chunks gives
 * a flight stream whose lines are `<id>:<json>` — the JSON parts hold the
 * actual props, including listing data.
 */
function extractFlightData(html: string): unknown[] {
	const re = /self\.__next_f\.push\(\[1\s*,\s*("(?:[^"\\]|\\.)*")\]\)/g;
	let joined = "";
	let m: RegExpExecArray | null = re.exec(html);
	while (m !== null) {
		try {
			joined += JSON.parse(m[1]) as string;
		} catch {
			// skip an unparsable chunk
		}
		m = re.exec(html);
	}
	if (!joined) return [];

	const out: unknown[] = [];
	// Each payload line looks like `1a:{"foo":...}` or `2b:[...]`; scan for the
	// start of each JSON value and take the balanced span from there.
	const startRe = /[0-9a-f]+:[A-Z]?(\[|\{)/g;
	let s: RegExpExecArray | null = startRe.exec(joined);
	while (s !== null) {
		const span = balancedSpan(joined, joined.indexOf(s[1], s.index));
		if (span) {
			try {
				out.push(JSON.parse(span));
			} catch {
				// partial/streamed chunk — ignore
			}
		}
		s = startRe.exec(joined);
	}
	return out;
}

/** Returns the balanced {...} or [...] beginning at `start`, or null. */
function balancedSpan(text: string, start: number): string | null {
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') inString = !inString;
		if (inString) continue;
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
		// Runaway guard: these blobs can be megabytes.
		if (i - start > 2_000_000) return null;
	}
	return null;
}

function pick(obj: Record<string, unknown>, pattern: RegExp): unknown {
	for (const k of Object.keys(obj)) {
		// A start pattern must never swallow an end or metadata field.
		if (pattern === KEY.start && (KEY.end.test(k) || KEY.metaDate.test(k))) {
			continue;
		}
		if (!pattern.test(k)) continue;
		const v = obj[k];
		if (v !== null && v !== undefined && v !== "") return v;
	}
	return undefined;
}

/** Flattens the shapes these blobs use for a value: a string, {value}, an
 * array of either, or a nested {name}/{title} object. */
function asText(v: unknown, depth = 0): string | null {
	if (depth > 3) return null;
	if (typeof v === "string") return v.trim() || null;
	if (typeof v === "number") return String(v);
	if (Array.isArray(v)) {
		for (const item of v) {
			const s = asText(item, depth + 1);
			if (s) return s;
		}
		return null;
	}
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		for (const k of [
			"name",
			"title",
			"value",
			"url",
			"src",
			"label",
			"rendered",
		]) {
			const s = asText(o[k], depth + 1);
			if (s) return s;
		}
	}
	return null;
}

const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

/**
 * A date needs digits, not just a month-shaped word. Matching a bare month
 * substring meant any prose containing "may" or "march" dated an object, which
 * is how nav labels and blog posts were passing as events — and because
 * pageAdapter returns as soon as this strategy yields anything, one such false
 * positive suppressed the LLM fallback and the page's real events vanished.
 */
function looksLikeDate(v: unknown): boolean {
	const s = asText(v);
	if (!s) return false;
	return (
		/\d{4}-\d{2}-\d{2}/.test(s) ||
		/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s) ||
		new RegExp(`\\b(${MONTH})[a-z]*\\.?,?\\s+\\d{1,2}\\b`, "i").test(s) ||
		new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+(${MONTH})`, "i").test(s) ||
		/^\d{10,13}$/.test(s)
	);
}

/** An object is event-shaped if it names something and dates it. Deliberately
 * strict on the date: without one the record can't survive normalisation
 * anyway, and loose matching here pulls in menus, staff and article lists. */
export function isEventLike(v: unknown): v is Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	const obj = v as Record<string, unknown>;
	const title = pick(obj, KEY.title);
	if (!asText(title)) return false;
	const start = pick(obj, KEY.start);
	return start !== undefined && looksLikeDate(start);
}

/** Walks arbitrary parsed JSON for arrays of event-shaped objects. */
export function findEventObjects(blobs: unknown[]): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	const seen = new Set<unknown>();

	function visit(node: unknown, depth: number): void {
		if (depth > 12 || node === null || typeof node !== "object") return;
		if (seen.has(node)) return;
		seen.add(node);

		if (Array.isArray(node)) {
			for (const item of node) {
				if (isEventLike(item)) found.push(item as Record<string, unknown>);
				else visit(item, depth + 1);
			}
			return;
		}
		if (isEventLike(node)) {
			found.push(node as Record<string, unknown>);
			// still descend: a season object can contain its sessions
		}
		for (const v of Object.values(node as Record<string, unknown>)) {
			visit(v, depth + 1);
		}
	}

	for (const blob of blobs) visit(blob, 0);
	return found;
}

function resolveUrl(value: unknown, baseUrl: string): string | null {
	const raw = asText(value);
	if (!raw) return null;
	try {
		return new URL(raw, baseUrl).toString();
	} catch {
		return null;
	}
}

/** Maps one event-shaped JSON object into the shared pre-date-parsing shape.
 * Values are copied, never computed — dates.ts still resolves the dates. */
function jsonObjectToRawFields(
	obj: Record<string, unknown>,
	baseUrl: string,
): RawCandidateFields {
	const venue = pick(obj, KEY.venue);
	return {
		title: asText(pick(obj, KEY.title)),
		description: asText(pick(obj, KEY.description)),
		startRaw: asText(pick(obj, KEY.start)),
		endRaw: asText(pick(obj, KEY.end)),
		venueName: asText(venue),
		address:
			venue && typeof venue === "object"
				? asText((venue as Record<string, unknown>).address)
				: null,
		url: resolveUrl(pick(obj, KEY.url), baseUrl),
		price: asText(pick(obj, KEY.price)),
		imageUrl: resolveUrl(pick(obj, KEY.image), baseUrl),
		organiser: asText(pick(obj, KEY.organiser)),
		category: asText(pick(obj, KEY.category)),
		sourceEventId: asText(pick(obj, KEY.id)),
	};
}

/** Whole strategy in one call: HTML in, candidate fields out. */
export function extractFromEmbeddedJson(
	html: string,
	baseUrl: string,
): RawCandidateFields[] {
	const objects = findEventObjects(extractEmbeddedJson(html));
	const byKey = new Map<string, RawCandidateFields>();
	for (const obj of objects) {
		const fields = jsonObjectToRawFields(obj, baseUrl);
		if (!fields.title || !fields.startRaw) continue;
		// The same event often appears in several blobs (page props and a
		// preloaded cache, say) — key on what identifies it.
		const key = `${fields.title}|${fields.startRaw}|${fields.url ?? ""}`;
		if (!byKey.has(key)) byKey.set(key, fields);
	}
	return [...byKey.values()];
}
