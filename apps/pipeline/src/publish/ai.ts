// Static /ai/ feed for third-party AI assistants (Claude, ChatGPT, Gemini)
// browsing this site on a user's behalf, plus the /llms.txt pointer they're
// told to fetch first. No backend: everything here is a file written once per
// pipeline run and served exactly as committed, the same way public/*.ics and
// public/*/feed.xml already are.
//
// Runs over every already-curated data/{city}.json in one pass, like
// rss.ts/pages.ts, so it needs no CITY env var — it has to see every city at
// once to write one shared /ai/index.json.
//
// Source (data/{city}.json event) -> compact output field mapping:
//   id          eventHash(cityKey, event)         same stable id ical.ts/rss.ts use as UID/guid
//   title       stripForDisplay(event.title)      markdown/URL artefacts stripped
//   start       isoWithOffset(event.datetime_iso)  naive local wall-clock -> instant with the city's UTC offset
//   end         isoWithOffset(event.datetime_end_iso), or null — never guessed; a plain point-in-time
//               event carries no end at all, and "prefer null over a guess" (CLAUDE.md) applies here
//               exactly as it does to a missing date anywhere else in the pipeline
//   location    event.location, as-is
//   category    event.category, as-is (closed enum — see CATEGORIES in shared.ts)
//   price       costAmount(event.cost)            number, or null for a range/uninformative string ("See link")
//   free        costAmount(event.cost) === 0      same signal price uses, not a second regex to drift from it
//   description stripForDisplay(event.description), HTML-tag-stripped, then word-truncated to ~200 chars
//   url         this event's own page (eventPath) — stable even after the source's ticket link rots,
//               and it's the page that already carries the schema.org Event JSON-LD
//
// Events below LOW_SCORE_THRESHOLD (venue promotion rank.ts scores ~1) are
// dropped, matching ical.ts/rss.ts: an AI recommending events should not be
// handed the happy-hour noise the site itself hides by default.
//
// Day/week boundaries: day files cover today() through the city's own
// week_end (never earlier than today, never a boundary this module invents —
// see getDayDates), and the week file is named for the city's own week_start,
// exactly like the JSON the weekly digest already publishes. A city whose
// whole published week has already passed (stale digest) gets zero day/week
// files and a warning, not a file dated in the past.
//
// Day-file size is logged against a 50 KB soft target (loadPipelineConfig().publish.ai.dayWarnBytes) but
// never enforced by dropping events — a busy city on a busy day (Brisbane
// runs 180+ events even after the LOW_SCORE_THRESHOLD floor) is allowed to
// produce a bigger file rather than hide otherwise-recommendable events.
// Week files get the category split when they exceed loadPipelineConfig().publish.ai.weekSplitBytes, below.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	AiIndex,
	CityIndexEntry,
	CompactEvent,
	DayFile,
	WeekFile,
} from "@dothingslol/core/aiFeed";
import {
	CATEGORIES,
	catToSlug,
	costAmount,
	eventHash,
	eventOverlapsRange,
	eventPath,
	isoWithOffset,
	KEY_TO_SLUG,
	meetsScoreFloor,
	SITE_URL,
	stripForDisplay,
	toISODate,
} from "@dothingslol/core/shared";
import { addDays } from "@dothingslol/utils/tz";
import { loadCityConfig } from "../config/city.js";
import type { Logger } from "../config/context.js";
import type { PipelineConfig } from "../config/load.js";
import { DATA_ROOT, WEB_PUBLIC_DIR } from "../config/paths.js";

const AI_ROOT = join(WEB_PUBLIC_DIR, "ai");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawEvent {
	title?: string;
	datetime_iso?: string;
	datetime_end_iso?: string;
	datetime?: string;
	location?: string;
	category?: string;
	cost?: string;
	description?: string;
	link?: string;
	score?: number;
}

export interface CityPayload {
	city: string;
	city_key: string;
	week_start: string;
	week_end: string;
	generated_at?: string;
	timezone?: string;
	events: RawEvent[];
}

// CompactEvent, DayFile, WeekFile, CityIndexEntry and AiIndex are the
// shared shape with apps/mcp — see @dothingslol/core/aiFeed.

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const HTML_TAG = /<[^>]+>/g;

/** Word-boundary truncation so a compact description never reads as cut off
 * mid-word. ~200 chars per the spec; the ellipsis is not counted against it. */
function truncate(text: string, max = 200): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	const trimmed = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
	return `${trimmed.trim()}…`;
}

/** Maps one already-published event to the compact AI schema. Returns null
 * for the rare event with no usable title or start date — code decides what
 * is publishable, not a guess filled in here. */
export function mapEvent(
	event: RawEvent,
	cityKey: string,
	timezone: string,
): CompactEvent | null {
	const title = stripForDisplay(event.title ?? "").replace(HTML_TAG, "");
	const start = isoWithOffset(event.datetime_iso, timezone);
	if (!title || !start) return null;

	const end = isoWithOffset(event.datetime_end_iso, timezone) ?? null;
	const price = costAmount(event.cost);
	const description = truncate(
		stripForDisplay(event.description ?? "").replace(HTML_TAG, ""),
	);

	return {
		id: eventHash(cityKey, event),
		title,
		start,
		end,
		location: event.location ?? "",
		category: event.category ?? "",
		price,
		free: price === 0,
		description,
		url: `${SITE_URL}${eventPath(cityKey, event)}`,
	};
}

/** Naive (offset-free) start-date comparator — the same reasoning as
 * byScoreThenSoonest in shared.ts: comparing the wall-clock string avoids a
 * DST-transition offset change silently reordering two events on the same
 * evening. */
function byStart(a: RawEvent, b: RawEvent): number {
	return (a.datetime_iso ?? "").localeCompare(b.datetime_iso ?? "");
}

// ---------------------------------------------------------------------------
// Day range
// ---------------------------------------------------------------------------

/** Every YYYY-MM-DD from `from` to `to` inclusive (calendar arithmetic, so
 * neither the host's zone nor a DST change can skip or repeat a day). */
function dateRange(from: string, to: string): string[] {
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
}

/**
 * The day files this city earns for this build: every day from today() (or
 * week_start, whichever is later) through week_end — the remaining days of
 * the same week the digest already publishes, never a boundary invented here.
 * Empty when week_end has already passed (a stale digest that hasn't run this
 * week), which is deliberate: "never emit past-dated files" applies to the
 * whole city, not just individual days.
 */
export function getDayDates(payload: CityPayload, todayStr: string): string[] {
	if (payload.week_end < todayStr) return [];
	const from = payload.week_start > todayStr ? payload.week_start : todayStr;
	return dateRange(from, payload.week_end);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildDayFile(
	payload: CityPayload,
	date: string,
	timezone: string,
): DayFile {
	const events = payload.events
		.filter(
			(e) => meetsScoreFloor(e.score) && eventOverlapsRange(e, date, date),
		)
		.sort(byStart)
		.map((e) => mapEvent(e, payload.city_key, timezone))
		.filter((e): e is CompactEvent => e !== null);
	return {
		data_as_of: payload.generated_at ?? toISODate(new Date(), timezone),
		city: payload.city,
		city_key: payload.city_key,
		timezone,
		date,
		events,
	};
}

export function buildWeekFile(
	payload: CityPayload,
	timezone: string,
): WeekFile {
	const events = payload.events
		.filter(
			(e) =>
				meetsScoreFloor(e.score) &&
				eventOverlapsRange(e, payload.week_start, payload.week_end),
		)
		.sort(byStart)
		.map((e) => mapEvent(e, payload.city_key, timezone))
		.filter((e): e is CompactEvent => e !== null);
	return {
		data_as_of: payload.generated_at ?? toISODate(new Date(), timezone),
		city: payload.city,
		city_key: payload.city_key,
		timezone,
		week_start: payload.week_start,
		week_end: payload.week_end,
		events,
	};
}

// ---------------------------------------------------------------------------
// Per-city generation
// ---------------------------------------------------------------------------

function writeJson(path: string, value: unknown): number {
	mkdirSync(join(path, ".."), { recursive: true });
	const body = JSON.stringify(value, null, 2);
	writeFileSync(path, body, "utf-8");
	return Buffer.byteLength(body, "utf-8");
}

/** Removes files under `dir` that this run did not (re)write — the same
 * demotion ical.ts applies to per-event .ics files. Without it a day whose
 * events all dropped off, or a week that shrank back under the split
 * threshold, would keep serving yesterday's file forever. */
function pruneStale(dir: string, keep: Set<string>): number {
	if (!existsSync(dir)) return 0;
	let removed = 0;
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (name.endsWith(".json") && !keep.has(full)) {
			rmSync(full);
			removed++;
		} else if (!name.endsWith(".json") && !keep.has(full)) {
			// A stale week-{date}/ split directory from a previous run.
			rmSync(full, { recursive: true, force: true });
			removed++;
		}
	}
	return removed;
}

/** `todayStr` is the city's own date, in `timezone`. */
function processCity(
	log: Logger,
	cfg: PipelineConfig,
	payload: CityPayload,
	todayStr: string,
	timezone: string,
): CityIndexEntry {
	const slug = KEY_TO_SLUG[payload.city_key] ?? payload.city_key;
	const cityDir = join(AI_ROOT, slug);
	const keep = new Set<string>();

	const days = getDayDates(payload, todayStr);
	const dayEntries: string[] = [];
	for (const date of days) {
		const file = buildDayFile(payload, date, timezone);
		const outPath = join(cityDir, `${date}.json`);
		const size = writeJson(outPath, file);
		keep.add(outPath);
		dayEntries.push(`/ai/${slug}/${date}.json`);
		log.log(
			`→ ai/${slug}/${date}.json (${file.events.length} events, ${(size / 1024).toFixed(1)} KB)` +
				(size > cfg.publish.ai.dayWarnBytes ? " ⚠ over 50 KB target" : ""),
		);
	}

	let weekEntry: string | null = null;
	const categoryEntries: { category: string; slug: string; file: string }[] =
		[];
	if (payload.week_end >= todayStr) {
		const week = buildWeekFile(payload, timezone);
		const outPath = join(cityDir, `week-${payload.week_start}.json`);
		const size = writeJson(outPath, week);
		keep.add(outPath);
		weekEntry = `/ai/${slug}/week-${payload.week_start}.json`;
		log.log(
			`→ ai/${slug}/week-${payload.week_start}.json (${week.events.length} events, ${(size / 1024).toFixed(1)} KB)` +
				(size > cfg.publish.ai.weekSplitBytes
					? " ⚠ over 200 KB target — also splitting by category"
					: ""),
		);

		if (size > cfg.publish.ai.weekSplitBytes) {
			const splitDir = join(cityDir, `week-${payload.week_start}`);
			keep.add(splitDir);
			for (const category of CATEGORIES) {
				const events = week.events.filter((e) => e.category === category);
				if (events.length === 0) continue;
				const catSlug = catToSlug(category);
				const catPayload: WeekFile = { ...week, events };
				const catPath = join(splitDir, `${catSlug}.json`);
				const catSize = writeJson(catPath, catPayload);
				keep.add(catPath);
				categoryEntries.push({
					category,
					slug: catSlug,
					file: `/ai/${slug}/week-${payload.week_start}/${catSlug}.json`,
				});
				log.log(
					`  → ai/${slug}/week-${payload.week_start}/${catSlug}.json (${events.length} events, ${(catSize / 1024).toFixed(1)} KB)`,
				);
			}
		}
	} else {
		log.log(
			`⚠ ${payload.city_key}: week_end ${payload.week_end} is before today (${todayStr}) — data is stale, skipping day/week files.`,
		);
	}

	const removed = pruneStale(cityDir, keep);
	if (removed > 0)
		log.log(`  (removed ${removed} stale file(s) under ai/${slug}/)`);

	return {
		city: payload.city,
		city_key: payload.city_key,
		slug,
		timezone,
		data_as_of: payload.generated_at ?? todayStr,
		days: dayEntries,
		week: weekEntry,
		week_categories: categoryEntries,
	};
}

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

function buildLlmsTxt(cities: CityIndexEntry[], todayStr: string): string {
	const cityList = cities
		.map(
			(c) =>
				`  - ${c.city} (city_key: "${c.city_key}", timezone: ${c.timezone})`,
		)
		.join("\n");

	return `# dothings.lol — machine-readable events feed

dothings.lol curates and ranks local events weekly for South East Queensland
and Byron Bay. This file tells an AI assistant how to fetch that data as
plain JSON with no API key and no backend — every URL below is a static file.

## Cities

${cityList}

## Fetch order

1. GET https://www.dothings.lol/ai/index.json
   Lists every city with its slug, IANA timezone, a data_as_of date, and the
   exact URLs of every day file and week file currently available for it (a
   city can have zero if its weekly refresh hasn't run yet — check data_as_of).

2. Pick the SMALLEST file that answers the question:
   - "today" / "tomorrow" -> GET the one matching day file:
     https://www.dothings.lol/ai/{city_key}/{YYYY-MM-DD}.json
   - "this weekend" -> GET the Saturday and Sunday day files (two requests,
     each cheap) and merge them. There is no separate weekend file.
   - "this week" / "plan my week" -> GET the week file:
     https://www.dothings.lol/ai/{city_key}/week-{YYYY-MM-DD}.json
     (named for the Monday it starts on). If a week file was too large to
     keep under ~200 KB, index.json also lists it split by category under
     https://www.dothings.lol/ai/{city_key}/week-{YYYY-MM-DD}/{category}.json
     — fetch only the category the question is actually about.
   - "next week" -> NOT available. Only the current published week's files
     exist at any time (this site re-curates one week at a time); index.json
     will not list a week file for next week until it has actually run. Say
     so rather than guessing or reusing this week's data.
   Do not fetch a week file to answer a single-day question.

3. A ChatGPT Custom GPT Action can instead call the OpenAPI spec at
   https://www.dothings.lol/ai/openapi.yaml (operations getIndex,
   getDayEvents, getWeekEvents).

4. Claude specifically (Desktop, claude.ai, Claude Code) can skip fetching
   this file by hand and connect to https://mcp.dothings.lol/mcp as an MCP
   server instead, with list_cities and get_events tools over the same data.
   Not available to ChatGPT or Gemini, which don't support MCP.

5. An assistant that supports installable Agent Skills can load
   https://www.dothings.lol/skill/dothings-events/SKILL.md instead of reading
   this file — it covers the same fetch order plus a preference-memory
   protocol for tailoring picks across conversations.

## Fields

Every file has: data_as_of (the date this data was generated — treat listings
as possibly stale if it is more than a week old), city, city_key, timezone
(IANA zone the times below are written in), and either date (day files) or
week_start/week_end (week files), plus an events array.

Each event has:
  id           stable identifier, unique within a city
  title        plain text
  start, end   ISO 8601 with a UTC offset, already in the city's own local
               time (e.g. "2026-09-18T19:30:00+10:00") — end is null when no
               end time is published, never a guess
  location     venue/address as a plain string
  category     one of: ${CATEGORIES.join(", ")}
  price        a number in the city's local currency, or null if the price is
               a range or not stated numerically (see "free" instead)
  free         true if the event costs nothing
  description  one line, HTML/markdown already stripped, ~200 characters
  url          the event's own page on dothings.lol — always live, and it
               carries full schema.org Event markup if you need more detail

Every file is already curated: venue promotion (happy hours, meal deals,
raffles) and anything below this site's own quality floor is excluded before
you ever see it, so an empty or short list is a real signal, not missing
data — treat what you receive as already filtered for quality, not a raw
feed to re-rank from scratch.

## Refresh schedule

Each city's data is regenerated once a week (Sunday 06:00 Australia/Brisbane
time for the week starting the next day); day/week files are pruned and
rewritten on every run, so a URL that existed last week may 404 this week.
Always check data_as_of before telling someone "this is happening" — if it is
more than a few days old, say so rather than presenting it as current.

## Recommending events / planning an itinerary

- Use what you already know about the person's interests, not a generic
  "popular events" list — this data has no personalization built in.
- For an itinerary: never suggest two events whose start/end overlap, allow
  realistic travel time between venues in different parts of the city, and
  don't overpack one evening — two or three well-chosen events beats a
  back-to-back schedule.
- Always link to the event's own url so the person can check details and buy
  tickets themselves.
- Never invent an event that is not in the fetched file. If nothing fits,
  say so instead of padding the answer.

Generated ${todayStr}.
`;
}

// ---------------------------------------------------------------------------
// Validation — fails loudly, run at the end of every build.
// ---------------------------------------------------------------------------

function fail(message: string): never {
	throw new Error(`✗ /ai validation failed: ${message}`);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Local calendar date bounds an event covers, read back from its own
 * (already offset-applied) start/end — the date component of an
 * isoWithOffset string IS the local date by construction. */
function eventDateBounds(event: CompactEvent): { start: string; end: string } {
	const start = event.start.slice(0, 10);
	const end = event.end ? event.end.slice(0, 10) : start;
	return { start, end };
}

function validateEvent(
	event: unknown,
	context: string,
): asserts event is CompactEvent {
	if (!event || typeof event !== "object")
		fail(`${context}: event is not an object`);
	const e = event as Record<string, unknown>;
	if (!isNonEmptyString(e.id)) fail(`${context}: event missing id`);
	if (!isNonEmptyString(e.title))
		fail(`${context}: event "${e.id}" missing title`);
	if (!isNonEmptyString(e.start))
		fail(`${context}: event "${e.id}" missing start`);
	if (!isNonEmptyString(e.url)) fail(`${context}: event "${e.id}" missing url`);
}

function readJson(path: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		fail(`referenced file does not exist: ${path}`);
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		fail(`${path} is not valid JSON (${(err as Error).message})`);
	}
}

function validateDayFile(relPath: string, todayStr: string): void {
	const fullPath = join(WEB_PUBLIC_DIR, relPath.replace(/^\//, ""));
	const payload = readJson(fullPath) as Record<string, unknown>;
	const date = payload.date as string;
	if (date < todayStr) fail(`${relPath}: date ${date} is in the past`);
	if (!Array.isArray(payload.events))
		fail(`${relPath}: events is not an array`);
	for (const raw of payload.events) {
		validateEvent(raw, relPath);
		const { start, end } = eventDateBounds(raw);
		if (date < start || date > end) {
			fail(
				`${relPath}: event "${raw.id}" (${start}..${end}) does not cover this file's day ${date}`,
			);
		}
	}
}

function validateWeekFile(relPath: string, todayStr: string): void {
	const fullPath = join(WEB_PUBLIC_DIR, relPath.replace(/^\//, ""));
	const payload = readJson(fullPath) as Record<string, unknown>;
	if ((payload.week_end as string) < todayStr) {
		fail(`${relPath}: week_end ${payload.week_end} is entirely in the past`);
	}
	if (!Array.isArray(payload.events))
		fail(`${relPath}: events is not an array`);
	for (const raw of payload.events) {
		validateEvent(raw, relPath);
		const { start, end } = eventDateBounds(raw);
		if (
			end < (payload.week_start as string) ||
			start > (payload.week_end as string)
		) {
			fail(
				`${relPath}: event "${raw.id}" (${start}..${end}) does not overlap the week ${payload.week_start}..${payload.week_end}`,
			);
		}
	}
}

/** Fails loudly on: invalid JSON, an event missing id/title/start/url, an
 * event assigned to a day it doesn't cover, or index.json pointing at a file
 * that was never written. Reads what was just written back off disk, rather
 * than trusting the in-memory objects that produced it, so a write bug (a
 * truncated file, wrong path) is caught the same run it happens. */
export function validateOutput(
	indexPath: string,
	todayByCity: Record<string, string>,
): void {
	const index = readJson(indexPath) as AiIndex;
	if (!Array.isArray(index.cities)) fail("index.json: cities is not an array");

	for (const city of index.cities) {
		// Each city's "past" is its own: Sydney reaches tomorrow an hour before
		// Brisbane does.
		const todayStr = todayByCity[city.city_key];
		for (const dayPath of city.days) validateDayFile(dayPath, todayStr);
		if (city.week) validateWeekFile(city.week, todayStr);
		for (const cat of city.week_categories) {
			const fullPath = join(WEB_PUBLIC_DIR, cat.file.replace(/^\//, ""));
			if (!existsSync(fullPath)) fail(`index.json: ${cat.file} does not exist`);
		}
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export interface PublishAiFeedResult {
	cityCount: number;
}

/**
 * Every city in one pass, like rss.ts/pages.ts, so it needs no CITY env var —
 * it has to see every city at once to write one shared /ai/index.json.
 */
export async function publishAiFeed(
	log: Logger,
	cfg: PipelineConfig,
): Promise<PublishAiFeedResult> {
	const now = new Date();
	const todayByCity: Record<string, string> = {};
	const files = readdirSync(DATA_ROOT).filter(
		(f) =>
			f.endsWith(".json") && f !== "index.json" && !f.endsWith("_raw.json"),
	);

	const cities: CityIndexEntry[] = [];
	for (const file of files) {
		let payload: CityPayload;
		try {
			payload = JSON.parse(readFileSync(join(DATA_ROOT, file), "utf-8"));
		} catch {
			log.log(`⚠ Skipping ${file} — could not parse`);
			continue;
		}
		if (!payload.city_key || !Array.isArray(payload.events)) continue;
		// From the city config, not the payload: a digest written before a
		// city's zone was corrected must not keep publishing the old one.
		const { timezone } = loadCityConfig(payload.city_key);
		const cityToday = toISODate(now, timezone);
		todayByCity[payload.city_key] = cityToday;
		cities.push(processCity(log, cfg, payload, cityToday, timezone));
	}
	// One date for the whole index: the latest any published city has reached,
	// so it comes from the cities' zones and never from the host's.
	const todayStr =
		Object.values(todayByCity).sort().at(-1) ?? now.toISOString().slice(0, 10);

	const index: AiIndex = { data_as_of: todayStr, cities };
	const indexPath = join(AI_ROOT, "index.json");
	writeJson(indexPath, index);
	log.log(`→ ai/index.json (${cities.length} cities)`);

	const llmsPath = join(WEB_PUBLIC_DIR, "llms.txt");
	writeFileSync(llmsPath, buildLlmsTxt(cities, todayStr), "utf-8");
	log.log("→ llms.txt");

	validateOutput(indexPath, todayByCity);
	log.log("✓ /ai output validated.");
	return { cityCount: cities.length };
}
