import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(from: string): string {
	for (let dir = from; ; dir = dirname(dir)) {
		if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
		if (dirname(dir) === dir)
			throw new Error(`pnpm-workspace.yaml not found above ${from}`);
	}
}

export const PROJECT_ROOT =
	process.env.EVENTYR_REPO_ROOT ??
	findRepoRoot(dirname(fileURLToPath(import.meta.url)));
export const DATA_ROOT =
	process.env.EVENTYR_DATA_ROOT ?? join(PROJECT_ROOT, "data");
export const SOURCES_ROOT =
	process.env.EVENTYR_SOURCES_ROOT ?? join(PROJECT_ROOT, "sources");
export const WEB_PUBLIC_DIR = resolve(PROJECT_ROOT, "apps", "web", "public");

export function curatedPath(
	city: string,
	provider: string,
	tier: string,
): string {
	return join(DATA_ROOT, city, provider, "curated", `${tier}.json`);
}

export function yieldLedgerPath(city: string): string {
	return join(DATA_ROOT, city, "source-yield.json");
}

export function barrenSourcesPath(city: string): string {
	return join(DATA_ROOT, city, "adapters", "barren.json");
}

export function adapterRawDir(sourceId: string): string {
	return join(DATA_ROOT, "_raw", sourceId);
}

export function adapterCachePath(sourceId: string): string {
	return join(DATA_ROOT, "_cache", `${sourceId}.json`);
}
