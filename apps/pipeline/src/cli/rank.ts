import "../llmBootstrap.ts";
import { runContextFromEnv } from "../config/context.js";
import { requireEnv } from "../config/env.js";
import { installUsageReporting } from "../io/usage.ts";
import { rank } from "../stages/rank.js";

requireEnv("GOOGLE_API_KEY");

async function main(): Promise<void> {
	installUsageReporting();
	const ctx = runContextFromEnv();
	await rank(ctx);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
