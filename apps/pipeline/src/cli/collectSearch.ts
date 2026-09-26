import "../llmBootstrap.ts";
import { runContextFromEnv } from "../config/context.js";
import { requireEnv } from "../config/env.js";
import { fmtDate } from "../config/week.js";
import { installUsageReporting } from "../io/usage.ts";
import { collectSearch } from "../stages/collectSearch.js";

requireEnv("GOOGLE_API_KEY");

async function main(): Promise<void> {
	installUsageReporting();
	const ctx = runContextFromEnv();
	console.log(
		`Collecting — ${ctx.cityConfig.name} — ${fmtDate(ctx.week.monday, ctx.cityConfig.timezone)} to ${fmtDate(ctx.week.sunday, ctx.cityConfig.timezone)}`,
	);

	// Optional: pnpm collect [provider]  — e.g. "pnpm collect gemini"
	const only = process.argv[2] || undefined;

	await collectSearch(ctx, {
		only,
		allow: process.env.PROVIDERS,
		deny: process.env.DISABLE_PROVIDERS,
		hasKey: (envVar) => Boolean(process.env[envVar]),
	});

	console.log("✓ Collection complete.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
