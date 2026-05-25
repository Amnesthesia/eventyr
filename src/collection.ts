import { fmtDate, getWeekRange, loadCityConfig, requireEnv } from "./common.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import type { BaseProvider } from "./providers/base.ts";
import { GoogleProvider } from "./providers/google.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { PerplexityProvider } from "./providers/perplexity.ts";

const CITY = requireEnv("CITY");
const GOOGLE_API_KEY = requireEnv("GOOGLE_API_KEY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);
const cityCfg = loadCityConfig(CITY);
const { monday, sunday } = getWeekRange();

// Curation always uses Gemini 2.5 Flash regardless of search provider
const google = new GoogleProvider(GOOGLE_API_KEY);
const curate = google.curate.bind(google);

// Optional: pnpm collect [provider]  — e.g. "pnpm collect gemini"
const PROVIDER_ARG = (process.argv[2] ?? "").toLowerCase();

const ALIASES: Record<string, string> = {
	gemini: "google",
	claude: "anthropic",
	chatgpt: "openai",
};

function resolveAlias(name: string): string {
	return ALIASES[name] ?? name;
}

function buildAllProviders(): BaseProvider[] {
	const providers: BaseProvider[] = [];
	if (process.env.ANTHROPIC_API_KEY) {
		providers.push(new AnthropicProvider(process.env.ANTHROPIC_API_KEY));
	}
	if (process.env.PERPLEXITY_API_KEY) {
		providers.push(new PerplexityProvider(process.env.PERPLEXITY_API_KEY));
	}
	if (process.env.OPENAI_API_KEY) {
		providers.push(new OpenAIProvider(process.env.OPENAI_API_KEY));
	}
	providers.push(new GoogleProvider(GOOGLE_API_KEY));
	return providers;
}

function buildProvider(name: string): BaseProvider {
	switch (resolveAlias(name)) {
		case "google":
			return new GoogleProvider(GOOGLE_API_KEY);
		case "perplexity":
			if (!process.env.PERPLEXITY_API_KEY)
				throw new Error("PERPLEXITY_API_KEY not set");
			return new PerplexityProvider(process.env.PERPLEXITY_API_KEY);
		case "anthropic":
			if (!process.env.ANTHROPIC_API_KEY)
				throw new Error("ANTHROPIC_API_KEY not set");
			return new AnthropicProvider(process.env.ANTHROPIC_API_KEY);
		case "openai":
			if (!process.env.OPENAI_API_KEY)
				throw new Error("OPENAI_API_KEY not set");
			return new OpenAIProvider(process.env.OPENAI_API_KEY);
		default:
			throw new Error(
				`Unknown provider: "${name}". Valid names: google (gemini), perplexity, anthropic (claude), openai (chatgpt)`,
			);
	}
}

async function main(): Promise<void> {
	const cityName = cityCfg.name;
	console.log(
		`Collecting — ${cityName} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);

	const providers = PROVIDER_ARG
		? [buildProvider(PROVIDER_ARG)]
		: buildAllProviders();

	await Promise.all(
		providers.map((p) =>
			p.collect(CITY, cityCfg, monday, sunday, FORCE, curate),
		),
	);
	console.log("✓ Collection complete.");
}

await main();
