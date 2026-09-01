import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";
import { PROJECT_ROOT, requireEnv, SOURCES_ROOT } from "./common.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import type { SourceResult } from "./providers/base.ts";
import { GoogleProvider } from "./providers/google.ts";
import { OpenAIProvider } from "./providers/openai.ts";

const CITY_NAME = requireEnv("CITY_NAME");
const CITY_KEY = requireEnv("CITY_KEY");

const DIGEST_WF = join(PROJECT_ROOT, ".github/workflows/digest.yml");

function extractDomain(sourceStr: string): string {
	const match = sourceStr.match(/\(([^)]+)\)/);
	if (match) {
		return match[1]
			.replace(/^https?:\/\//, "")
			.replace(/^www\./, "")
			.split("/")[0]
			.toLowerCase();
	}
	return sourceStr.toLowerCase();
}

function mergeSources(target: SourceResult, incoming: SourceResult): void {
	for (const tier of ["aggregators", "institutions", "independents"] as const) {
		const existing = new Set(target[tier].map(extractDomain));
		for (const source of incoming[tier]) {
			const domain = extractDomain(source);
			if (!existing.has(domain)) {
				target[tier].push(source);
				existing.add(domain);
			}
		}
	}
}

function loadExistingSources(): SourceResult {
	const outPath = join(SOURCES_ROOT, `${CITY_KEY}.yml`);
	if (!existsSync(outPath)) {
		return { aggregators: [], institutions: [], independents: [] };
	}
	const data = yaml.load(readFileSync(outPath, "utf-8")) as Record<
		string,
		unknown
	>;
	const src = (data?.sources ?? {}) as Record<
		string,
		{ name: string; domains?: string[] }[]
	>;
	// findSources works in "Name (domain)" prose; the file stores structured
	// entries. Render back so dedupe-on-domain keeps working.
	const asProse = (entries: { name: string; domains?: string[] }[] = []) =>
		entries.map((e) => (e.domains?.[0] ? `${e.name} (${e.domains[0]})` : e.name));
	return {
		aggregators: asProse(src.aggregators),
		institutions: asProse(src.institutions),
		independents: asProse(src.independents),
	};
}

async function discoverSources(existing: SourceResult): Promise<SourceResult> {
	const sources: SourceResult = {
		aggregators: [...existing.aggregators],
		institutions: [...existing.institutions],
		independents: [...existing.independents],
	};

	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const perplexityKey = process.env.PERPLEXITY_API_KEY;
	const googleKey = process.env.GOOGLE_API_KEY;

	if (!anthropicKey && !perplexityKey && !googleKey) {
		throw new Error(
			"✗ No API keys set (need at least one of ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GOOGLE_API_KEY).",
		);
	}

	if (anthropicKey) {
		mergeSources(
			sources,
			await new AnthropicProvider(anthropicKey).findSources(CITY_NAME),
		);
	}
	if (perplexityKey) {
		mergeSources(
			sources,
			await new OpenAIProvider(
				perplexityKey,
				"https://api.perplexity.ai",
				"sonar-pro",
				"perplexity",
			).findSources(CITY_NAME),
		);
	}
	if (googleKey) {
		mergeSources(
			sources,
			await new GoogleProvider(googleKey).findSources(CITY_NAME),
		);
	}

	for (const tier of ["aggregators", "institutions", "independents"] as const) {
		const before = existing[tier].length;
		const after = sources[tier].length;
		const added = after - before;
		console.log(
			`→ ${tier}: ${after} total (${added > 0 ? `+${added} new` : "no new"})`,
		);
	}
	return sources;
}

function writeCityFile(sources: SourceResult): void {
	mkdirSync(SOURCES_ROOT, { recursive: true });
	const outPath = join(SOURCES_ROOT, `${CITY_KEY}.yml`);

	// New sources always start as method: llm — a source only becomes a
	// scraper once probe-sources has verified a listing URL really yields
	// dated events.
	const toEntries = (list: string[]) =>
		list.map((raw) => {
			const domain = [...raw.matchAll(/\(([^)]*)\)/g)]
				.map((m) => m[1].trim())
				.filter((c) => /[a-z0-9-]+\.[a-z]{2,}/i.test(c))
				.pop();
			const name = raw.split(/\s+[—–]\s+|\s*\(/)[0].trim() || raw.trim();
			const host = domain
				?.replace(/^https?:\/\//, "")
				.split("/")[0]
				.toLowerCase()
				.replace(/^www\./, "");
			return { name, method: "llm", ...(host ? { domains: [host] } : {}) };
		});

	const cityData = {
		name: CITY_NAME,
		timezone: "Australia/Brisbane",
		sources: {
			aggregators: toEntries(sources.aggregators),
			institutions: toEntries(sources.institutions),
			independents: toEntries(sources.independents),
		},
	};

	writeFileSync(
		outPath,
		yaml.dump(cityData, { noRefs: true, sortKeys: false }),
		"utf-8",
	);
	console.log(`→ Written ${outPath}`);
}

function updateDigestWorkflow(): void {
	const content = readFileSync(DIGEST_WF, "utf-8");

	const pattern = /( {8}options:\n(?:( {10}- \S+\n))*)/;
	const match = content.match(pattern);
	if (!match) {
		console.log(
			`⚠ Could not locate options block in ${DIGEST_WF} — skipping workflow update.`,
		);
		return;
	}

	if (match[0].includes(`- ${CITY_KEY}`)) {
		console.log(
			`→ '${CITY_KEY}' already in dispatch options — skipping workflow update.`,
		);
		return;
	}

	const newEntry = `          - ${CITY_KEY}\n`;
	const updated = content.replace(pattern, (m) => m + newEntry);
	writeFileSync(DIGEST_WF, updated, "utf-8");
	console.log(`→ Added '${CITY_KEY}' to dispatch options in ${DIGEST_WF}`);
}

async function main(): Promise<void> {
	const outPath = join(SOURCES_ROOT, `${CITY_KEY}.yml`);
	const isUpdate = existsSync(outPath);

	console.log(
		`${isUpdate ? "Update" : "Add"} City — ${CITY_KEY} (${CITY_NAME})`,
	);
	console.log("=".repeat(50));

	const existing = loadExistingSources();
	const sources = await discoverSources(existing);
	writeCityFile(sources);
	updateDigestWorkflow();

	console.log(
		`✓ Done. Commit sources/${CITY_KEY}.yml${!isUpdate ? " and digest.yml" : ""} to complete the setup.`,
	);
}

await main();
