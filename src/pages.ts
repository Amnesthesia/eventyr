import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_ROOT, TOP_PICK_THRESHOLD, toISODate } from "./common.ts";

function main(): void {
	mkdirSync(DATA_ROOT, { recursive: true });

	const cities: Record<string, unknown>[] = [];

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
		} catch {
			console.log(`⚠ Skipping ${f} — could not parse`);
		}
	}

	const index = {
		generated_at: toISODate(new Date()),
		cities,
	};

	const outPath = join(DATA_ROOT, "index.json");
	writeFileSync(outPath, JSON.stringify(index, null, 2), "utf-8");
	console.log(`→ Written ${outPath} (${cities.length} city/cities)`);
	console.log("✓ Pages index complete.");
}

main();
