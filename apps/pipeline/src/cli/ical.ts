import { runContextFromEnv } from "../config/context.js";
import { publishIcal } from "../stages/ical.js";

async function main(): Promise<void> {
	const ctx = runContextFromEnv();
	await publishIcal(ctx);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
