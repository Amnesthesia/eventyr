import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	DATA_ROOT,
	fmtDate,
	getWeekRange,
	loadCityConfig,
	PROJECT_ROOT,
	requireEnv,
	toISODate,
} from "./common.ts";

const CITY = requireEnv("CITY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);
const cityCfg = loadCityConfig(CITY);
const CITY_NAME = cityCfg.name;

function alreadyCuratedThisWeek(monday: Date): boolean {
	const jsonPath = join(DATA_ROOT, `${CITY}.json`);
	if (!existsSync(jsonPath)) return false;
	try {
		const payload = JSON.parse(readFileSync(jsonPath, "utf-8"));
		return payload.week_start === toISODate(monday);
	} catch {
		return false;
	}
}

function fingerprint(event: Record<string, unknown>): string {
	const title = ((event.title as string) ?? "").toLowerCase().trim();
	const dt = (
		(event.datetime_iso as string) ??
		(event.datetime as string) ??
		""
	).slice(0, 10);
	return dt ? `${title} | ${dt}` : title;
}

function diceSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const getBigrams = (s: string): Map<string, number> => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const bg = s.slice(i, i + 2);
			m.set(bg, (m.get(bg) ?? 0) + 1);
		}
		return m;
	};
	const aMap = getBigrams(a);
	const bMap = getBigrams(b);
	let inter = 0;
	for (const [bg, count] of aMap) {
		inter += Math.min(count, bMap.get(bg) ?? 0);
	}
	return (2 * inter) / (a.length + b.length - 2);
}

function findJsonFiles(baseDir: string, subPath: string): string[] {
	if (!existsSync(baseDir)) return [];
	const results: string[] = [];
	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(baseDir, entry.name, subPath);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".json")) results.push(join(dir, file));
		}
	}
	return results.sort();
}

const TIER_TO_VENUE: Record<string, string> = {
	aggregators: "aggregator",
	institutions: "institution",
	independents: "independent",
	open: "aggregator",
};

function mergeAndDeduplicate(monday: Date): Record<string, unknown>[] {
	const cityDir = join(DATA_ROOT, CITY);
	const allEvents: Record<string, unknown>[] = [];

	for (const file of findJsonFiles(cityDir, "curated")) {
		try {
			const payload = JSON.parse(readFileSync(file, "utf-8")) as Record<
				string,
				unknown
			>;
			if (payload.week_start === toISODate(monday)) {
				const venue =
					TIER_TO_VENUE[(payload.tier as string) ?? ""] ?? "aggregator";
				const events = (payload.events as Record<string, unknown>[]) ?? [];
				allEvents.push(...events.map((e) => ({ ...e, venue })));
			}
		} catch {
			// skip malformed file
		}
	}

	const seen: string[] = [];
	const unique: Record<string, unknown>[] = [];
	for (const event of allEvents) {
		const fp = fingerprint(event);
		if (!seen.some((s) => diceSimilarity(fp, s) > 0.85)) {
			unique.push(event);
			seen.push(fp);
		}
	}
	return unique;
}

function writeJson(
	events: Record<string, unknown>[],
	monday: Date,
	sunday: Date,
): string {
	const payload = {
		city: CITY_NAME,
		city_key: CITY,
		week_start: toISODate(monday),
		week_end: toISODate(sunday),
		generated_at: toISODate(new Date()),
		events,
	};
	const outPath = join(DATA_ROOT, `${CITY}.json`);
	writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
	console.log(
		`→ Written ${relative(PROJECT_ROOT, outPath)} (${events.length} events)`,
	);
	return outPath;
}

async function main(): Promise<void> {
	const { monday, sunday } = getWeekRange();

	if (!FORCE && alreadyCuratedThisWeek(monday)) {
		console.log(
			"→ Already curated for this week — skipping. Set FORCE=true to re-curate.",
		);
		return;
	}

	console.log(
		`Curation — ${CITY_NAME} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);
	console.log("=".repeat(50));

	console.log("→ Merging and deduplicating…");
	const events = mergeAndDeduplicate(monday);

	if (events.length === 0) {
		throw new Error(
			"✗ No events found. Run collection.ts for each tier first.",
		);
	}

	console.log(`→ ${events.length} events total`);
	writeJson(events, monday, sunday);
	console.log("✓ Curation complete.");
}

await main();
