// Resolves the scraper-backed entries of a city's unified source file
// (sources/{city}.yml) into fully-populated SourceDefinitions the adapter
// framework can run. Validation lives here rather than in the adapters
// themselves so a malformed entry fails loudly at load time instead of
// producing a half-formed payload three steps downstream.

import { loadCityConfig, type SourceEntry, scraperSources } from "../common.ts";
import type { SourceDefinition } from "./types.ts";

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) || "source"
	);
}

/**
 * Prefers the domain over the name: names repeat in the source lists (the
 * same venue listed twice, or two venues sharing a name) whereas a host is
 * unique by construction, and it also reproduces the ids the hand-written
 * registry used (qagoma, slq, metroarts...) so scraped output filenames stay
 * stable across the migration.
 */
function deriveId(entry: SourceEntry): string {
	const host = entry.domains?.[0]
		?.replace(/^https?:\/\//, "")
		.split("/")[0]
		.toLowerCase()
		.replace(/^www\./, "");
	if (!host) return slugify(entry.name);
	const bare = host.replace(
		/\.(com\.au|org\.au|net\.au|edu\.au|gov\.au|qld\.gov\.au|asn\.au|au|com|org|net|co|io|is|bar|space)$/,
		"",
	);
	return slugify(bare || host);
}

function resolve(
	entry: SourceEntry,
	tier: SourceDefinition["sourceTier"],
): SourceDefinition {
	const id = entry.id ?? deriveId(entry);
	if (!entry.listingUrls?.length) {
		throw new Error(
			`Source "${entry.name}" is method: scraper but has no listingUrls. Give it a verified listing page, or set method: llm.`,
		);
	}
	return {
		id,
		name: entry.name,
		homepage: entry.homepage ?? null,
		listingUrls: entry.listingUrls,
		domains: entry.domains ?? [],
		venue: {
			name: entry.venue?.name ?? entry.name,
			address: entry.venue?.address ?? null,
			suburb: entry.venue?.suburb ?? null,
		},
		strategy: entry.strategy ?? "html",
		sourceTier: tier,
		...(entry.note ? { note: entry.note } : {}),
	};
}

/** Every scraper-backed source for a city, resolved and validated. */
export function loadSourceRegistry(cityKey: string): SourceDefinition[] {
	const sources = scraperSources(loadCityConfig(cityKey)).map(
		({ entry, tier }) => resolve(entry, tier),
	);
	// Duplicate ids are a data problem in the source list (the same venue
	// listed twice, sometimes with a typo'd domain), not something worth
	// failing the whole scrape over — the output filename just needs to be
	// unique. dedupe.ts collapses the resulting duplicate events downstream.
	const seen = new Map<string, number>();
	for (const s of sources) {
		const n = seen.get(s.id) ?? 0;
		seen.set(s.id, n + 1);
		if (n > 0) s.id = `${s.id}-${n + 1}`;
	}
	return sources;
}
