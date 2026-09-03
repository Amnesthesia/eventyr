// Asks Gemini for venues and organisations the city's source list is missing,
// and adds them as method: llm for probe-sources to verify.
//
// Google only, deliberately. Claude and GPT were both tried here: Claude
// wrapped its JSON in prose and GPT-5 returned `incomplete` with empty output,
// and neither added anything Google's grounded answer had missed.
//
// Nothing here is trusted. A suggestion only becomes a scraper source once
// probe-sources fetches its listing page and gets dated events out of it, so a
// bad suggestion costs one wasted fetch and a line in the YAML.
//
// Token budget — the goal is the longest list per dollar, so:
//
//   * One call per niche, not one per city. A single "list this city's event
//     sources" question returns a couple of dozen obvious answers and stops.
//     Twelve narrow questions reach the long tail a broad one never gets to —
//     Big Fork Theatre is an improv house, and the broad sweep missed it.
//     Narrow questions are also more accurate per answer.
//   * `Name|domain` lines, not JSON objects. The JSON scaffolding around each
//     record roughly doubles output tokens, and output is what limits how long
//     a list comes back.
//   * The tier is inferred from the niche we asked about, so the model never
//     spends tokens on a field we already know.
//   * The exclusion list is hosts only (~3.8 KB for Brisbane vs ~5 KB of
//     names) and goes FIRST, byte-identical across every niche call for a
//     city, so provider prefix caching pays for it once rather than twelve
//     times. Only the trailing two lines vary.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import yaml from "js-yaml";
import {
	loadCityConfig,
	SOURCE_TIERS,
	SOURCES_ROOT,
	type SourceEntry,
	type SourceTier,
} from "../common.ts";
import { mapWithConcurrency } from "../providers/base.ts";
import { geminiText, installUsageReporting } from "../providers/gemini.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
	args
		.find((a) => a.startsWith(`--${name}=`))
		?.split("=")
		.slice(1)
		.join("=");
const CITIES = flag("city")?.split(",") ?? [
	"brisbane",
	"goldcoast",
	"sunnycoast",
];
const APPLY = args.includes("--apply");

const MODEL = "gemini-3.5-flash";
/** Niche calls in flight per city. */
const CONCURRENCY = 4;
/** Separates the list the model is given from the part it must add. */
const CONTINUE_DELIMITER = "-----";

const CITY_NAMES: Record<string, string> = {
	brisbane: "Brisbane",
	goldcoast: "the Gold Coast",
	sunnycoast: "the Sunshine Coast",
};

/**
 * The niches to sweep. Each is one grounded call, and its tier is applied to
 * whatever comes back — so the model is never asked to classify.
 *
 * Deliberately narrow and slightly overlapping: asking about "theatres" does
 * not surface an improv room, and asking about "live music" does not surface a
 * board-game cafe.
 */
const NICHES: { tier: SourceTier; label: string }[] = [
	{ tier: "institutions", label: "public galleries, museums and art spaces" },
	{
		tier: "institutions",
		label: "libraries, universities and council venues with public programmes",
	},
	{
		tier: "institutions",
		label: "theatres, orchestras, opera, ballet and dance companies",
	},
	{
		tier: "institutions",
		label:
			"botanic gardens, observatories, planetariums, historical societies and science centres",
	},
	{
		tier: "independents",
		label: "comedy clubs, improv theatres, stand-up rooms and cabaret venues",
	},
	{
		tier: "independents",
		label: "live music venues, including pubs, clubs and bars with a gig guide",
	},
	{
		tier: "independents",
		label:
			"artist-run and commercial galleries, studios and life-drawing spaces",
	},
	{
		tier: "independents",
		label: "makerspaces, hackerspaces, repair cafes and craft workshop studios",
	},
	{
		tier: "independents",
		label: "bookshops and writers' groups that host author talks or book clubs",
	},
	{
		tier: "independents",
		label:
			"board-game cafes, trivia nights, language exchanges and social meetup clubs",
	},
	{
		tier: "independents",
		label: "independent cinemas, film societies and screening rooms",
	},
	{
		tier: "independents",
		label: "night markets, food markets, street festivals and community fairs",
	},
];

const SYSTEM_PROMPT = `You are completing a partial list of real, currently-operating organisations in an Australian city that publish their own upcoming events on their own website.

You are given the list so far, then a line of dashes. Continue the list below the dashes with organisations that are NOT already in it, in exactly the same format.

Format, exactly as in the list above:
- One organisation per line: Name|domain
- domain is the organisation's own registered domain: lowercase, no scheme, no path, no www.
- No numbering, no markdown, no headings, no commentary, no blank lines, and do not repeat the dashes.

Rules:
- Only organisations whose OWN website lists their events.
- Never a ticketing platform (Eventbrite, Humanitix, Moshtix, Oztix, Ticketmaster, TryBooking), never social media, never a directory or listicle site.
- Never invent a domain. If you are not confident of the real domain, omit that organisation entirely.
- Never repeat an entry from the list above.
- Prefer breadth over fame: small, independent and long-tail venues are the point, not the obvious ones. Continue for as many as you genuinely know, up to 40.`;

interface Suggestion {
	name: string;
	host: string;
	tier: SourceTier;
}

function normaliseHost(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const host = raw
		.trim()
		.replace(/^https?:\/\//, "")
		.split("/")[0]
		.toLowerCase()
		.replace(/^www\./, "");
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
	if (
		/eventbrite|humanitix|moshtix|oztix|ticketmaster|facebook|instagram|meetup|eventfinda|allevents|trybooking|tripadvisor/i.test(
			host,
		)
	) {
		return null;
	}
	return host;
}

/** `Name|domain` lines in, suggestions out. A malformed line is skipped rather
 * than failing the niche. */
export function parseSuggestionLines(
	text: string,
	tier: SourceTier,
): Suggestion[] {
	const out: Suggestion[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.includes("|") || /^-{3,}$/.test(trimmed)) continue;
		const [rawName, rawHost] = trimmed.split("|");
		const host = normaliseHost(rawHost);
		// Strip any list marker the model added despite being told not to.
		const name = rawName?.replace(/^[-*\d.)\s]+/, "").trim();
		if (!host || !name) continue;
		out.push({ name: name.slice(0, 90), host, tier });
	}
	return out;
}

async function askNiche(
	cityName: string,
	listSoFar: string,
	niche: { tier: SourceTier; label: string },
	ai: GoogleGenAI,
): Promise<Suggestion[]> {
	// excludeBlock first, and identical across every niche call for this city,
	// so it lands in the cacheable prefix; only the last two lines vary.
	// Order matters for two separate reasons that pull in opposite directions,
	// and this satisfies both: the shared list goes FIRST so it is a prefix
	// identical across all twelve niche calls for this city and can be cached,
	// while the delimiter stays LAST so the model is completing the list rather
	// than answering a question. The varying city/category lines sit between
	// them, after the cacheable part.
	const contents = `${listSoFar}\nCity: ${cityName}\nCategory: ${niche.label}\n${CONTINUE_DELIMITER}`;
	// Retries and rate-limit backoff live in the shared wrapper now, so a 429
	// no longer costs a whole city its discovery run.
	try {
		const text = await geminiText(ai, {
			stage: "discover",
			model: MODEL,
			contents,
			systemInstruction: SYSTEM_PROMPT,
			search: true,
			maxOutputTokens: 4000,
		});
		return parseSuggestionLines(text, niche.tier);
	} catch (err) {
		console.error(`  ⚠ ${niche.label}: ${(err as Error).message.slice(0, 90)}`);
		return [];
	}
}

async function discoverCity(city: string, ai: GoogleGenAI): Promise<void> {
	const cfg = loadCityConfig(city);
	const existing = new Set<string>();
	const knownEntries: { name: string; host: string }[] = [];
	for (const tier of SOURCE_TIERS) {
		for (const entry of cfg.sources[tier] ?? []) {
			for (const d of entry.domains ?? []) {
				const h = normaliseHost(d);
				if (!h || existing.has(h)) continue;
				existing.add(h);
				knownEntries.push({ name: entry.name, host: h });
			}
		}
	}
	// Framed as a continuation rather than an exclusion list: the model is
	// completing a list it can see the shape of, which both suppresses repeats
	// and doubles as the format example, so the prompt needs no separate
	// demonstration. Names are included (not just hosts) because they are what
	// makes the pattern legible to continue.
	const listSoFar = knownEntries.map((e) => `${e.name}|${e.host}`).join("\n");
	const cityName = CITY_NAMES[city] ?? city;

	const perNiche = await mapWithConcurrency(NICHES, CONCURRENCY, (niche) =>
		askNiche(cityName, listSoFar, niche, ai),
	);

	const merged = new Map<string, Suggestion>();
	let suggested = 0;
	NICHES.forEach((niche, i) => {
		const found = perNiche[i] ?? [];
		suggested += found.length;
		let added = 0;
		for (const s of found) {
			if (existing.has(s.host) || merged.has(s.host)) continue;
			merged.set(s.host, s);
			added++;
		}
		console.log(
			`  ${String(added).padStart(3)} new of ${String(found.length).padStart(3)}  ${niche.label}`,
		);
	});
	console.log(
		`\n${city}: ${suggested} suggested across ${NICHES.length} niches → ${merged.size} new`,
	);

	const byTier = new Map<SourceTier, Suggestion[]>();
	for (const s of merged.values()) {
		byTier.set(s.tier, [...(byTier.get(s.tier) ?? []), s]);
	}
	for (const [tier, list] of byTier) {
		console.log(`\n  ${tier} (${list.length}):`);
		for (const s of list) {
			console.log(`      ${s.name.slice(0, 46).padEnd(48)} ${s.host}`);
		}
	}

	if (!APPLY || merged.size === 0) return;

	// Everything lands as method: llm — probe-sources decides what can actually
	// be scraped, and until then the AI search covers them.
	for (const [tier, list] of byTier) {
		const entries: SourceEntry[] = list.map((s) => ({
			name: s.name,
			method: "llm" as const,
			domains: [s.host],
			note: `Suggested by discover-sources ${new Date().toISOString().slice(0, 10)}; not yet verified.`,
		}));
		cfg.sources[tier] = [...(cfg.sources[tier] ?? []), ...entries];
	}
	const path = join(SOURCES_ROOT, `${city}.yml`);
	const original = readFileSync(path, "utf-8");
	const header = original.slice(0, original.indexOf("\nname:") + 1);
	// Serialise before opening: open-for-write truncates, so a throw while
	// building the body would leave the source of truth empty.
	const body = yaml.dump(cfg, { lineWidth: 100, noRefs: true });
	writeFileSync(path, `${header.replace(/\n+$/, "\n")}\n${body}`, "utf-8");
	console.log(`\n→ ${city}: added ${merged.size} source(s) to ${path}`);
}

async function main(): Promise<void> {
	installUsageReporting();
	const apiKey = process.env.GOOGLE_API_KEY;
	if (!apiKey) throw new Error("GOOGLE_API_KEY env var is required");
	const ai = new GoogleGenAI({ apiKey });

	for (const city of CITIES) {
		console.log(`\n=== ${city} ===`);
		await discoverCity(city, ai);
	}
	if (!APPLY) {
		console.log("\nDry run — rerun with --apply to add these sources.");
	}
}

// Guarded so the parser above can be imported by tests without the module
// running a full discovery sweep as an import side effect.
if (process.argv[1]?.endsWith("discover.ts")) await main();
