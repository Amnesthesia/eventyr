import { runContextFromEnv } from "../config/context.js";
import { geocode } from "../stages/geocode.js";

async function main(): Promise<void> {
	const ctx = runContextFromEnv();
	await geocode(ctx);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
