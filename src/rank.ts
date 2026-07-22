import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";

import {
	DATA_ROOT,
	fmtDate,
	getWeekRange,
	INTERESTS,
	requireEnv,
	toISODate,
} from "./common.ts";

const CITY = requireEnv("CITY");
const GOOGLE_API_KEY = requireEnv("GOOGLE_API_KEY");
const FORCE = ["1", "true", "yes"].includes(
	(process.env.FORCE ?? "").toLowerCase(),
);

const RANK_SYSTEM = `You are scoring events for relevance to a specific person's interests.

${INTERESTS}

You will receive a numbered list of events. Score each one 1–10 for how well it matches the interests above.

Calibration rules — follow these strictly:
- Most events should score 4–6 (decent but not exciting)
- Strong matches score 7–8 (clearly relevant, good fit)
- Only exceptional fits score 9–10 (perfect match, rare)
- Do NOT score more than 15% of events above 7
- Sports, MLM, sales events score 1–2

Return ONLY a JSON array: [{"index": 0, "score": 7}, ...]. No markdown, no explanation.`;

type Event = Record<string, unknown>;

function buildRankUser(events: Event[]): string {
	const lines = events.map((e, i) => {
		const tags = ((e.tags as string[]) ?? []).join(", ");
		return `${i}. [${e.category ?? ""}] ${e.title ?? "Untitled"} | ${e.cost ?? ""} | ${e.description ?? ""} | tags: ${tags}`;
	});
	return lines.join("\n");
}

function parseScores(
	raw: string,
): Array<{ index: number; score: number }> | null {
	const cleaned = raw.replace(/```json|```/g, "").trim();
	const start = cleaned.indexOf("[");
	if (start === -1) return null;
	let jsonStr = cleaned.slice(start);
	const end = jsonStr.lastIndexOf("]");
	if (end !== -1) jsonStr = jsonStr.slice(0, end + 1);
	try {
		const parsed = JSON.parse(jsonStr) as Array<{
			index: number;
			score: number;
		}>;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const { monday, sunday } = getWeekRange();
	const jsonPath = join(DATA_ROOT, `${CITY}.json`);

	if (!existsSync(jsonPath)) {
		throw new Error(`✗ ${jsonPath} not found — run curate.ts first.`);
	}

	const payload = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<
		string,
		unknown
	>;

	if (!FORCE && payload.ranked_at === toISODate(monday)) {
		console.log(
			"→ Already ranked for this week — skipping. Set FORCE=true to re-rank.",
		);
		return;
	}

	const events = ((payload.events as Event[]) ?? []).map((e) => {
		const { score: _, ...rest } = e as Event & { score?: unknown };
		return rest;
	});

	if (events.length === 0) {
		throw new Error("✗ No events to rank.");
	}

	console.log(
		`Ranking — ${payload.city as string} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);
	console.log("=".repeat(50));
	console.log(`→ Scoring ${events.length} events with Google Gemini…`);

	const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
	const response = await ai.models.generateContent({
		model: "gemini-3.5-flash",
		contents: buildRankUser(events),
		config: {
			systemInstruction: RANK_SYSTEM,
			maxOutputTokens: 8192,
			responseMimeType: "application/json",
			thinkingConfig: { thinkingBudget: 0 },
		},
	});

	const rawText = response.text ?? "";
	const scores = parseScores(rawText);

	if (!scores) {
		console.warn(
			"  ⚠ Could not parse scores from response — assigning neutral score 5 to all events",
		);
		console.warn(`  raw response: ${rawText.slice(0, 300)}`);
		for (const e of events) e.score = 5;
	} else {
		for (const { index, score } of scores) {
			if (index >= 0 && index < events.length) {
				events[index].score = score;
			}
		}
		for (const e of events) {
			if (!("score" in e)) e.score = 5;
		}
	}

	events.sort(
		(a, b) => ((b.score as number) ?? 0) - ((a.score as number) ?? 0),
	);

	if (scores) {
		const high = events.filter((e) => ((e.score as number) ?? 0) >= 8).length;
		console.log(
			`→ Score distribution: ${high}/${events.length} events score ≥ 8 (${((100 * high) / events.length).toFixed(0)}%)`,
		);
	}

	const updated = {
		...payload,
		ranked_at: toISODate(monday),
		events,
	};

	writeFileSync(jsonPath, JSON.stringify(updated, null, 2), "utf-8");
	console.log(`→ Written ${jsonPath}`);
	console.log("✓ Ranking complete.");
}

await main();
