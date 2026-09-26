import "../llmBootstrap.ts";
import { runContextFromEnv } from "../config/context.js";
import { installUsageReporting } from "../io/usage.ts";
import { curate } from "../stages/curate.js";

async function main(): Promise<void> {
	installUsageReporting();
	const ctx = runContextFromEnv();
	await curate(ctx, {
		googleApiKey: process.env.GOOGLE_API_KEY,
		googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
