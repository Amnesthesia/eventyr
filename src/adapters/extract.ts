// Shared extraction-strategy helpers, used by adapters in strict priority
// order (JSON-LD, then structured endpoints, then HTML selectors as a last
// resort — see refactor prompt, Phase 2). These are generic parsers over
// already-fetched bodies; per-site HTML selectors are each adapter's own
// concern (Phase 3), isolated in that adapter's file.

const EVENT_TYPES = new Set([
	"event",
	"musicevent",
	"theaterevent",
	"exhibitionevent",
	"festival",
	"screeningevent",
	"comedyevent",
	"dancetevent",
	"visualartsevent",
	"educationevent",
	"socialevent",
	"courseinstance",
	"childrensevent",
]);

function asArray<T>(v: T | T[] | undefined | null): T[] {
	if (v === undefined || v === null) return [];
	return Array.isArray(v) ? v : [v];
}

function typeMatches(node: Record<string, unknown>): boolean {
	return asArray(node["@type"] as string | string[]).some((t) =>
		EVENT_TYPES.has(String(t).toLowerCase()),
	);
}

/**
 * Pulls every JSON-LD block out of an HTML document and parses it. Invalid
 * blocks are skipped rather than aborting the whole extraction — one bad
 * script tag on a page shouldn't cost every other event on it.
 */
export function extractJsonLdBlocks(html: string): unknown[] {
	const blocks: unknown[] = [];
	const re =
		/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	let match: RegExpExecArray | null = re.exec(html);
	while (match !== null) {
		const raw = match[1]?.trim();
		if (raw) {
			try {
				blocks.push(JSON.parse(raw));
			} catch {
				// skip malformed block
			}
		}
		match = re.exec(html);
	}
	return blocks;
}

/**
 * Flattens parsed JSON-LD blocks into individual Event-typed nodes,
 * unwrapping @graph and nested subEvent (e.g. a Festival with many
 * subEvent sessions, or a season with multiple performances).
 */
export function findEventNodes(blocks: unknown[]): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];

	function visit(node: unknown): void {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		const obj = node as Record<string, unknown>;

		if (typeMatches(obj)) found.push(obj);
		if (obj["@graph"]) visit(obj["@graph"]);
		if (obj.subEvent) visit(obj.subEvent);
	}

	for (const block of blocks) visit(block);
	return found;
}

function firstString(v: unknown): string | null {
	if (typeof v === "string" && v.trim()) return v.trim();
	if (Array.isArray(v)) {
		for (const item of v) {
			const s = firstString(item);
			if (s) return s;
		}
	}
	return null;
}

function extractLocation(node: Record<string, unknown>): {
	venueName: string | null;
	address: string | null;
} {
	const location = node.location as Record<string, unknown> | undefined;
	if (!location) return { venueName: null, address: null };
	const venueName = firstString(location.name);
	const addr = location.address;
	let address: string | null = null;
	if (typeof addr === "string") {
		address = addr.trim() || null;
	} else if (addr && typeof addr === "object") {
		const a = addr as Record<string, unknown>;
		address =
			firstString(
				[a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
					.filter(Boolean)
					.join(", "),
			) ?? null;
	}
	return { venueName, address };
}

function extractPrice(node: Record<string, unknown>): string | null {
	const offers = node.offers;
	const offer = Array.isArray(offers) ? offers[0] : offers;
	if (!offer || typeof offer !== "object") return null;
	const o = offer as Record<string, unknown>;
	if (o.price !== undefined && o.price !== null && o.price !== "") {
		const currency = firstString(o.priceCurrency) ?? "";
		return `${currency} ${o.price}`.trim();
	}
	return null;
}

/**
 * Maps one schema.org Event JSON-LD node into a CandidateEvent-shaped
 * record. Deliberately returns raw field values only — no inference, no
 * defaulting. Callers attach provenance and run this through the date
 * parser (dates.ts) themselves so a missing/unparseable date stays null
 * rather than silently becoming "today" or similar.
 */
export function jsonLdNodeToRawFields(node: Record<string, unknown>): {
	title: string | null;
	description: string | null;
	startRaw: string | null;
	endRaw: string | null;
	venueName: string | null;
	address: string | null;
	url: string | null;
	price: string | null;
	imageUrl: string | null;
	organiser: string | null;
	category: string | null;
	sourceEventId: string | null;
} {
	const { venueName, address } = extractLocation(node);
	const organizer = node.organizer as Record<string, unknown> | undefined;
	return {
		title: firstString(node.name),
		description: firstString(node.description),
		startRaw: firstString(node.startDate),
		endRaw: firstString(node.endDate),
		venueName,
		address,
		url: firstString(node.url),
		price: extractPrice(node),
		imageUrl: firstString(node.image),
		organiser: organizer ? firstString(organizer.name) : null,
		category: firstString(asArray(node["@type"] as string | string[])[0]),
		sourceEventId: firstString(node["@id"]),
	};
}

// --- Structured endpoint / embedded-state discovery ---------------------

export interface FeedLinks {
	rss: string[];
	ics: string[];
}

/** Finds RSS and iCal feed links declared in <head>, resolved against base. */
export function discoverFeedLinks(html: string, baseUrl: string): FeedLinks {
	const rss: string[] = [];
	const ics: string[] = [];
	const linkRe = /<link\b[^>]*>/gi;
	let match: RegExpExecArray | null = linkRe.exec(html);
	while (match !== null) {
		const tag = match[0];
		const typeMatch = /type=["']([^"']+)["']/i.exec(tag);
		const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
		if (hrefMatch) {
			const type = typeMatch?.[1]?.toLowerCase() ?? "";
			const href = new URL(hrefMatch[1], baseUrl).toString();
			if (type.includes("rss") || type.includes("atom")) rss.push(href);
			if (type.includes("calendar") || href.endsWith(".ics")) ics.push(href);
		}
		match = linkRe.exec(html);
	}
	return { rss, ics };
}

/** Extracts the __NEXT_DATA__ or __NUXT__ embedded state blob, if present. */
export function extractEmbeddedState(html: string): unknown | null {
	const nextMatch =
		/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(
			html,
		);
	if (nextMatch?.[1]) {
		try {
			return JSON.parse(nextMatch[1]);
		} catch {
			// fall through
		}
	}
	const nuxtMatch =
		/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i.exec(html);
	if (nuxtMatch?.[1]) {
		try {
			// __NUXT__ blobs are sometimes JS object literals, not strict JSON —
			// only trust ones that happen to parse as JSON rather than eval'ing.
			return JSON.parse(nuxtMatch[1]);
		} catch {
			return null;
		}
	}
	return null;
}

/** Well-known structured-endpoint URL builders — adapters probe these with
 * the shared fetcher before falling back to HTML selectors. */
export const structuredEndpoints = {
	wordPressEvents(base: string): string {
		return new URL("/wp-json/wp/v2/events", base).toString();
	},
	theEventsCalendar(base: string): string {
		return new URL("/wp-json/tribe/events/v1/events", base).toString();
	},
	squarespaceJson(pathUrl: string): string {
		const u = new URL(pathUrl);
		u.searchParams.set("format", "json");
		return u.toString();
	},
};
