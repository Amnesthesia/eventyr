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
import { PROJECT_ROOT, requireEnv, SOURCES_ROOT } from "./common.ts";

const CITY_NAME = requireEnv("CITY_NAME");
const CITY_KEY = requireEnv("CITY_KEY");

const DIGEST_WF = join(PROJECT_ROOT, ".github/workflows/digest.yml");

/** The header comment yaml.dump cannot produce, and the centre placeholder a
 * new city must fill in before its first curate. */
const HEADER = `# Event sources for ${CITY_NAME}.
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
# centre:
#   lat: -27.4698
#   lng: 153.0251
#   radiusKm: 50
`;

function writeCityFile(): boolean {
	mkdirSync(SOURCES_ROOT, { recursive: true });
	const outPath = join(SOURCES_ROOT, `${CITY_KEY}.yml`);
	if (existsSync(outPath)) {
		console.log(`→ ${outPath} already exists — left untouched.`);
		return false;
	}

	const cityData = {
		name: CITY_NAME,
		timezone: "Australia/Brisbane",
		sources: { aggregators: [], institutions: [], independents: [] },
	};
	writeFileSync(
		outPath,
		HEADER + yaml.dump(cityData, { noRefs: true, sortKeys: false }),
		"utf-8",
	);
	console.log(`→ Written ${outPath}`);
	return true;
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

function main(): void {
	console.log(`Add City — ${CITY_KEY} (${CITY_NAME})`);
	console.log("=".repeat(50));

	const created = writeCityFile();
	updateDigestWorkflow();

	if (created) {
		console.log("\nNext:");
		console.log(
			`  1. Set the real centre coordinates in sources/${CITY_KEY}.yml`,
		);
		console.log(
			`  2. pnpm discover-sources --city=${CITY_KEY} --apply   # find sources`,
		);
		console.log(
			`  3. pnpm probe-sources --city=${CITY_KEY} --apply      # promote the scrapable ones`,
		);
	}
	console.log(
		`✓ Done. Commit sources/${CITY_KEY}.yml${created ? " and digest.yml" : ""}.`,
	);
}

main();
