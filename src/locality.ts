// Answers "is this venue actually in the city we are publishing for?" by
// geocoding the location string and measuring how far it is from the city
// centre.
//
// This replaced two hardcoded regexes (LOCAL_TERMS / ELSEWHERE in
// adapters/normalise.ts) that listed each city's suburbs and every other
// Australian capital. They worked — 35 wrong-city events went to 0 — but they
// do not survive a new city: adding Melbourne means moving "melbourne" from
// the reject list to a local list, and any city already named in the reject
// list is un-addable until someone remembers. Coordinates and a radius are two
// numbers per city that never need revisiting.
//
// Deliberately the Geocoding API and not Places Text Search: Geocoding is
// built for free-text address → coordinates at $5/1,000 with 10,000 free a
// month, where Places Text Search costs ~6× for business details we do not
// use. The reason to reach for Places would be bare venue names, and Geocoding
// turns out to handle those too ("The Zoo" → Fortitude Valley, "Ric's Bar" →
// Fortitude Valley), so it buys nothing here.
//
// Also deliberately not an LLM: which suburb belongs to which city is a fact,
// and a geocoder's answer can be checked while a model's recall cannot.
//
// Request budget — the API has no batch endpoint, so the only defence is
// asking less:
//   * The interface takes a list, so a caller cannot geocode per event. Every
//     distinct location is geocoded at most once per run.
//   * Results are cached on disk per city and committed, so a venue seen in an
//     earlier week is never geocoded again.
//   * Every tier is geocoded, but the two rules they feed differ in strength:
//     the distance test still only judges the aggregator tier, while the
//     outside-Australia test judges all of them (see curate.ts). Widening the
//     subject set costs one run of new venues and nothing after — the cache is
//     committed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_ROOT } from "./common.ts";
import { mapWithConcurrency } from "./providers/base.ts";

const ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
/** Concurrent geocode requests. The quota is generous; this is politeness. */
const MAX_CONCURRENT = 8;
const TIMEOUT_MS = 10_000;

export interface Place {
	lat: number;
	lng: number;
	/** The geocoder's own formatted_address, so a drop can be explained. */
	label: string;
	/**
	 * The geocoder's own country for this place, as a two-letter code. Null
	 * when it named none, which is no opinion rather than "nowhere".
	 */
	country?: string | null;
	/**
	 * Positively somewhere other than Australia — the country component said
	 * so. Optional because entries cached before this existed have no opinion,
	 * and absent reads as false.
	 */
	foreign?: boolean;
}

/**
 * Location string ⇒ where it is.
 *
 * Three states, and the difference matters: a `Place` resolved, `null` means
 * the geocoder answered that it knows of no such place (a real, cacheable
 * answer), and an absent key means the request itself failed — which must not
 * be cached, or one bad afternoon poisons a venue's verdict permanently.
 */
export type Geocoder = (
	locations: string[],
) => Promise<Map<string, Place | null>>;

export interface CityCentre {
	lat: number;
	lng: number;
	/** How far from the centre still counts as this city. */
	radiusKm: number;
}

const EARTH_RADIUS_KM = 6371;

export function distanceKm(
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number {
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * The locations that are too far from the city centre to belong to it, mapped
 * to a human-readable reason for the log.
 *
 * Everything else is kept, including locations that failed or resolved to
 * nothing: absence of evidence is not evidence of elsewhere, and dropping is
 * the destructive direction.
 */
export function findElsewhere(
	places: Map<string, Place | null>,
	centre: CityCentre,
): Map<string, string> {
	const out = new Map<string, string>();
	// A half-filled centre (a new city's config with the coordinates not yet
	// looked up) would drop the entire city's events: NaN makes every
	// comparison false, and a zeroed lat/lng puts the "city" in the Gulf of
	// Guinea, thousands of km from every real venue. Treated as no centre.
	if (
		!Number.isFinite(centre.lat) ||
		!Number.isFinite(centre.lng) ||
		!(centre.radiusKm > 0) ||
		(centre.lat === 0 && centre.lng === 0)
	) {
		console.error(
			"  ⚠ [locality] centre is incomplete — keeping every location",
		);
		return out;
	}
	for (const [location, place] of places) {
		if (!place) continue;
		const km = distanceKm(centre, place);
		if (km <= centre.radiusKm) continue;
		out.set(location, `${place.label} — ${Math.round(km)} km away`);
	}
	return out;
}

/**
 * The locations that resolved outside Australia, mapped to the same kind of
 * human-readable reason.
 *
 * Separate from findElsewhere because it is trusted far more widely. The
 * distance test only runs on the aggregator tier, where a source promoted "for
 * Brisbane" turns out to be national — a venue's own site is trusted, and "The
 * Princess Theatre" geocodes to Melbourne while being a real Brisbane venue.
 * Being in a different *country*, though, is never a near-miss: a
 * `method: scraper` source verified for Brisbane turned out to list meetups
 * worldwide, and eight events in Vienna, Berlin, London, Portland, Montreal,
 * Zurich, Stockholm and Manchester reached the site under an `independents`
 * entry. So this rule applies to every tier, and needs no centre or radius.
 */
export function findForeign(
	places: Map<string, Place | null>,
): Map<string, string> {
	const out = new Map<string, string>();
	for (const [location, place] of places) {
		if (!place?.foreign) continue;
		// Checked again on the way out, not only when the flag was set. Entries
		// cached before the country check existed were flagged by a broken
		// inference ("the AU-restricted search failed, so it must be abroad"),
		// and one of them was Opera Queensland at "S01/140 Grey St, South
		// Brisbane QLD 4101, Australia". Re-reading the label here means a stale
		// cache heals itself instead of needing a migration, and costs nothing.
		if (/,\s*Australia$/i.test(place.label)) continue;
		out.set(location, `${place.label} — not in Australia`);
	}
	return out;
}

interface GeocodeResponse {
	status?: string;
	error_message?: string;
	results?: {
		formatted_address?: string;
		types?: string[];
		address_components?: { types?: string[]; short_name?: string }[];
		geometry?: { location?: { lat?: number; lng?: number } };
	}[];
}

/**
 * The country the geocoder actually put this place in, as a two-letter code,
 * or null when it named none.
 *
 * Read from address_components rather than inferred from the search having
 * failed under `components=country:AU`. That inference was wrong and dropped a
 * real event: "Opera Queensland, S01/140 Grey St, South Brisbane QLD 4101"
 * returns ZERO_RESULTS under the country filter — the unit prefix defeats it —
 * and then resolved, unrestricted, to an address plainly in Australia. An
 * AU-restricted miss is not evidence of being abroad; only a country component
 * that says so is.
 */
function countryOf(result: {
	address_components?: { types?: string[]; short_name?: string }[];
}): string | null {
	const country = (result.address_components ?? []).find((c) =>
		(c.types ?? []).includes("country"),
	);
	return country?.short_name ?? null;
}

/** Statuses that are a real answer about the address rather than a problem
 * with the request. Anything else is treated as a failure and left uncached. */
const NO_SUCH_PLACE = new Set(["ZERO_RESULTS", "INVALID_REQUEST"]);

/**
 * Result types that mean the geocoder gave up and returned a whole country or
 * state rather than a place. "Zzzz Nonexistent Venue Qqqq" resolves to the
 * centroid of Australia, which is thousands of km from any city centre — so
 * without this a junk location would be confidently dropped as "elsewhere".
 * A `locality` (a suburb) is specific enough and stays.
 */
const TOO_COARSE = new Set(["country", "administrative_area_level_1"]);

/**
 * `undefined` means the request itself failed and must not be cached — the
 * third state the Geocoder contract describes, which a Map models by leaving
 * the key out entirely.
 */
type Lookup = Place | null | undefined;

export function createGoogleGeocoder(apiKey: string): Geocoder {
	// The location goes in exactly as it appears, with no city appended.
	// Appending the publishing city was tried and is actively wrong: it gives
	// the geocoder a fallback it latches onto, and "Queensland Museum Cobb+Co,
	// Toowoomba", "Home of the Arts, Surfers Paradise" and "Enmore Theatre,
	// Newtown" all came back as "Brisbane QLD" at 0 km — the filter would have
	// dropped nothing at all.
	async function lookup(
		location: string,
		restrictToAU: boolean,
	): Promise<Lookup> {
		const params = new URLSearchParams({ address: location, key: apiKey });
		if (restrictToAU) params.set("components", "country:AU");
		try {
			const res = await fetch(`${ENDPOINT}?${params}`, {
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			const body = (await res.json()) as GeocodeResponse;
			if (body.status === "OK") {
				const top = body.results?.[0];
				const at = top?.geometry?.location;
				const coarse = (top?.types ?? []).some((ty) => TOO_COARSE.has(ty));
				if (coarse) return null;
				if (typeof at?.lat === "number" && typeof at?.lng === "number") {
					return {
						lat: at.lat,
						lng: at.lng,
						label: top?.formatted_address ?? location,
						country: top ? countryOf(top) : null,
					};
				}
			}
			if (NO_SUCH_PLACE.has(body.status ?? "")) return null;
			console.error(
				`  ⚠ [locality] ${body.status ?? res.status} for "${location}"${
					body.error_message ? `: ${body.error_message}` : ""
				} — keeping it`,
			);
			return undefined;
		} catch (err) {
			console.error(
				`  ⚠ [locality] "${location}" failed: ${(err as Error).message} — keeping it`,
			);
			return undefined;
		}
	}

	return async function geocode(locations) {
		const results = await mapWithConcurrency(
			locations,
			MAX_CONCURRENT,
			async (location): Promise<[string, Place | null][]> => {
				// Australia first, and for almost every location that is the only
				// call: bare venue names resolve correctly under the restriction
				// ("The Zoo" → Fortitude Valley, "Ric's Bar" → Fortitude Valley).
				const local = await lookup(location, true);
				if (local !== null) return local ? [[location, local]] : [];

				// The AU-restricted search found no such place. That used to end
				// here as "no opinion, keep it", which is why eight events in
				// Vienna, Berlin, London and five other cities reached a Brisbane
				// digest — "Vienna" cannot resolve inside country:AU, so it could
				// only ever come back ZERO_RESULTS. One unrestricted retry answers
				// the actual question.
				const anywhere = await lookup(location, false);
				if (!anywhere) return anywhere === null ? [[location, null]] : [];
				// Foreign only when the result SAYS it is somewhere other than
				// Australia. The restricted search failing is not evidence: the
				// filter also misses real Australian addresses (a unit prefix is
				// enough to defeat it), and treating that as "abroad" dropped a
				// Brisbane Opera Queensland event whose own resolved address ended
				// in "QLD 4101, Australia". A missing country component is no
				// opinion either, and no opinion means keep.
				// Two independent guards, because dropping is the destructive
				// direction and one bad verdict removes a real event silently: the
				// country component must say non-AU, AND the address the geocoder
				// printed must not itself end in "Australia".
				const foreign =
					anywhere.country !== null &&
					anywhere.country !== "AU" &&
					!/,\s*Australia$/i.test(anywhere.label);
				return [[location, { ...anywhere, foreign }]];
			},
		);
		return new Map(results.flat());
	};
}

interface CacheFile {
	/** location (as sent) ⇒ its place, or null for "no such place". */
	places: Record<string, Place | null>;
}

function cachePath(cityKey: string): string {
	return join(DATA_ROOT, cityKey, "locations.json");
}

function readCache(cityKey: string): Record<string, Place | null> {
	const path = cachePath(cityKey);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
		return parsed.places ?? {};
	} catch {
		return {};
	}
}

export interface GeocodeStats {
	/** Distinct locations sent to the API. */
	requested: number;
	/** Distinct locations answered from the cache file. */
	cached: number;
}

/**
 * Deduplicates, serves what it can from disk, requests only the rest, and
 * writes the result back.
 *
 * The cache lives in `data/{city}/`, which the workflow already commits, so CI
 * starts warm and steady state is only genuinely new venues — a few dozen a
 * month, well inside the free tier.
 */
export function withPlaceCache(
	geocode: Geocoder,
	cityKey: string,
): Geocoder & { stats: GeocodeStats } {
	const stats: GeocodeStats = { requested: 0, cached: 0 };

	const wrapped = async (locations: string[]) => {
		const cache = readCache(cityKey);
		const out = new Map<string, Place | null>();
		const unknown: string[] = [];
		// Deduplicated on the exact string sent, so the cache key and the lookup
		// key can never disagree.
		for (const location of new Set(locations.map((l) => l.trim()))) {
			if (!location) continue;
			if (!(location in cache)) {
				unknown.push(location);
				continue;
			}
			stats.cached++;
			out.set(location, cache[location]);
		}

		if (unknown.length === 0) return out;
		stats.requested = unknown.length;
		const fresh = await geocode(unknown);
		for (const [location, place] of fresh) {
			out.set(location, place);
			// Only what the API actually answered is cached; a failed request is
			// absent from `fresh` and so gets retried next run.
			cache[location] = place;
		}

		try {
			const path = cachePath(cityKey);
			mkdirSync(dirname(path), { recursive: true });
			// Sorted so the committed file diffs by content, not iteration order.
			const places = Object.fromEntries(
				Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)),
			);
			writeFileSync(path, JSON.stringify({ places }, null, 2), "utf-8");
		} catch (err) {
			console.error(
				`  ⚠ [locality] cache not written: ${(err as Error).message}`,
			);
		}
		return out;
	};

	return Object.assign(wrapped, { stats });
}
