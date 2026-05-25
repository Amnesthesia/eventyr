import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	DATA_ROOT,
	PROJECT_ROOT,
	TOP_PICK_THRESHOLD,
	toISODate,
} from "./common.ts";

const BASE_URL = "https://www.dothings.lol";

const KEY_TO_SLUG: Record<string, string> = {
	brisbane: "brisbane",
	goldcoast: "gold-coast",
	sunnycoast: "sunshine-coast",
};

function buildSitemap(
	cities: Array<{ key: string; generated_at: string }>,
	today: string,
): string {
	const urls = [
		`  <url>\n    <loc>${BASE_URL}/brisbane</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
		...cities.map((c) => {
			const slug = KEY_TO_SLUG[c.key] ?? c.key;
			return `  <url>\n    <loc>${BASE_URL}/${slug}</loc>\n    <lastmod>${c.generated_at}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>`;
		}),
	];
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

function main(): void {
	mkdirSync(DATA_ROOT, { recursive: true });

	const cities: Record<string, unknown>[] = [];
	const cityMeta: Array<{ key: string; generated_at: string }> = [];

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
				top_pick_count: events.filter(
					(e) => ((e.score as number) ?? 0) >= TOP_PICK_THRESHOLD,
				).length,
			});
			cityMeta.push({
				key: payload.city_key as string,
				generated_at: (payload.generated_at as string) ?? toISODate(new Date()),
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
