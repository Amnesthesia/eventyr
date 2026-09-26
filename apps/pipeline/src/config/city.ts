import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSameSite, normaliseHost, toISODate } from "@dothingslol/core/shared";
import yaml from "js-yaml";
import { sourceEarnsPlace, type YieldLedger } from "../sourceYield.js";
import { barrenSourcesPath, SOURCES_ROOT, yieldLedgerPath } from "./paths.js";
import { getWeekRange } from "./week.js";

export const SOURCE_TIERS = [
	"aggregators",
	"institutions",
	"independents",
] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export interface SourceEntry {
	name: string;
	method: "llm" | "scraper";
	domains?: string[];
	pin?: boolean;
	id?: string;
	homepage?: string;
	listingUrls?: string[];
	strategy?: "jsonld" | "html" | "render";
	venue?: {
		name?: string | null;
		address?: string | null;
		suburb?: string | null;
		aliases?: string[];
	};
	note?: string;
}

export interface CityConfig {
	name: string;
	timezone: string;
	centre?: { lat: number; lng: number; radiusKm: number };
	locale?: string;
	currency?: string;
	sources: Record<SourceTier, SourceEntry[]>;
}

export function isValidTimeZone(timeZone: string): boolean {
	if (/^[+-]\d/.test(timeZone)) return false;
	try {
		new Intl.DateTimeFormat(undefined, { timeZone });
		return true;
	} catch {
		return false;
	}
}

export function loadCityConfig(cityKey: string): CityConfig {
	const sourcesPath = join(SOURCES_ROOT, `${cityKey}.yml`);
	let raw: string;
	try {
		raw = readFileSync(sourcesPath, "utf-8");
	} catch {
		throw new Error(
			`Unknown city '${cityKey}'. No file at ${sourcesPath}. Run src/add_city.ts to add it.`,
		);
	}
	const cfg = yaml.load(raw) as CityConfig;
	if (typeof cfg?.timezone !== "string" || !isValidTimeZone(cfg.timezone)) {
		throw new Error(
			`${sourcesPath}: timezone ${JSON.stringify(cfg?.timezone)} is not a valid IANA zone. Add e.g. "timezone: Australia/Sydney".`,
		);
	}
	for (const tier of SOURCE_TIERS) {
		for (const entry of cfg.sources?.[tier] ?? []) {
			if (entry.method !== "llm" && entry.method !== "scraper") {
				throw new Error(
					`${sourcesPath}: source "${entry.name}" has invalid method ${JSON.stringify(entry.method)} (expected "llm" or "scraper")`,
				);
			}
		}
	}
	return cfg;
}

export function loadYieldLedger(city: string): YieldLedger | null {
	try {
		const ledger = JSON.parse(
			readFileSync(yieldLedgerPath(city), "utf-8"),
		) as YieldLedger;
		if (!Array.isArray(ledger.weeks) || !ledger.sources) return null;
		return ledger;
	} catch {
		return null;
	}
}

function barrenSourceNames(
	city: string,
	weekStart: string,
): Set<string> | null {
	try {
		const report = JSON.parse(
			readFileSync(barrenSourcesPath(city), "utf-8"),
		) as { week_start?: string; names?: string[] };
		if (report.week_start !== weekStart) return null;
		return new Set(report.names ?? []);
	} catch {
		return null;
	}
}

export interface LlmSourceName {
	text: string;
	pinned: boolean;
}

export function scraperSources(
	cfg: CityConfig,
): { entry: SourceEntry; tier: SourceTier }[] {
	const out: { entry: SourceEntry; tier: SourceTier }[] = [];
	for (const tier of SOURCE_TIERS) {
		for (const entry of cfg.sources?.[tier] ?? []) {
			if (entry.method === "scraper") out.push({ entry, tier });
		}
	}
	return out;
}

export function llmSourceStrings(
	cfg: CityConfig,
	tier: string,
	cityKey?: string,
): LlmSourceName[] {
	const entries = cfg.sources?.[tier as SourceTier] ?? [];
	const barren = cityKey
		? barrenSourceNames(
				cityKey,
				toISODate(getWeekRange(new Date(), cfg.timezone).monday, cfg.timezone),
			)
		: new Set<string>();
	const ledger = cityKey ? loadYieldLedger(cityKey) : null;

	const covered = scraperSources(cfg)
		.filter(({ entry }) => !(barren === null || barren.has(entry.name)))
		.flatMap(({ entry }) => [
			entry.name,
			...(entry.domains ?? []).map((d) => normaliseHost(d) ?? ""),
		])
		.filter(Boolean);
	const alreadyScraped = (e: SourceEntry): boolean =>
		covered.some(
			(c) =>
				c === e.name ||
				(e.domains ?? []).some((d) => {
					const host = normaliseHost(d);
					return host ? isSameSite(host, c) : false;
				}),
		);

	return entries
		.filter((e) =>
			e.method === "llm"
				? (e.pin || sourceEarnsPlace(e, ledger)) && !alreadyScraped(e)
				: barren === null || barren.has(e.name),
		)
		.map((e) => ({
			text: e.domains?.[0] ? `${e.name} (${e.domains[0]})` : e.name,
			pinned: e.method === "llm" && !!e.pin,
		}));
}

export function allSourceEntries(cfg: CityConfig): SourceEntry[] {
	const out: SourceEntry[] = [];
	for (const tier of SOURCE_TIERS) out.push(...(cfg.sources?.[tier] ?? []));
	return out;
}
