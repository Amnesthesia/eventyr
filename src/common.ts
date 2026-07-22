import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_ROOT = resolve(__dirname, "..");
export const DATA_ROOT = join(PROJECT_ROOT, "data");
export const SOURCES_ROOT = join(PROJECT_ROOT, "sources");

export const CATEGORIES = [
	"Public Lecture",
	"Workshop / Class",
	"Concert / Music",
	"Social / Meetup",
	"Arts / Exhibition",
	"Community / Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_EMOJI: Record<string, string> = {
	"Public Lecture": "🎓",
	"Workshop / Class": "🛠️",
	"Concert / Music": "🎵",
	"Social / Meetup": "🤝",
	"Arts / Exhibition": "🎨",
	"Community / Other": "📌",
};

export const TOP_PICK_THRESHOLD = 7;

export const INTERESTS = `
WANT:
  - Intellectually stimulating talks, lectures, salons, workshops, panels, and debates focused on science, philosophy, psychology, technology, systems thinking, futurism, culture, design, history, AI, human behavior, or creativity
  - Events that attract curious, thoughtful, open-minded, creative, adventurous, or intellectually engaged people rather than purely corporate audiences
  - Community-oriented recurring events where people naturally talk before/after: book clubs, philosophy groups, writing circles, language exchanges, discussion salons, coworking socials, maker spaces, creative communities
  - Creative or hands-on workshops: photography, writing, pottery, drawing, music, woodworking, craft, electronics, robotics, fermentation, gardening, maker/hacker culture
  - Live experiences with strong atmosphere or artistic value: indie music, jazz, folk, intimate gigs, theatre (fringe, immersive, experimental, and mainstream), art exhibitions, experimental performances, film screenings, comedy nights and stand-up
  - Outdoor and adventure-oriented social events like hiking groups, trail running, climbing, scuba/freediving, paragliding, camping, adventure travel, nature excursions
  - Wellness-oriented events only if grounded and socially authentic: yoga, breathwork, meditation, sauna, movement workshops — avoid overly commercial or cult-like spirituality
  - Free or low-cost local community events preferred

PREFER:
  - Smaller events over massive crowds
  - Events where conversation between strangers is natural
  - Events with recurring communities or regular attendees
  - Authentic subcultures over polished corporate experiences
  - Mixed-age crowds with thoughtful or interesting people
  - Events that feel exploratory, creative, intellectually alive, or inspiring

SKIP ENTIRELY — do not include:
  - Spectator sports of any kind (rugby, cricket, football, racing, etc.)
  - Generic corporate networking events or recruitment / career expos
  - "Business opportunity" seminars, MLMs, hustle culture, crypto hype, or sales funnels
  - Ultra-touristy events designed mainly for Instagram/photos
  - Generic nightclub events or heavy drinking culture
  - Influencer-style wellness events with little substance
  - Online-only events unless strongly tied to the local community
`;

export interface CityConfig {
	name: string;
	timezone?: string;
	sources: {
		aggregators: string[];
		institutions: string[];
		independents: string[];
	};
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
	return yaml.load(raw) as CityConfig;
}

export function getWeekRange(): { monday: Date; sunday: Date } {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	// JS getDay(): 0=Sun, 1=Mon...6=Sat. We want the Monday of the current week.
	const day = today.getDay();
	const daysToMonday = day === 0 ? 1 : 1 - day;
	const monday = new Date(today);
	monday.setDate(today.getDate() + daysToMonday);
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	return { monday, sunday };
}

export function fmtDate(d: Date): string {
	// e.g. "12 May 2025"
	return d.toLocaleDateString("en-AU", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

export function toISODate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) throw new Error(`${name} env var is required`);
	return val;
}

export function rawPath(city: string, provider: string, tier: string): string {
	return join(DATA_ROOT, city, provider, "raw", `${tier}.json`);
}

export function curatedPath(
	city: string,
	provider: string,
	tier: string,
): string {
	return join(DATA_ROOT, city, provider, "curated", `${tier}.json`);
}

export interface EventFingerprint {
	title: string;
	date: string;
}

export function diceSimilarity(a: string, b: string): number {
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

function normalizeTitle(title: string): string {
	return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export function fingerprintEvent(
	event: Record<string, unknown>,
): EventFingerprint {
	return {
		title: normalizeTitle((event.title as string) ?? ""),
		date: (
			(event.datetime_iso as string) ??
			(event.datetime as string) ??
			""
		).slice(0, 10),
	};
}

// The same event often shows up once bare ("Board Game Weekly Meetup") and
// once with a venue suffix from a different source ("Board Game Weekly
// Meetup @ Vault Games Brisbane City") — a straight Dice comparison
// undercounts these because the extra suffix dominates the bigram overlap.
// Catch that case with a prefix/containment check before falling back to
// fuzzy matching for typos/reordering.
function titlesMatch(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a))) {
		return true;
	}
	return diceSimilarity(a, b) > 0.85;
}

export function isDuplicateEvent(
	a: EventFingerprint,
	b: EventFingerprint,
): boolean {
	if (a.date && b.date && a.date !== b.date) return false;
	return titlesMatch(a.title, b.title);
}

export function dedupeEvents(
	events: Record<string, unknown>[],
): Record<string, unknown>[] {
	const seen: EventFingerprint[] = [];
	const unique: Record<string, unknown>[] = [];
	for (const event of events) {
		const fp = fingerprintEvent(event);
		if (!seen.some((s) => isDuplicateEvent(fp, s))) {
			unique.push(event);
			seen.push(fp);
		}
	}
	return unique;
}
