import { fmtDate, getWeekRange, loadCityConfig, requireEnv } from "./common.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import type { BaseProvider } from "./providers/base.ts";
import { installUsageReporting } from "./providers/gemini.ts";
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

type ProviderName = "google" | "anthropic" | "openai" | "perplexity";

/**
 * One table instead of a build function per provider: the env var, the
 * constructor, and whether it can be turned off all live in one place, so
 * adding or disabling a provider is a single edit.
 *
 * `google` has no `optional` flag because Gemini is not just a search
 * provider — it also does curation, ranking, annotation and dedupe, so the key
 * is required regardless of whether google is used for *search*.
 */
const PROVIDERS: Record<
	ProviderName,
	{ env: string; make: (key: string) => BaseProvider; required?: boolean }
> = {
	google: {
		env: "GOOGLE_API_KEY",
		make: (key) => new GoogleProvider(key),
		required: true,
	},
	anthropic: {
		env: "ANTHROPIC_API_KEY",
		make: (key) => new AnthropicProvider(key),
	},
	openai: { env: "OPENAI_API_KEY", make: (key) => new OpenAIProvider(key) },
	perplexity: {
		env: "PERPLEXITY_API_KEY",
		make: (key) => new PerplexityProvider(key),
	},
};

const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];

/**
 * Which providers to use for search, independent of which keys are present.
 *
 * Key presence alone is a bad switch: turning a provider off meant deleting
 * its key, and turning it back on meant finding the key again. Two env vars
 * decide instead, and a key can stay in .env while its provider sits idle:
 *
 *   PROVIDERS=google,anthropic     allowlist — only these run
 *   DISABLE_PROVIDERS=openai       denylist — everything else runs
 *
 * A provider still needs its key to run; naming one without a key is an error
 * rather than a silent skip, because silently skipping is how a run quietly
 * loses half its coverage.
 */
function parseList(value: string | undefined): ProviderName[] {
	return (value ?? "")
		.split(",")
		.map((n) => resolveAlias(n.trim().toLowerCase()))
		.filter(Boolean)
		.map((name) => {
			if (!PROVIDER_NAMES.includes(name as ProviderName)) {
				throw new Error(
					`Unknown provider "${name}". Valid names: ${PROVIDER_NAMES.join(", ")} (aliases: gemini, claude, chatgpt)`,
				);
			}
			return name as ProviderName;
		});
}

function selectedProviderNames(): ProviderName[] {
	const allow = parseList(process.env.PROVIDERS);
	const deny = new Set(parseList(process.env.DISABLE_PROVIDERS));
	const chosen = (allow.length > 0 ? allow : PROVIDER_NAMES).filter(
		(name) => !deny.has(name),
	);

	const withKeys = chosen.filter((name) => {
		const hasKey = Boolean(process.env[PROVIDERS[name].env]);
		if (!hasKey && allow.includes(name)) {
			throw new Error(
				`Provider "${name}" was requested but ${PROVIDERS[name].env} is not set.`,
			);
		}
		return hasKey;
	});

	if (withKeys.length === 0) {
		throw new Error(
			`No search providers enabled. Set at least one API key, and check PROVIDERS/DISABLE_PROVIDERS.`,
		);
	}
	return withKeys;
}

function buildProviders(names: ProviderName[]): BaseProvider[] {
	return names.map((name) =>
		PROVIDERS[name].make(process.env[PROVIDERS[name].env] as string),
	);
}

function buildProvider(name: string): BaseProvider {
	const resolved = resolveAlias(name.toLowerCase());
	if (!PROVIDER_NAMES.includes(resolved as ProviderName)) {
		throw new Error(
			`Unknown provider: "${name}". Valid names: ${PROVIDER_NAMES.join(", ")} (aliases: gemini, claude, chatgpt)`,
		);
	}
	const spec = PROVIDERS[resolved as ProviderName];
	const key = process.env[spec.env];
	if (!key) throw new Error(`${spec.env} not set`);
	return spec.make(key);
}

async function main(): Promise<void> {
	installUsageReporting();
	const cityName = cityCfg.name;
	console.log(
		`Collecting — ${cityName} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);

	let providers: BaseProvider[];
	if (PROVIDER_ARG) {
		providers = [buildProvider(PROVIDER_ARG)];
	} else {
		const names = selectedProviderNames();
		const skipped = PROVIDER_NAMES.filter((n) => !names.includes(n));
		console.log(
			`→ Search providers: ${names.join(", ")}` +
				`${skipped.length > 0 ? `  (not used: ${skipped.join(", ")})` : ""}`,
		);
		providers = buildProviders(names);
	}

	await Promise.all(
		providers.map((p) =>
			p.collect(CITY, cityCfg, monday, sunday, FORCE, curate),
		),
	);
	console.log("✓ Collection complete.");
}

await main();
