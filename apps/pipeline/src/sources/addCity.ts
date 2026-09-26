// Creates the two pieces of plumbing a new city needs: a sources/{city}.yml
// skeleton, and an entry in digest.yml's dispatch options.
//
// It deliberately does NOT discover sources. That used to fan out to
// Anthropic, Perplexity and Google and merge the prose each returned, which
// discover.ts later measured as worthless — see its header: Claude wrapped its
// JSON in prose, GPT-5 returned empty output, and neither found anything
// Google's grounded answer had missed. `pnpm discover-sources` does the same
// job in twelve narrow niche calls and reaches the long tail a broad "list
// this city's event sources" question never gets to.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { isValidTimeZone } from "../config/city.js";
import type { Logger } from "../config/context.js";
import { PROJECT_ROOT, SOURCES_ROOT } from "../config/paths.js";

const DIGEST_WF = join(PROJECT_ROOT, ".github/workflows/digest.yml");

/** The header comment yaml.dump cannot produce, and the centre placeholder a
 * new city must fill in before its first curate. */
function header(cityName: string): string {
	return `# Event sources for ${cityName}.
#
# Each entry declares how it is collected:
#   method: scraper — we fetch its listingUrls ourselves (src/adapters/).
#   method: llm     — no verified listing page, so LLM web search covers it.
#
# Every source starts as method: llm. Only probe-sources promotes one, once
# it has verified a listing URL actually yields dated events.
#
# TODO: add this city's centre. Until it is here, curate.ts keeps every event
# and cannot tell a local one from an interstate one (src/locality.ts).
# Deliberately not written as a placeholder: coordinates that are present but
# wrong are worse than absent, since every real venue is then "somewhere else".
# radiusKm must stay smaller than the distance to the nearest other city in
# sources/, or the two will swallow each other's events.
#
# currency is how prices are written on the site; change it for a city
# outside Australia.
#
# centre:
#   lat: -27.4698
#   lng: 153.0251
#   radiusKm: 50
`;
}

function writeCityFile(
	log: Logger,
	cityName: string,
	cityKey: string,
	cityTimezone: string,
): boolean {
	mkdirSync(SOURCES_ROOT, { recursive: true });
	const outPath = join(SOURCES_ROOT, `${cityKey}.yml`);
	if (existsSync(outPath)) {
		log.log(`→ ${outPath} already exists — left untouched.`);
		return false;
	}

	const cityData = {
		name: cityName,
		timezone: cityTimezone,
		currency: "AUD",
		sources: { aggregators: [], institutions: [], independents: [] },
	};
	writeFileSync(
		outPath,
		header(cityName) + yaml.dump(cityData, { noRefs: true, sortKeys: false }),
		"utf-8",
	);
	log.log(`→ Written ${outPath}`);
	return true;
}

function updateDigestWorkflow(log: Logger, cityKey: string): void {
	const content = readFileSync(DIGEST_WF, "utf-8");

	const pattern = /( {8}options:\n(?:( {10}- \S+\n))*)/;
	const match = content.match(pattern);
	if (!match) {
		log.log(
			`⚠ Could not locate options block in ${DIGEST_WF} — skipping workflow update.`,
		);
		return;
	}

	if (match[0].includes(`- ${cityKey}`)) {
		log.log(
			`→ '${cityKey}' already in dispatch options — skipping workflow update.`,
		);
		return;
	}

	const newEntry = `          - ${cityKey}\n`;
	const updated = content.replace(pattern, (m) => m + newEntry);
	writeFileSync(DIGEST_WF, updated, "utf-8");
	log.log(`→ Added '${cityKey}' to dispatch options in ${DIGEST_WF}`);
}

export interface AddCityOptions {
	cityName: string;
	cityKey: string;
	cityTimezone: string;
}

export interface AddCityResult {
	created: boolean;
}

export async function addCity(
	log: Logger,
	opts: AddCityOptions,
): Promise<AddCityResult> {
	const { cityName, cityKey, cityTimezone } = opts;
	// Required, with no default: the zone decides every published time, and
	// a wrong one shifts them all silently. The same check loadCityConfig
	// applies.
	if (!isValidTimeZone(cityTimezone)) {
		throw new Error(
			`CITY_TIMEZONE ${JSON.stringify(cityTimezone)} is not a valid IANA zone (e.g. "Australia/Sydney").`,
		);
	}

	log.log(`Add City — ${cityKey} (${cityName})`);
	log.log("=".repeat(50));

	const created = writeCityFile(log, cityName, cityKey, cityTimezone);
	updateDigestWorkflow(log, cityKey);

	if (created) {
		log.log("\nNext:");
		log.log(`  1. Set the real centre coordinates in sources/${cityKey}.yml`);
		log.log(
			`  2. pnpm discover-sources --city=${cityKey} --apply   # find sources`,
		);
		log.log(
			`  3. pnpm probe-sources --city=${cityKey} --apply      # promote the scrapable ones`,
		);
	}
	log.log(
		`✓ Done. Commit sources/${cityKey}.yml${created ? " and digest.yml" : ""}.`,
	);
	return { created };
}
