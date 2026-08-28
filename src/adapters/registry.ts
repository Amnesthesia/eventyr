import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { SOURCES_ROOT } from "../common.ts";
import type { SourceDefinition } from "./types.ts";

interface RegistryFile {
	sources: SourceDefinition[];
}

/**
 * Loads the declarative source registry for a city, e.g.
 * sources/brisbane.adapters.yml. Mirrors loadCityConfig's shape/error style.
 */
export function loadSourceRegistry(cityKey: string): SourceDefinition[] {
	const path = `${SOURCES_ROOT}/${cityKey}.adapters.yml`;
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		throw new Error(`No adapter source registry at ${path}.`);
	}
	const parsed = yaml.load(raw) as RegistryFile;
	return parsed.sources ?? [];
}

export function enabledSources(
	sources: SourceDefinition[],
): SourceDefinition[] {
	return sources.filter((s) => s.enabled);
}

export function findSourceById(
	sources: SourceDefinition[],
	id: string,
): SourceDefinition | undefined {
	return sources.find((s) => s.id === id);
}
