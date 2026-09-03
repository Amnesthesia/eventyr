import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
	byScoreThenSoonest,
	DATA_ROOT,
	fmtDate,
	getWeekRange,
	INTERESTS,
	requireEnv,
	TOP_PICK_THRESHOLD,
	toISODate,
} from "./common.ts";
import { chunkArray, mapWithConcurrency } from "./providers/base.ts";
import { geminiText, installUsageReporting } from "./providers/gemini.ts";

const RANK_MODEL = "gemini-3.5-flash";
/**
 * Events per ranking call. One call for the whole city risked silently
 * exceeding maxOutputTokens at 400+ events, and a parse failure assigns a
 * neutral 5 to *every* event — losing the ranking entirely. Chunking bounds
 * that blast radius to one chunk and lets the calls run concurrently.
 */
const RANK_CHUNK = 60;

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
	installUsageReporting();
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
	// Chunked and concurrent: scores are per-event judgements with no
	// cross-event reasoning, so a chunk boundary costs nothing, while one call
	// for 400+ events risked a silent truncation that assigns a neutral 5 to
	// every event and erases the ranking.
	const chunks = chunkArray(
		events.map((event, index) => ({ event, index })),
		RANK_CHUNK,
	);
	const results = await mapWithConcurrency(chunks, 3, async (chunk, i) => {
		const rawText = await geminiText(ai, {
			stage: "rank",
			model: RANK_MODEL,
			contents: buildRankUser(chunk.map((c) => c.event)),
			systemInstruction: RANK_SYSTEM,
			maxOutputTokens: 8192,
			extraConfig: {
				responseMimeType: "application/json",
				thinkingConfig: { thinkingBudget: 0 },
			},
		});
		const parsed = parseScores(rawText);
		if (!parsed) {
			console.warn(
				`  ⚠ chunk ${i + 1}/${chunks.length}: could not parse scores — those events keep a neutral 5`,
			);
			console.warn(`  raw response: ${rawText.slice(0, 200)}`);
			return;
		}
		// Indices are chunk-local; map them back to the city-wide array.
		for (const { index, score } of parsed) {
			const target = chunk[index];
			if (target) events[target.index].score = score;
		}
	});
	void results;

	for (const e of events) {
		if (typeof e.score !== "number") e.score = 5;
	}

	// Score first, then soonest — see byScoreThenSoonest. This is the order the
	// site inherits, so getting the tiebreak right here fixes every consumer.
	events.sort(byScoreThenSoonest);

	const high = events.filter(
		(e) => ((e.score as number) ?? 0) >= TOP_PICK_THRESHOLD,
	).length;
	console.log(
		`→ Score distribution: ${high}/${events.length} events score ≥ ${TOP_PICK_THRESHOLD} (${((100 * high) / events.length).toFixed(0)}%)`,
	);

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
