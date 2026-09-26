// AI search pass: for each enabled provider, searches every source tier
// (aggregators/institutions/independents, plus `open` for google/openai;
// perplexity is `open`-only) and writes raw curated JSON to
// data/{city}/{provider}/curated/{tier}[-music].json. Providers are search
// strategies over @dothingslol/llm (see CLAUDE.md "Provider architecture");
// their own progress lines are printed by BaseProvider.collect() itself and
// are unchanged by this refactor — only the provider *selection* and
// dispatch logic (this file's old main-guard) moves into a stage function.
import type { RunContext } from "../config/context.js";
import { AnthropicProvider } from "../search/anthropic.js";
import type { BaseProvider } from "../search/base.js";
import { GoogleProvider } from "../search/google.js";
import { OpenAIProvider } from "../search/openai.js";
import { PerplexityProvider } from "../search/perplexity.js";

export type ProviderName = "google" | "anthropic" | "openai" | "perplexity";

const ALIASES: Record<string, string> = {
	gemini: "google",
	claude: "anthropic",
	chatgpt: "openai",
};

function resolveAlias(name: string): string {
	return ALIASES[name] ?? name;
}

/**
 * One table instead of a build function per provider: the env var, the
 * constructor, and whether it can be turned off all live in one place, so
 * adding or disabling a provider is a single edit.
 *
 * `google` has no `required` counterpart missing — Gemini is not just a
 * search provider, it also does curation, ranking, annotation and dedupe, so
 * its key is required regardless of whether google is used for *search*.
 */
function providerTable(
	google: GoogleProvider,
	debug: boolean,
): Record<ProviderName, { env: string; make: () => BaseProvider }> {
	return {
		google: { env: "GOOGLE_API_KEY", make: () => google },
		anthropic: {
			env: "ANTHROPIC_API_KEY",
			make: () => new AnthropicProvider(),
		},
		openai: {
			env: "OPENAI_API_KEY",
			make: () => new OpenAIProvider(undefined, debug),
		},
		perplexity: {
			env: "PERPLEXITY_API_KEY",
			make: () => new PerplexityProvider(),
		},
	};
}

const PROVIDER_NAMES = [
	"google",
	"anthropic",
	"openai",
	"perplexity",
] as const satisfies readonly ProviderName[];

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

export interface CollectSearchOptions {
	/** `pnpm collect <name>` — collect via this one provider only, ignoring
	 * `allow`/`deny`. */
	only?: string;
	/** `PROVIDERS` env: allowlist — only these run. */
	allow?: string;
	/** `DISABLE_PROVIDERS` env: denylist — everything else runs. */
	deny?: string;
	/**
	 * Whether a provider's API key env var is set. Injected (rather than read
	 * from `process.env` here) so this stage never reads env itself — the CLI
	 * is the only place that does.
	 */
	hasKey: (envVar: string) => boolean;
	/**
	 * Forwarded unread to selectTiers (per-provider *_TIERS) and to the
	 * providers' own DEBUG dump — this stage never inspects it itself.
	 */
	env: NodeJS.ProcessEnv;
}

export interface CollectSearchResult {
	cityName: string;
	/** Providers that actually ran, in run order. */
	providerNames: ProviderName[];
	/** Only populated in the multi-provider (no `only`) path — the CLI's
	 * "not used: …" line is empty in single-provider mode today, and staying
	 * empty here keeps that true without the CLI re-deriving it. */
	skipped: ProviderName[];
}

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
function selectedProviderNames(
	table: Record<ProviderName, { env: string }>,
	opts: Pick<CollectSearchOptions, "allow" | "deny" | "hasKey">,
): ProviderName[] {
	const allow = parseList(opts.allow);
	const deny = new Set(parseList(opts.deny));
	const chosen = (allow.length > 0 ? allow : PROVIDER_NAMES).filter(
		(name) => !deny.has(name),
	);

	const withKeys = chosen.filter((name) => {
		const hasKey = opts.hasKey(table[name].env);
		if (!hasKey && allow.includes(name)) {
			throw new Error(
				`Provider "${name}" was requested but ${table[name].env} is not set.`,
			);
		}
		return hasKey;
	});

	if (withKeys.length === 0) {
		throw new Error(
			"No search providers enabled. Set at least one API key, and check PROVIDERS/DISABLE_PROVIDERS.",
		);
	}
	return withKeys;
}

function buildProvider(
	table: Record<ProviderName, { env: string; make: () => BaseProvider }>,
	name: string,
	hasKey: (envVar: string) => boolean,
): BaseProvider {
	const resolved = resolveAlias(name.toLowerCase());
	if (!PROVIDER_NAMES.includes(resolved as ProviderName)) {
		throw new Error(
			`Unknown provider: "${name}". Valid names: ${PROVIDER_NAMES.join(", ")} (aliases: gemini, claude, chatgpt)`,
		);
	}
	const spec = table[resolved as ProviderName];
	if (!hasKey(spec.env)) throw new Error(`${spec.env} not set`);
	return spec.make();
}

export async function collectSearch(
	ctx: RunContext,
	opts: CollectSearchOptions,
): Promise<CollectSearchResult> {
	// Curation always uses Gemini 2.5 Flash regardless of search provider.
	const debug = Boolean(opts.env.DEBUG);
	const google = new GoogleProvider(debug);
	const table = providerTable(google, debug);

	let providers: BaseProvider[];
	let providerNames: ProviderName[];
	let skipped: ProviderName[] = [];
	if (opts.only) {
		providerNames = [resolveAlias(opts.only.toLowerCase()) as ProviderName];
		providers = [buildProvider(table, opts.only, opts.hasKey)];
	} else {
		providerNames = selectedProviderNames(table, opts);
		skipped = PROVIDER_NAMES.filter((n) => !providerNames.includes(n));
		providers = providerNames.map((name) => table[name].make());
		// Printed here, not by the CLI from the returned result, because it
		// must land before the providers' own progress lines below — the CLI
		// only learns the selection once this function has already awaited
		// them.
		ctx.log.log(
			`→ Search providers: ${providerNames.join(", ")}` +
				`${skipped.length > 0 ? `  (not used: ${skipped.join(", ")})` : ""}`,
		);
	}

	await Promise.all(
		providers.map((p) =>
			p.collect(
				ctx.city,
				ctx.cityConfig,
				ctx.week.monday,
				ctx.week.sunday,
				ctx.force,
				google.curate.bind(google),
				opts.env,
			),
		),
	);

	return { cityName: ctx.cityConfig.name, providerNames, skipped };
}
