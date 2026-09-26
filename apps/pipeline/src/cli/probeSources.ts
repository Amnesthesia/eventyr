import "../llmBootstrap.ts";
import { loadPipelineConfig } from "../config/load.js";
import { installUsageReporting, reportGeminiUsage } from "../io/usage.ts";
import { probeSources } from "../sources/probe.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
	args
		.find((a) => a.startsWith(`--${name}=`))
		?.split("=")
		.slice(1)
		.join("=");
const has = (name: string): boolean => args.includes(`--${name}`);

const cityArg = flag("city");
if (!cityArg || cityArg.includes(",")) {
	console.error(
		"probe-sources runs for one city at a time — pass --city=<key>, e.g. --city=brisbane.",
	);
	process.exit(1);
}
const reportOnly = has("report-only");

async function main(): Promise<void> {
	installUsageReporting();
	// --report-only re-derives from results.jsonl with no model calls, so it
	// needs no key.
	if (!reportOnly && !process.env.GOOGLE_API_KEY) {
		throw new Error("GOOGLE_API_KEY env var is required");
	}
	await probeSources(console, {
		city: cityArg as string,
		only: flag("only")
			?.split(",")
			.map((s) => s.trim().toLowerCase()),
		limit: Number(flag("limit") ?? "0"),
		apply: has("apply"),
		force: has("force"),
		reportOnly,
		config: loadPipelineConfig(),
	});
}

try {
	await main();
} catch (err) {
	console.error(err);
	process.exit(1);
}
// Exit explicitly. Everything this script needed to write has been written
// by now, and an abandoned fetch left pending by the per-source timeout
// would otherwise keep the process alive or trip Node's unsettled-await
// exit code.
reportGeminiUsage();
process.exit(0);
