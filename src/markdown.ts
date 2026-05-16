import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	CATEGORY_EMOJI,
	DATA_ROOT,
	fmtDate,
	PROJECT_ROOT,
	TOP_PICK_THRESHOLD,
} from "./common.ts";

type Event = Record<string, unknown>;

function writeMarkdown(
	events: Event[],
	monday: Date,
	sunday: Date,
	cityName: string,
	cityKey: string,
): void {
	const topPicks = events.filter(
		(e) => ((e.score as number) ?? 0) >= TOP_PICK_THRESHOLD,
	);
	const remaining = events.filter(
		(e) => ((e.score as number) ?? 0) < TOP_PICK_THRESHOLD,
	);

	const lines: string[] = [];

	lines.push(`# ${cityName} — This Week's Events`);
	lines.push(`**${fmtDate(monday)} – ${fmtDate(sunday)}**  `);
	lines.push(`*${topPicks.length} top picks · ${events.length} events total*`);
	lines.push("");

	if (topPicks.length > 0) {
		lines.push("## ⭐ Top Picks");
		lines.push("");
		for (const e of topPicks) {
			const cat = (e.category as string) ?? "Community / Other";
			const emoji = CATEGORY_EMOJI[cat] ?? "📌";
			const cost = (e.cost as string) ?? "See link";
			const costS = cost.toLowerCase() === "free" ? "Free" : cost;
			const tags = (e.tags as string[]) ?? [];
			const link = (e.link as string) ?? "";
			const title = (e.title as string) ?? "Untitled";

			lines.push(
				link ? `### ${emoji} [${title}](${link})` : `### ${emoji} ${title}`,
			);
			lines.push(`📆 ${(e.datetime as string) ?? "—"}  `);
			lines.push(`📍 ${(e.location as string) ?? "—"}  `);
			lines.push(`💰 ${costS}  `);
			if (tags.length > 0) {
				lines.push(`\`${tags.slice(0, 6).join("` `")}\``);
			}
			const desc = (e.description as string) ?? "";
			if (desc) {
				lines.push("");
				lines.push(desc);
			}
			lines.push("");
		}
	}

	if (remaining.length > 0) {
		const byCat: Record<string, Event[]> = {};
		for (const e of remaining) {
			const cat = (e.category as string) ?? "Community / Other";
			if (!byCat[cat]) byCat[cat] = [];
			byCat[cat].push(e);
		}

		lines.push("## 📋 All Events");
		lines.push("");
		for (const [cat, catEvents] of Object.entries(byCat)) {
			const emoji = CATEGORY_EMOJI[cat] ?? "📌";
			lines.push(`### ${emoji} ${cat}`);
			lines.push("");
			for (const e of catEvents) {
				const cost = (e.cost as string) ?? "See link";
				const costS = cost.toLowerCase() === "free" ? "Free" : cost;
				const tags = (e.tags as string[]) ?? [];
				const link = (e.link as string) ?? "";
				const title = (e.title as string) ?? "Untitled";

				lines.push(link ? `#### [${title}](${link})` : `#### ${title}`);
				lines.push(`📆 ${(e.datetime as string) ?? "—"}`);
				lines.push(`📍 ${(e.location as string) ?? "—"}`);
				lines.push(`💰 ${costS}`);
				if (tags.length > 0) {
					lines.push(`\`${tags.slice(0, 6).join("` `")}\``);
				}
				const desc = (e.description as string) ?? "";
				if (desc) {
					lines.push("");
					lines.push(desc);
				}
				lines.push("");
			}
		}
	}

	const outPath = join(PROJECT_ROOT, `${cityKey.toUpperCase()}.md`);
	writeFileSync(outPath, lines.join("\n"), "utf-8");
	console.log(
		`→ Written ${cityKey.toUpperCase()}.md (${events.length} events)`,
	);
}

function main(): void {
	const jsonFiles = readdirSync(DATA_ROOT)
		.filter(
			(f) =>
				f.endsWith(".json") && f !== "index.json" && !f.includes("_raw.json"),
		)
		.sort()
		.map((f) => join(DATA_ROOT, f));

	if (jsonFiles.length === 0) {
		throw new Error(
			"✗ No city JSON files found in data/ — run collection.ts first.",
		);
	}

	console.log("Markdown generation");
	console.log("=".repeat(50));

	for (const jsonPath of jsonFiles) {
		const payload = JSON.parse(readFileSync(jsonPath, "utf-8"));
		writeMarkdown(
			payload.events,
			new Date(payload.week_start),
			new Date(payload.week_end),
			payload.city,
			payload.city_key,
		);
	}

	console.log("✓ Markdown complete.");
}

main();
