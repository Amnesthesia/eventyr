// Build-time only. Resolved from cwd, not import.meta.url: Astro's prerender bundle relocates
// modules under dist/, so import.meta.url no longer points at the source tree (the reason
// organizers.ts already used cwd). pnpm runs package scripts with cwd = apps/web.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
export const REPO_ROOT =
	process.env.EVENTYR_REPO_ROOT ?? resolve(process.cwd(), "../..");
export const DATA_ROOT =
	process.env.EVENTYR_DATA_ROOT ?? resolve(REPO_ROOT, "data");
export const SOURCES_ROOT = resolve(REPO_ROOT, "sources");
if (!existsSync(resolve(DATA_ROOT, "index.json"))) {
	throw new Error(
		`data/index.json not found under ${DATA_ROOT}; run from apps/web or set EVENTYR_REPO_ROOT`,
	);
}
