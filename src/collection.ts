import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import {
	fmtDate,
	getWeekRange,
	loadCityConfig,
	PROJECT_ROOT,
	rawPath,
	requireEnv,
	toISODate,
} from "./common.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import type { BaseProvider, ProviderOptions } from "./providers/base.ts";
import { GoogleProvider } from "./providers/google.ts";
import { OpenAIProvider } from "./providers/openai.ts";

const VALID_TIERS = [
	"aggregators",
	"institutions",
	"independents",
	"open",
] as const;
type Tier = (typeof VALID_TIERS)[number];

const CITY = requireEnv("CITY");

const TIER = (process.argv[2] || process.env.TIER || "") as Tier;
if (!VALID_TIERS.includes(TIER)) {
	throw new Error(
		"Usage: collection.ts <aggregators|institutions|independents|open>\n" +
			"       (or set TIER env var)",
	);
}

const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);
const cityCfg = loadCityConfig(CITY);
const { monday, sunday } = getWeekRange();

function alreadyCollected(provider: string): boolean {
	const path = rawPath(CITY, provider, TIER);
	if (!existsSync(path)) return false;
	try {
		const payload = JSON.parse(readFileSync(path, "utf-8"));
		return payload.week_start === toISODate(monday);
	} catch {
		return false;
	}
}

function writeRaw(provider: string, rawText: string): void {
	const payload = {
		city_key: CITY,
		tier: TIER,
		week_start: toISODate(monday),
		week_end: toISODate(sunday),
		raw_text: rawText,
	};
	const path = rawPath(CITY, provider, TIER);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
	console.log(`  → Written ${relative(PROJECT_ROOT, path)}`);
}

async function runProvider(provider: BaseProvider): Promise<void> {
	if (!FORCE && alreadyCollected(provider.name)) {
		console.log(`  → [${provider.name}/${TIER}] Already collected — skipping`);
		return;
	}
	try {
		const opts: ProviderOptions = {
			cityCfg,
			tier: TIER,
			weekStart: monday,
			weekEnd: sunday,
		};
		const { rawText } = await provider.searchEvents(opts);
		writeRaw(provider.name, rawText);
	} catch (err) {
		console.error(`  ⚠ [${provider.name}/${TIER}] ${(err as Error).message}`);
	}
}

async function main(): Promise<void> {
	const cityName = cityCfg.name;
	console.log(
		`[${TIER}] ${cityName} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);

	const providers: BaseProvider[] = [];

	if (TIER !== "open" && process.env.ANTHROPIC_API_KEY) {
		providers.push(new AnthropicProvider(process.env.ANTHROPIC_API_KEY));
	}
	if (process.env.PERPLEXITY_API_KEY) {
		providers.push(
			new OpenAIProvider(
				process.env.PERPLEXITY_API_KEY,
				"https://api.perplexity.ai",
				"sonar-pro",
				"perplexity",
			),
		);
	}
	if (process.env.GOOGLE_API_KEY) {
		providers.push(new GoogleProvider(process.env.GOOGLE_API_KEY));
	}

	if (providers.length === 0) {
		if (TIER === "open") {
			console.log("  → [open] No provider keys — skipping open tier");
			return;
		}
		throw new Error(
			"✗ No API keys set (need at least one of ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GOOGLE_API_KEY).",
		);
	}

	await Promise.all(providers.map(runProvider));
	console.log(`  ✓ [${TIER}] Collection complete.`);
}

await main();
