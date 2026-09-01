// Per-city RSS feed, so people can subscribe to the week's events in a reader
// instead of visiting the site. Mirrors src/ical.ts — read data/{city}.json,
// map events, write a static file under public/ — differing only in format
// and in being a bit more forgiving: an event iCal can't represent (no
// parsable date) still makes a perfectly readable feed item.
//
// Runs over every city in one pass, like markdown.ts/pages.ts, so it needs no
// CITY env var.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, KEY_TO_SLUG, PROJECT_ROOT, SITE_URL } from "./common.ts";

interface Payload {
	city: string;
	city_key: string;
	week_start: string;
	week_end: string;
	generated_at?: string;
	events: Record<string, unknown>[];
}

function esc(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function str(event: Record<string, unknown>, key: string): string {
	const v = event[key];
	return typeof v === "string" ? v : "";
}

/**
 * RFC-822 date for <pubDate>, from the naive Brisbane wall-clock strings the
 * pipeline stores (`YYYY-MM-DDTHH:MM:SS` or `YYYY-MM-DD`).
 *
 * Note this is the event's start, not a publication timestamp. That's the
 * useful reading for an events feed — readers sort by it, so the feed reads
 * chronologically — but it does mean items are future-dated, and a few
 * readers hide future-dated items. The alternative (publication time) would
 * make every item's date identical and the ordering meaningless.
 */
function pubDate(naive: string): string | null {
	if (!naive) return null;
	const iso = naive.length === 10 ? `${naive}T00:00:00` : naive;
	const d = new Date(`${iso}+10:00`); // Australia/Brisbane, no DST
	if (Number.isNaN(d.getTime())) return null;
	return d.toUTCString();
}

/**
 * Stable, unique per-event id so a reader doesn't re-notify on every rebuild.
 *
 * Deliberately NOT the link: many events share one link (a venue homepage,
 * when the source gave no per-event URL), and duplicate guids make readers
 * collapse genuinely different events into a single item. Title + date + city
 * is unique in practice and stable across runs. (ical.ts uses the array index
 * for its UIDs, which changes week to week — tolerable for a calendar, not
 * for a feed.)
 */
export function guidFor(event: Record<string, unknown>, cityKey: string): string {
	const basis = `${cityKey}|${str(event, "title")}|${str(event, "datetime_iso")}`;
	let hash = 0;
	for (let i = 0; i < basis.length; i++) {
		hash = (hash * 31 + basis.charCodeAt(i)) | 0;
	}
	return `${SITE_URL}/${KEY_TO_SLUG[cityKey] ?? cityKey}#${(hash >>> 0).toString(36)}`;
}

function itemDescription(event: Record<string, unknown>): string {
	const parts = [
		str(event, "datetime"),
		str(event, "location"),
		str(event, "cost"),
	].filter(Boolean);
	const body = str(event, "description");
	return [parts.join(" · "), body].filter(Boolean).join("\n\n");
}

function buildFeed(payload: Payload): string {
	const slug = KEY_TO_SLUG[payload.city_key] ?? payload.city_key;
	const cityUrl = `${SITE_URL}/${slug}`;
	const feedUrl = `${cityUrl}/feed.xml`;
	const built = new Date().toUTCString();

	const items = payload.events.map((event) => {
		const date = pubDate(str(event, "datetime_iso"));
		const link = str(event, "link");
		const category = str(event, "category");
		return [
			"    <item>",
			`      <title>${esc(str(event, "title"))}</title>`,
			link ? `      <link>${esc(link)}</link>` : "",
			`      <guid isPermaLink="false">${esc(guidFor(event, payload.city_key))}</guid>`,
			// Omitted rather than faked when the date didn't parse — unlike the
			// iCal feed, which has to drop the event entirely.
			date ? `      <pubDate>${date}</pubDate>` : "",
			category ? `      <category>${esc(category)}</category>` : "",
			`      <description>${esc(itemDescription(event))}</description>`,
			"    </item>",
		]
			.filter(Boolean)
			.join("\n");
	});

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(payload.city)} — this week's events</title>
    <link>${cityUrl}</link>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <description>${esc(`Events in ${payload.city} for the week of ${payload.week_start} to ${payload.week_end}, ranked by fit.`)}</description>
    <language>en-AU</language>
    <lastBuildDate>${built}</lastBuildDate>
${items.join("\n")}
  </channel>
</rss>
`;
}

export function buildFeedFor(payload: Payload): string {
	return buildFeed(payload);
}

function main(): void {
	const files = readdirSync(DATA_ROOT).filter(
		(f) => f.endsWith(".json") && f !== "index.json" && !f.endsWith("_raw.json"),
	);

	for (const file of files) {
		let payload: Payload;
		try {
			payload = JSON.parse(
				readFileSync(join(DATA_ROOT, file), "utf-8"),
			) as Payload;
		} catch {
			continue;
		}
		if (!payload.city_key || !Array.isArray(payload.events)) continue;

		const slug = KEY_TO_SLUG[payload.city_key] ?? payload.city_key;
		const outDir = join(PROJECT_ROOT, "public", slug);
		mkdirSync(outDir, { recursive: true });
		const outPath = join(outDir, "feed.xml");
		writeFileSync(outPath, buildFeed(payload), "utf-8");
		console.log(`→ Written ${slug}/feed.xml (${payload.events.length} events)`);
	}
}

// Guarded so the pure helpers above can be imported by tests without the
// module writing files as a side effect of the import.
if (process.argv[1]?.endsWith("rss.ts")) main();
