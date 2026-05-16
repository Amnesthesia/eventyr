import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	CATEGORIES,
	DATA_ROOT,
	fmtDate,
	getWeekRange,
	INTERESTS,
	loadCityConfig,
	PROJECT_ROOT,
	requireEnv,
	toISODate,
} from "./common.ts";
import { GoogleProvider } from "./providers/google.ts";

const CITY = requireEnv("CITY");
const GOOGLE_API_KEY = requireEnv("GOOGLE_API_KEY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);
const cityCfg = loadCityConfig(CITY);
const CITY_NAME = cityCfg.name;

const FORMAT_SYSTEM = `You are a personal events curator for someone in ${CITY_NAME} with these interests:
${INTERESTS}

The user will give you raw event listings from a single search source.

Your job:
1. FILTER: Remove any sports, MLM, sales-pitch, or clearly irrelevant events.
2. CURATE: For each remaining event, produce the following fields:
   - title:       event name (string)
   - datetime:    date and time as a short string, e.g. "Sat 14 Jun, 7:00 PM"
   - location:    venue name and/or suburb (string)
   - link:        direct URL to the event page (string; use "" if unknown)
   - category:    exactly one of ${JSON.stringify(CATEGORIES)}
   - cost:        "Free" or the price, e.g. "$25" (string)
   - source:      website or organisation name (string)
   - description: 1–2 sentences describing what the event actually is — what happens,
                  who runs it, what to expect. Be specific, not generic.
   - tags:        3–4 short lowercase topic tags reflecting subject matter, format, and cost,
                  e.g. ["philosophy", "lecture", "free"] or ["art", "workshop", "beginners"]
   - social:      true if the event has significant group/social interaction (meetups, socials, networking, group classes)
   - intellectual: true if the event is primarily idea- or knowledge-focused (lectures, talks, debates, book clubs, trivia)
   - hands_on:    true if participants actively make, build, or do something (workshops, craft, coding, cooking)
   - creative:    true if the event involves artistic or creative expression (art, music, writing, performance, improv)
   - datetime_iso: ISO 8601 start datetime, e.g. "2026-06-14T19:00:00". Use the event's
                  actual date and time. Date-only "YYYY-MM-DD" if no time is known.
                  Use "" if completely unknown.
   - datetime_end_iso: ISO 8601 end datetime, e.g. "2026-06-14T21:00:00". Use the event's
                  actual end date and time. Date-only "YYYY-MM-DD" if no time is known.
                  Use "" if completely unknown.
   - image:       direct URL to a preview/hero image for the event. Use "" if none available. Must be a full https:// URL.

3. OUTPUT: A valid JSON array. Include EVERY event that passes the filter — do not stop early or truncate the list. No markdown, no explanation, no code fences.

Example element:
{
  "title": "Philosophy of Mind: AI and Consciousness",
  "datetime": "Mon 12 May, 7:00 PM",
  "location": "UQ St Lucia, Building 9",
  "link": "https://events.uq.edu.au/...",
  "category": "Public Lecture",
  "cost": "Free",
  "source": "UQ Events",
  "description": "UQ's Professor of Philosophy presents her latest research on consciousness and what AI can and cannot tell us about subjective experience — aimed at a general audience, followed by open Q&A.",
  "tags": ["philosophy", "ai", "lecture", "free"],
  "social": false,
  "intellectual": true,
  "hands_on": false,
  "creative": false,
  "datetime_iso": "2026-05-12T19:00:00",
  "datetime_end_iso": "2026-05-12T21:00:00",
  "image": "https://events.uq.edu.au/images/philosophy-lecture.jpg"
}`;

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

function parseEvents(
	rawText: string,
	label: string,
): Record<string, unknown>[] {
	const cleaned = rawText.replace(/```json|```/g, "").trim();
	const start = cleaned.indexOf("[");
	if (start === -1) {
		console.log(`  ✗ [${label}] No JSON array found in curator response`);
		return [];
	}

	let jsonStr = cleaned.slice(start);
	const end = jsonStr.lastIndexOf("]");
	if (end !== -1) jsonStr = jsonStr.slice(0, end + 1);

	try {
		return JSON.parse(jsonStr) as Record<string, unknown>[];
	} catch {
		const lastComplete = jsonStr.lastIndexOf("},");
		if (lastComplete === -1) {
			console.log(`  ✗ [${label}] JSONDecodeError and no recovery point found`);
			return [];
		}
		const recovered = `${jsonStr.slice(0, lastComplete + 1)}]`;
		try {
			const events = JSON.parse(recovered) as Record<string, unknown>[];
			console.log(
				`  ⚠ [${label}] Recovered ${events.length} events from truncated response`,
			);
			return events;
		} catch {
			console.log(`  ✗ [${label}] Could not recover from truncated JSON`);
			return [];
		}
	}
}

async function curateSingleFile(
	rawFile: string,
	google: GoogleProvider,
): Promise<string | null> {
	const payload = JSON.parse(readFileSync(rawFile, "utf-8")) as Record<
		string,
		string
	>;
	const rawText = payload.raw_text ?? "";
	const weekStartStr = payload.week_start ?? "";
	const weekEndStr = payload.week_end ?? "";

	// rawFile path: data/{city}/{provider}/raw/{tier}.json
	const parts = rawFile.split("/");
	const tier = parts[parts.length - 1].replace(".json", "");
	const provider = parts[parts.length - 3];
	const label = `${provider}/${tier}`;

	const outPath = join(DATA_ROOT, CITY, provider, "curated", `${tier}.json`);
	const rawHash = createHash("sha256").update(rawText).digest("hex");

	if (!FORCE && existsSync(outPath)) {
		try {
			const existing = JSON.parse(readFileSync(outPath, "utf-8"));
			if (existing.raw_sha256 === rawHash) {
				console.log(`  → [${label}] Raw unchanged — skipping`);
				return outPath;
			}
		} catch {
			// proceed with curation
		}
	}

	if (/\bNO_EVENTS_FOUND\b/.test(rawText)) {
		console.log(`  ⚠ [${label}] Skipping — provider reported no events`);
		return null;
	}
	if (rawText.length < 200) {
		console.log(
			`  ⚠ [${label}] Skipping — too short (${rawText.length} chars)`,
		);
		return null;
	}

	console.log(`→ Curating [${label}]…`);
	const curatedRaw = await google.curateEvents(rawText, FORMAT_SYSTEM);
	const events = parseEvents(curatedRaw, label);
	console.log(`  → [${label}] ${events.length} events curated`);

	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				city_key: CITY,
				provider,
				tier,
				week_start: weekStartStr,
				week_end: weekEndStr,
				raw_sha256: rawHash,
				events,
			},
			null,
			2,
		),
		"utf-8",
	);
	console.log(`  → Written ${relative(PROJECT_ROOT, outPath)}`);
	return outPath;
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

	const cityDir = join(DATA_ROOT, CITY);
	const rawFiles = findJsonFiles(cityDir, "raw");

	if (rawFiles.length === 0) {
		throw new Error(
			"✗ No raw files found. Run collection.ts for each tier first.",
		);
	}

	const google = new GoogleProvider(GOOGLE_API_KEY);
	await Promise.all(rawFiles.map((f) => curateSingleFile(f, google)));

	console.log("→ Merging and deduplicating…");
	const events = mergeAndDeduplicate(monday);

	if (events.length === 0) {
		throw new Error("✗ No events found after merging curated files.");
	}

	console.log(`→ ${events.length} events total`);

	writeJson(events, monday, sunday);
	console.log("✓ Curation complete.");
}

await main();
