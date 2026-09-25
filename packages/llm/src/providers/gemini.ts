// Gemini transport: maps AskOptions onto exactly the generateContent call the
// pipeline made before 1.6, key order included, so the request JSON is
// byte-identical (verified by scripts/llm-parity.mjs).

import type {
	GenerateContentConfig,
	GenerateContentResponse,
	GoogleGenAI,
} from "@google/genai";
import type { ReplayRequest } from "../replay.ts";
import type { AskOptions, StageUsage } from "../types.ts";

/**
 * The part of the config that the old call sites passed as `extraConfig`:
 * JSON mode, thinking, and anything provider-specific. Undefined when empty,
 * so the replay line omits the key exactly as before.
 */
export function extraConfigOf(
	opts: AskOptions,
): Record<string, unknown> | undefined {
	const extra: Record<string, unknown> = {};
	if (opts.json) extra.responseMimeType = "application/json";
	if (opts.thinking === "off") extra.thinkingConfig = { thinkingBudget: 0 };
	else if (opts.thinking === "low")
		extra.thinkingConfig = { thinkingLevel: "low" };
	Object.assign(extra, opts.providerOptions ?? {});
	return Object.keys(extra).length ? extra : undefined;
}

/** What the replay line and the deterministic replay usage are computed
 * from: the old wrapper's GeminiCallOptions shape. */
export function replayRequestOf(
	stage: string,
	model: string,
	contents: string,
	opts: AskOptions,
): ReplayRequest {
	return {
		stage,
		model,
		contents,
		systemInstruction: opts.system,
		maxOutputTokens: opts.maxOutputTokens,
		temperature: opts.temperature,
		search: opts.search,
		extraConfig: extraConfigOf(opts),
	};
}

/** systemInstruction, tools, maxOutputTokens, temperature, then the extras —
 * the order the old wrapper spread them in. */
export function geminiConfig(opts: AskOptions): GenerateContentConfig {
	return {
		...(opts.system ? { systemInstruction: opts.system } : {}),
		...(opts.search ? { tools: [{ googleSearch: {} }] } : {}),
		...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
		...(opts.temperature !== undefined
			? { temperature: opts.temperature }
			: {}),
		...(extraConfigOf(opts) ?? {}),
	};
}

export interface GeminiResult {
	text: string;
	usage: Partial<StageUsage>;
	finishReason: string | null;
}

/** Usage and text out of one response, the same fields the old wrapper
 * recorded. Shared with the batch transport. */
export function readGeminiResponse(
	response: GenerateContentResponse,
	search: boolean,
): GeminiResult {
	const meta = response.usageMetadata;
	return {
		text: response.text ?? "",
		finishReason: response.candidates?.[0]?.finishReason ?? null,
		usage: {
			promptTokens: meta?.promptTokenCount ?? 0,
			outputTokens: meta?.candidatesTokenCount ?? 0,
			thoughtTokens: meta?.thoughtsTokenCount ?? 0,
			cachedTokens: meta?.cachedContentTokenCount ?? 0,
			grounded: search ? 1 : 0,
			// Grounding is billed per search query executed, not per call —
			// one prompt can fan out into several.
			searchQueries: search
				? (response.candidates?.[0]?.groundingMetadata?.webSearchQueries
						?.length ?? 0)
				: 0,
		},
	};
}

export async function geminiGenerate(
	ai: GoogleGenAI,
	model: string,
	contents: string,
	opts: AskOptions,
): Promise<GeminiResult> {
	const response = await ai.models.generateContent({
		model,
		contents,
		config: geminiConfig(opts),
	});
	return readGeminiResponse(response, opts.search === true);
}
