import { ask } from "@dothingslol/llm";
import { chunkArray } from "@dothingslol/utils/concurrency";
import { loadPipelineConfig } from "../config/load.js";

import { dedupeEvents } from "../dedupe.js";
import type { ProviderOptions, SearchResult } from "./base.ts";
import { BaseProvider, splitIntoBatches } from "./base.ts";

export class GoogleProvider extends BaseProvider {
	readonly name = "google";
	readonly tiers = [
		"aggregators",
		"institutions",
		"independents",
		"open",
	] as const;
	private async generate(
		system: string,
		prompt: string,
		maxOutputTokens = 8000,
	): Promise<string> {
		return ask(prompt, {
			provider: "gemini",
			model: loadPipelineConfig().models.search.google.model as any,
			stage: "search/google",
			system,
			search: true,
			maxOutputTokens,
		});
	}

	async curate(
		rawText: string,
		cityName: string,
		label: string,
	): Promise<Record<string, unknown>[]> {
		if (process.env.DEBUG) console.debug(rawText);
		const rawBatches = splitIntoBatches(rawText);
		console.log(
			`  [${label}] Extracting… (${rawBatches.length} batch${rawBatches.length > 1 ? "es" : ""})`,
		);
		// Every batch in flight at once under llm's Gemini limiter; a failed
		// batch rejects the whole curation, as the Promise.all before it did.
		const rawExtracted = (
			await this.curateText(
				rawBatches,
				this.buildExtractSystem(cityName),
				16000,
				"curate/extract",
			)
		).flatMap((raw, i) =>
			this.parseEvents(raw, `${label} extract ${i + 1}/${rawBatches.length}`),
		);
		// Batches are extracted independently, so the same event mentioned in
		// two different source paragraphs (one bare, one with a venue suffix)
		// can land in separate batches and come out twice — dedupe here,
		// before enrichment batches ever see them.
		const extracted = dedupeEvents(rawExtracted);
		console.log(
			`  [${label}] ${extracted.length} events extracted` +
				(rawExtracted.length !== extracted.length
					? ` (${rawExtracted.length - extracted.length} duplicates dropped)`
					: ""),
		);
		if (extracted.length === 0) return [];

		const eventBatches = chunkArray(extracted, 20);
		const curated = (
			await this.curateText(
				eventBatches.map((batch) => JSON.stringify(batch)),
				this.buildFormatSystem(cityName),
			)
		).flatMap((raw, i) =>
			this.parseEvents(raw, `${label} curate ${i + 1}/${eventBatches.length}`),
		);
		console.log(`  [${label}] ${curated.length} events curated`);
		return curated;
	}

	private curateText(
		batches: string[],
		system: string,
		maxOutputTokens = 65536,
		stage = "curate/enrich",
	): Promise<string[]> {
		return ask(batches, {
			provider: "gemini",
			model: loadPipelineConfig().models.searchCurate.model as any,
			stage,
			system,
			maxOutputTokens,
		});
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { tier } = opts;
		const label = `google/${tier}`;
		console.log(`  [${label}] Searching…`);

		const system =
			tier === "open" ? this.buildOpenSystem(opts) : this.buildTierSystem(opts);
		const user =
			tier === "open" ? this.buildOpenUser(opts) : this.buildTierUser(opts);

		const rawText = await this.generate(system, user);
		this.validateRaw(rawText, label);
		console.log(`  [${label}] ${rawText.length} chars received`);

		const events = await opts.curate(rawText, opts.cityCfg.name, label);
		return { events };
	}
}
