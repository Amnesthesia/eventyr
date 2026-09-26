import "./llmBootstrap.ts";
import { loadCityConfig } from "../config/city.js";
import { requireEnv } from "../config/env.js";
import { loadPipelineConfig } from "../config/load.js";
import { installUsageReporting } from "../io/usage.ts";
import { testUrl } from "../sources/testUrl.js";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const raw = args.includes("--raw");
const all = args.includes("--all");

if (!url) {
	console.error("Usage: pnpm test-adapter <url> [--raw] [--all]");
	process.exit(1);
}

const cityConfig = loadCityConfig(requireEnv("CITY"));
requireEnv("GOOGLE_API_KEY");
installUsageReporting(process.env.CITY);

testUrl(console, {
	url,
	cityConfig,
	config: loadPipelineConfig(),
	raw,
	all,
	fixturesDir: process.env.EVENTYR_SCRAPE_FIXTURES,
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
