import { GoogleGenAI } from "@google/genai";
import { dedupeEvents } from "../common.ts";
import type {
	ProviderOptions,
	SearchFocus,
	SearchResult,
	SourceResult,
} from "./base.ts";
import { BaseProvider, chunkArray, splitIntoBatches } from "./base.ts";

const SEARCH_MODEL = "gemini-3.1-flash-lite";
const DISCOVERY_MODEL = "gemini-3.5-flash";
const CURATE_MODEL = "gemini-3.1-flash-lite";
const RETRY_DELAYS = [10_000, 30_000, 90_000];

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

	private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
		for (let i = 0; i < RETRY_DELAYS.length; i++) {
			try {
				return await fn();
			} catch (err) {
				const code =
					(err as { status?: number; code?: number }).status ??
					(err as { status?: number; code?: number }).code;
				if (code !== 503 || i === RETRY_DELAYS.length - 1) throw err;
				const delay = RETRY_DELAYS[i];
				console.error(
					`  ⚠ Gemini 503 — retrying in ${delay / 1000}s (attempt ${i + 1}/${RETRY_DELAYS.length})…`,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
		return fn();
	}

	private async generate(
		system: string,
		prompt: string,
		maxOutputTokens = 8000,
	): Promise<string> {
		const response = await this.withRetry(() =>
			this.ai.models.generateContent({
				model: SEARCH_MODEL,
				contents: prompt,
				config: {
					systemInstruction: system,
					tools: [{ googleSearch: {} }],
					maxOutputTokens,
				},
			}),
		);
		return response.text ?? "";
	}

	private async generatePlain(
		system: string,
		prompt: string,
		maxOutputTokens = 4000,
	): Promise<string> {
		const response = await this.withRetry(() =>
			this.ai.models.generateContent({
				model: DISCOVERY_MODEL,
				contents: prompt,
				config: {
					systemInstruction: system,
					maxOutputTokens,
				},
			}),
		);
		return response.text ?? "";
	}

	async curate(
		rawText: string,
		cityName: string,
		label: string,
		focus: SearchFocus,
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
					const raw = await this.curateText(batch, extractSystem, 16000);
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

		const enrichSystem = this.buildFormatSystem(cityName, focus);
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
	): Promise<string> {
		const response = await this.withRetry(() =>
			this.ai.models.generateContent({
				model: CURATE_MODEL,
				contents: rawText,
				config: {
					systemInstruction,
					maxOutputTokens,
				},
			}),
		);
		return response.text ?? "";
	}

	async searchEvents(opts: ProviderOptions): Promise<SearchResult> {
		const { tier, focus } = opts;
		const tierKey = focus === "music" ? `${tier}-music` : tier;
		const label = `google/${tierKey}`;
		console.log(`  [${label}] Searching…`);

		const system =
			tier === "open" ? this.buildOpenSystem(opts) : this.buildTierSystem(opts);
		const user =
			tier === "open" ? this.buildOpenUser(opts) : this.buildTierUser(opts);

		const rawText = await this.generate(system, user);
		this.validateRaw(rawText, label);
		console.log(`  [${label}] ${rawText.length} chars received`);

		const events = await opts.curate(rawText, opts.cityCfg.name, label, focus);
		return { events };
	}

	async findSources(cityName: string): Promise<SourceResult> {
		const label = "google";
		console.log(`[${label}] Discovering event sources for ${cityName}…`);
		const raw = await this.generatePlain(
			this.buildFindSourcesSystem(cityName),
			this.buildFindSourcesUser(cityName),
		);
		return this.parseSourcesJson(raw, label);
	}
}
