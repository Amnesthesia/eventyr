// Build-time organizer lookup for the Astro pages.
//
// Deliberately not common.ts: its PROJECT_ROOT comes from import.meta.url,
// which inside Astro's prerender bundle points at dist/.prerender/, so
// loadCityConfig there looks for sources/ in the wrong place. The pages already
// resolve data/ from process.cwd(); sources/ is resolved the same way. Cached
// per city because every event page asks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { type OrganizerSource, organizerUrls } from "./shared.ts";

const cache = new Map<string, Map<string, string>>();

export function organizerUrlsFor(cityKey: string): Map<string, string> {
	const hit = cache.get(cityKey);
	if (hit) return hit;
	const cfg = yaml.load(
		readFileSync(join(process.cwd(), "sources", `${cityKey}.yml`), "utf-8"),
	) as { sources?: Partial<Record<string, OrganizerSource[]>> };
	const out = organizerUrls(cfg.sources);
	cache.set(cityKey, out);
	return out;
}
