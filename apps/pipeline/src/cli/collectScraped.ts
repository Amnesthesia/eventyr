import "../llmBootstrap.ts";
import { dirname, relative } from "node:path";
import { runContextFromEnv } from "../config/context.js";
import { requireEnv } from "../config/env.js";
import { curatedPath, PROJECT_ROOT } from "../config/paths.js";
import { fmtDate } from "../config/week.js";
import { installUsageReporting } from "../io/usage.ts";
import { collectScraped } from "../stages/collectScraped.js";

requireEnv("GOOGLE_API_KEY");

async function main(): Promise<void> {
	installUsageReporting();
	const ctx = runContextFromEnv();
	console.log(
		`Scraping — ${ctx.cityConfig.name} — ${fmtDate(ctx.week.monday, ctx.cityConfig.timezone)} to ${fmtDate(ctx.week.sunday, ctx.cityConfig.timezone)}`,
	);

	const onlyArg = process.argv.find((a) => a.startsWith("--only="));
	const only = onlyArg
		? onlyArg
				.slice("--only=".length)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: undefined;

	const result = await collectScraped(ctx, { only });

	for (const { level, text } of result.log) console[level](text);
	if (result.noRegistry) return;
	if (result.sources.length === 0) {
		console.log("→ No scraper sources — nothing to scrape.");
		return;
	}
	console.log(`→ ${result.sources.length} scraper source(s)`);
	for (const source of result.sources) {
		for (const { level, text } of source.log) console[level](text);
	}

	if (result.partialRunNoReport) {
		console.log(
			"→ Partial run and no barren report for this week — left it absent (every scraper source counts as uncovered until a full run).",
		);
	}
	if (result.barren.length > 0) {
		console.log(
			`⚠ ${result.barren.length} scraper source(s) returned nothing — AI search will cover them: ${result.barren.join(", ")}`,
		);
	}

	const { found, kept, past, later, undated } = result.totals;
	console.log(
		`\n${found} found → ${kept} in window (${found ? Math.round((100 * kept) / found) : 0}%)  ` +
			`— ${past} past, ${later} later, ${undated} undated`,
	);
	if (result.suspects.length > 0) {
		console.log(
			`⚠ ${result.suspects.length} source(s) returned only past events — re-probe or demote: ${result.suspects.join(", ")}`,
		);
	}
	const { cacheHits: hits, cacheMisses: misses } = result;
	if (hits + misses > 0) {
		console.log(
			`→ extraction cache: ${hits} hit(s), ${misses} miss(es)` +
				`${hits > 0 ? ` — ${Math.round((100 * hits) / (hits + misses))}% of pages cost nothing` : ""}`,
		);
	}
	console.log(
		`✓ Scrape complete — ${kept} event(s) across ${result.sources.length} source(s) → ${relative(PROJECT_ROOT, dirname(curatedPath(ctx.city, "adapters", "x")))}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
