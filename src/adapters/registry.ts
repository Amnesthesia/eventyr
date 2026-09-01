// Resolves the scraper-backed entries of a city's unified source file
// (sources/{city}.yml) into fully-populated SourceDefinitions the adapter
// framework can run. Validation lives here rather than in the adapters
// themselves so a malformed entry fails loudly at load time instead of
// producing a half-formed payload three steps downstream.

import { loadCityConfig, scraperSources, type SourceEntry } from "../common.ts";
import type { SourceDefinition } from "./types.ts";

function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) || "source"
	);
}

function resolve(entry: SourceEntry, tier: SourceDefinition["sourceTier"]): SourceDefinition {
	const id = entry.id ?? slugify(entry.name);
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
			lat: entry.venue?.lat ?? null,
			lng: entry.venue?.lng ?? null,
			aliases: entry.venue?.aliases ?? [],
		},
		strategy: entry.strategy ?? "html",
		sourceTier: tier,
		schedule: entry.schedule ?? "weekly",
		...(entry.note ? { note: entry.note } : {}),
	};
}

/** Every scraper-backed source for a city, resolved and validated. */
export function loadSourceRegistry(cityKey: string): SourceDefinition[] {
	const sources = scraperSources(loadCityConfig(cityKey)).map(({ entry, tier }) =>
		resolve(entry, tier),
	);
	const seen = new Set<string>();
	for (const s of sources) {
		if (seen.has(s.id)) {
			throw new Error(`Duplicate scraper source id "${s.id}" in sources/${cityKey}.yml`);
		}
		seen.add(s.id);
	}
	return sources;
}

export function findSourceById(
	sources: SourceDefinition[],
	id: string,
): SourceDefinition | undefined {
	return sources.find((s) => s.id === id);
}
