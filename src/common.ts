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
