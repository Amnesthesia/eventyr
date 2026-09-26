import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSameSite, normaliseHost, toISODate } from "@dothingslol/core/shared";
import type {
	CityConfig,
	SourceEntry,
	SourceTier,
} from "@dothingslol/core/sources";
import { CityConfigSchema } from "@dothingslol/core/sources";
import yaml from "js-yaml";
import { loadPipelineConfig } from "./load.js";
import { barrenSourcesPath, SOURCES_ROOT, yieldLedgerPath } from "./paths.js";
import { getWeekRange } from "./week.js";

export type { CityConfig, SourceEntry, SourceTier };
export const SOURCE_TIERS = [
	"aggregators",
	"institutions",
	"independents",
] as const;

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
	const parsed = yaml.load(raw);
	const cfg = CityConfigSchema.parse(parsed);
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

/**
 * One week's search-yield ledger: which llm sources have recently produced
 * events, so llmSourceStrings can stop naming ones that never do.
 */
export interface YieldLedger {
	/** Weeks recorded, ascending. */
	weeks: string[];
	/** Keyed by the source's primary host. */
	sources: Record<string, { weeksHit: string[] }>;
	/** Link hosts the search returned that match no source at all. */
	unlisted: Record<string, { count: number; lastWeek: string }>;
}

/**
 * The date discover-sources stamped into `note`, if this entry came from it.
 *
 * Matches only that specific stamp — not any date in `note` — because
 * probe-sources also writes dated notes onto a source it *demotes* back to
 * llm ("Demoted by probe-sources 2026-09-02: ..."), and 338 of Brisbane's 385
 * llm sources carry one of those. A demotion is not a new addition; reading
 * its date as one gave nearly every source an undeserved grace period and
 * made the ledger prune almost nothing.
 */
export function addedOn(entry: SourceEntry): Date | null {
	const m = /^Suggested by discover-sources (\d{4}-\d{2}-\d{2})/.exec(
		entry.note ?? "",
	);
	if (!m) return null;
	const d = new Date(`${m[1]}T00:00:00Z`);
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whether an llm source should be named in the search prompt.
 *
 * No ledger, or too little history ⇒ yes for everyone (today's behaviour).
 * Otherwise: hit within the last loadPipelineConfig().stages.collect.sourceYield.hitWindowWeeks
 * recorded weeks, or added within loadPipelineConfig().stages.collect.sourceYield.graceDays.
 *
 * Lives here (config), not sourceYield.ts (stages), because loadCityConfig's
 * llmSourceStrings needs it and config may not import stages — sourceYield.ts
 * imports this back instead. Pure: no IO.
 */
export function sourceEarnsPlace(
	entry: SourceEntry,
	ledger: YieldLedger | null,
	today: Date = new Date(),
): boolean {
	if (
		!ledger ||
		ledger.weeks.length <
			loadPipelineConfig().stages.collect.sourceYield.minHistoryWeeks
	)
		return true;
	const added = addedOn(entry);
	if (
		added &&
		today.getTime() - added.getTime() <
			loadPipelineConfig().stages.collect.sourceYield.graceDays * 86_400_000
	) {
		return true;
	}
	const key = normaliseHost(entry.domains?.[0]);
	if (!key) return false;
	const recent = new Set(
		ledger.weeks.slice(
			-loadPipelineConfig().stages.collect.sourceYield.hitWindowWeeks,
		),
	);
	return (ledger.sources[key]?.weeksHit ?? []).some((w) => recent.has(w));
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
