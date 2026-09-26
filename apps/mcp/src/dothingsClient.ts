// Read-through layer over the already-public /ai/*.json static files. No
// KV/R2 sync, no coupling to the digest pipeline's deploy — this Worker is a
// pure shaping layer over data the site already publishes, cached at the
// Cloudflare edge since the underlying data changes at most once a day.

import type {
	AiIndex,
	CityIndexEntry,
	CompactEvent,
	DayFile,
	WeekFile,
} from "@dothingslol/core/aiFeed";
import { SITE_URL } from "@dothingslol/core/shared";

// The compact JSON shape (CompactEvent/DayFile/WeekFile/CityIndexEntry/
// AiIndex) is shared with the producer, apps/pipeline/src/publish/ai.ts —
// see @dothingslol/core/aiFeed (1.12). Re-exported so this stays the one
// import site for this Worker's other modules.
export type { AiIndex, CityIndexEntry, CompactEvent, DayFile, WeekFile };

const CACHE_TTL_SECONDS = 900;

async function fetchJson<T>(path: string): Promise<T> {
	const res = await fetch(`${SITE_URL}${path}`, {
		cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
	});
	if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
	return res.json() as Promise<T>;
}

export function fetchIndex(): Promise<AiIndex> {
	return fetchJson<AiIndex>("/ai/index.json");
}

export function fetchFile<T extends DayFile | WeekFile>(path: string) {
	return fetchJson<T>(path);
}

export function dayFileUrl(entry: CityIndexEntry, date: string): string {
	return `/ai/${entry.slug}/${date}.json`;
}

export function findCity(
	index: AiIndex,
	cityInput: string,
): CityIndexEntry | undefined {
	const needle = cityInput.trim().toLowerCase();
	return index.cities.find(
		(c) =>
			c.city_key.toLowerCase() === needle ||
			c.slug.toLowerCase() === needle ||
			c.city.toLowerCase() === needle,
	);
}

/** The city's own local calendar date — never the Worker's UTC clock, same
 * bug class getWeekRange() in the pipeline already guards against. */
export function cityTodayFor(timezone: string): string {
	return new Date().toLocaleDateString("sv", { timeZone: timezone });
}

/** Bare YYYY-MM-DD dates the index actually lists day files for, extracted
 * from their paths rather than assumed from a today..week_end formula — the
 * published list is the source of truth, not a range this Worker invents. */
export function availableDatesFor(entry: CityIndexEntry): string[] {
	const dates: string[] = [];
	for (const path of entry.days) {
		const match = path.match(/(\d{4}-\d{2}-\d{2})\.json$/);
		if (match) dates.push(match[1]);
	}
	return dates;
}

/** The week (or week+category split) file to fetch — the smallest file that
 * answers the question, per llms.txt's own fetch-order guidance. */
export function weekFileUrl(
	entry: CityIndexEntry,
	category?: string,
): string | null {
	if (category) {
		const match = entry.week_categories.find((c) => c.category === category);
		if (match) return match.file;
	}
	return entry.week;
}
