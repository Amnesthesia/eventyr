import "../llmBootstrap.ts";
import { runContextFromEnv } from "../config/context.js";
import { installUsageReporting } from "../io/usage.ts";
import { canonicaliseVenues } from "../stages/venues.js";

async function main(): Promise<void> {
	installUsageReporting();
	const ctx = runContextFromEnv();
	await canonicaliseVenues(ctx, { googleApiKey: process.env.GOOGLE_API_KEY });
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
