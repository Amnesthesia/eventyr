import { readFileSync } from "node:fs";
import { join } from "node:path";
import { organizerUrls } from "@dothingslol/core/shared";
import { CityConfigSchema } from "@dothingslol/core/sources";
import yaml from "js-yaml";
import { SOURCES_ROOT } from "./paths.ts";

const cache = new Map<string, Map<string, string>>();

export function organizerUrlsFor(cityKey: string): Map<string, string> {
	const hit = cache.get(cityKey);
	if (hit) return hit;
	const raw = yaml.load(
		readFileSync(join(SOURCES_ROOT, `${cityKey}.yml`), "utf-8"),
	);
	const cfg = CityConfigSchema.parse(raw);
	const out = organizerUrls(cfg.sources);
	cache.set(cityKey, out);
	return out;
}
