import "./llmBootstrap.ts";
import { loadPipelineConfig } from "../config/load.js";
import { installUsageReporting } from "../io/usage.ts";
import { discoverSources } from "../sources/discover.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
	args
		.find((a) => a.startsWith(`--${name}=`))
		?.split("=")
		.slice(1)
		.join("=");

const cityArg = flag("city");
if (!cityArg || cityArg.includes(",")) {
	console.error(
		"discover-sources runs for one city at a time — pass --city=<key>, e.g. --city=brisbane.",
	);
	process.exit(1);
}
const apply = args.includes("--apply");

async function main(): Promise<void> {
	installUsageReporting(process.env.CITY);
	if (!process.env.GOOGLE_API_KEY) {
		throw new Error("GOOGLE_API_KEY env var is required");
	}
	await discoverSources(console, {
		city: cityArg as string,
		apply,
		config: loadPipelineConfig(),
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
