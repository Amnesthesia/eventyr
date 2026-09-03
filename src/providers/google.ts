import { GoogleGenAI } from "@google/genai";
import { dedupeEvents } from "../common.ts";
import type { ProviderOptions, SearchResult } from "./base.ts";
import { BaseProvider, chunkArray, splitIntoBatches } from "./base.ts";
import { geminiText } from "./gemini.ts";

const SEARCH_MODEL = "gemini-3.1-flash-lite";
const CURATE_MODEL = "gemini-3.1-flash-lite";

export class GoogleProvider extends BaseProvider {
	readonly name = "google";
	readonly tiers = [
		"aggregators",
		"institutions",
		"independents",
		"open",
	] as const;
	private ai: GoogleGenAI;

	constructor(apiKey: string) {
		super();
		this.ai = new GoogleGenAI({ apiKey });
	}

	private async generate(
		system: string,
		prompt: string,
		maxOutputTokens = 8000,
	): Promise<string> {
		return geminiText(this.ai, {
			stage: "search/google",
			model: SEARCH_MODEL,
			contents: prompt,
			systemInstruction: system,
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
		const extractSystem = this.buildExtractSystem(cityName);
		const rawExtracted = (
			await Promise.all(
				rawBatches.map(async (batch, i) => {
					const batchLabel = `${label} extract ${i + 1}/${rawBatches.length}`;
					const raw = await this.curateText(
						batch,
						extractSystem,
						16000,
						"curate/extract",
					);
					return this.parseEvents(raw, batchLabel);
				}),
			)
		).flat();
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

		const enrichSystem = this.buildFormatSystem(cityName);
		const eventBatches = chunkArray(extracted, 20);
		const curated = (
			await Promise.all(
				eventBatches.map(async (batch, i) => {
					const batchLabel = `${label} curate ${i + 1}/${eventBatches.length}`;
					const raw = await this.curateText(
						JSON.stringify(batch),
						enrichSystem,
					);
					return this.parseEvents(raw, batchLabel);
				}),
			)
		).flat();
		console.log(`  [${label}] ${curated.length} events curated`);
		return curated;
	}

	private async curateText(
		rawText: string,
		systemInstruction: string,
		maxOutputTokens = 65536,
		stage = "curate/enrich",
	): Promise<string> {
		return geminiText(this.ai, {
			stage,
			model: CURATE_MODEL,
			contents: rawText,
			systemInstruction,
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
