import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	DATA_ROOT,
	eventPath,
	isTopPick,
	KEY_TO_SLUG,
	PROJECT_ROOT,
	SITE_URL,
	toISODate,
} from "./common.ts";

const BASE_URL = SITE_URL;

const CATEGORY_SLUGS = [
	"arts",
	"community",
	"music",
	"talks",
	"social",
	"workshops",
];

// Matches the slugs src/pages/[city]/[timeframe].astro generates.
const TIMEFRAME_SLUGS = ["today", "tomorrow", "this-weekend"];

interface CityMeta {
	key: string;
	generated_at: string;
	/** Every event's own page. Pre-rendered so a shared link unfurls as that
	 * event rather than as the city (src/pages/[city]/e/[event].astro). */
	eventPaths: string[];
}

/**
 * Every <loc> ends in a slash, matching what the server answers 200 to.
 * Astro writes `<path>/index.html` and GitHub Pages 301s the slash-less form,
 * so without this the whole sitemap was a list of redirects.
 */
function buildSitemap(cities: CityMeta[], today: string): string {
	const urls = [
		`  <url>\n    <loc>${BASE_URL}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
		...cities.flatMap((c) => {
			const slug = KEY_TO_SLUG[c.key] ?? c.key;
			const cityUrl = `  <url>\n    <loc>${BASE_URL}/${slug}/</loc>\n    <lastmod>${c.generated_at}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>`;
			const catUrls = CATEGORY_SLUGS.map(
				(cat) =>
					`  <url>\n    <loc>${BASE_URL}/${slug}/${cat}/</loc>\n    <lastmod>${c.generated_at}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
			);
			// These three change what they show every day (see [timeframe].astro
			// and deploy.yml's daily rebuild), so lastmod is the build date rather
			// than the underlying data's generated_at.
			const timeframeUrls = TIMEFRAME_SLUGS.map(
				(tf) =>
					`  <url>\n    <loc>${BASE_URL}/${slug}/${tf}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`,
			);
			// Lower priority than the city and category pages, and weekly like
			// them: an event page is a share target first and a search result
			// second. They are indexable — a hard 404 once the event rolls off is
			// not a penalty, and GitHub Pages serves a real 404 — but they should
			// not outrank the pages that are always there.
			const eventUrls = c.eventPaths.map(
				(path) =>
					`  <url>\n    <loc>${BASE_URL}${path}</loc>\n    <lastmod>${c.generated_at}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
			);
			return [cityUrl, ...catUrls, ...timeframeUrls, ...eventUrls];
		}),
	];
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

function main(): void {
	mkdirSync(DATA_ROOT, { recursive: true });

	const cities: Record<string, unknown>[] = [];
	const cityMeta: CityMeta[] = [];

	const jsonFiles = readdirSync(DATA_ROOT)
		.filter(
			(f) =>
				f.endsWith(".json") && f !== "index.json" && !f.includes("_raw.json"),
		)
		.sort()
		.map((f) => join(DATA_ROOT, f));

	for (const f of jsonFiles) {
		try {
			const payload = JSON.parse(readFileSync(f, "utf-8")) as Record<
				string,
				unknown
			>;
			const events = (payload.events as Record<string, unknown>[]) ?? [];
			cities.push({
				key: payload.city_key,
				name: payload.city,
				week_start: payload.week_start,
				week_end: payload.week_end,
				event_count: events.length,
				top_pick_count: events.filter((e) =>
					isTopPick(
						e,
						payload.week_start as string,
						payload.week_end as string,
					),
				).length,
			});
			cityMeta.push({
				key: payload.city_key as string,
				generated_at: (payload.generated_at as string) ?? toISODate(new Date()),
				eventPaths: events.map((e) => eventPath(payload.city_key as string, e)),
			});
		} catch {
			console.log(`⚠ Skipping ${f} — could not parse`);
		}
	}

	const today = toISODate(new Date());

	const index = {
		generated_at: today,
		cities,
	};

	const outPath = join(DATA_ROOT, "index.json");
	writeFileSync(outPath, JSON.stringify(index, null, 2), "utf-8");
	console.log(`→ Written ${outPath} (${cities.length} city/cities)`);

	const sitemapPath = join(PROJECT_ROOT, "public", "sitemap.xml");
	writeFileSync(sitemapPath, buildSitemap(cityMeta, today), "utf-8");
	console.log(`→ Written ${sitemapPath}`);

	console.log("✓ Pages index complete.");
}

main();
