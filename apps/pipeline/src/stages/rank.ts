import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	byScoreThenSoonest,
	TOP_PICK_THRESHOLD,
	toISODate,
} from "@dothingslol/core/shared";
import { ask } from "@dothingslol/llm";
import { chunkArray, mapWithConcurrency } from "@dothingslol/utils/concurrency";
import type { RunContext } from "../config/context.js";
import { loadInterests } from "../config/load.js";
import { DATA_ROOT } from "../config/paths.js";
import { fmtDate } from "../config/week.js";
import {
	RANK_DESCRIPTION_CHARS,
	RANK_PROMPT_VERSION,
	rankReuseKey,
} from "../rankReuse.js";

const RANK_SYSTEM = `You are scoring events for relevance to a specific person's interests.

${loadInterests()}

You will receive a numbered list of events. Score each one 1–10 for how well it matches the interests above.

Calibration rules — follow these strictly:
- 7 is the bar for a top pick. Treat it as scarce: AT MOST 1 IN 10 events in
  the list may score 7 or higher. This is a hard cap on 7+, not on 8+.
- Most events score 4–6. A 6 is the right score for something genuinely
  relevant that is nonetheless ordinary — a regular weekly meetup, a standing
  club night, a workshop in a series that runs every month. Being on-topic is
  not enough for a 7.
- 7–8 is for a specific occasion worth rearranging an evening for: a named
  speaker, a one-off, an opening, a festival programme item.
- 9–10 is for a handful per city per week at most, and only when the match is
  both on-topic AND unusual enough that missing it would be a shame.
- Recurrence lowers the score. If the same thing happens every week, it is a 6
  at best however well it matches — it will still be on next week.
- Sports, MLM, sales events score 1–2
- Venue promotions score 1: a happy hour, meal deal, drink special or raffle
  is the venue selling its usual menu, not something to go to. Score the
  promotion, not the venue — a good pub's "$13 Lunch Special" is still a 1.
- Anything under "SKIP ENTIRELY" in the interests scores 1–2, however the
  listing words it.
- A standing paid attraction or tour you can book on most days is a product,
  not an event, and scores 2: bridge climbs, river cruises, guided kayak or
  day trips, escape rooms, themed-bar "experiences", ticketed walking tours.
  A one-off guided walk with a named host or a specific occasion is an event
  and is scored normally.

Return ONLY a JSON array: [{"index": 0, "score": 7}, ...]. No markdown, no explanation.`;

type Event = Record<string, unknown>;

function buildRankUser(events: Event[]): string {
	const lines = events.map((e, i) => {
		const tags = ((e.tags as string[]) ?? []).join(", ");
		const description = ((e.description as string) ?? "").slice(
			0,
			RANK_DESCRIPTION_CHARS,
		);
		return `${i}. [${e.category ?? ""}] ${e.title ?? "Untitled"} | ${e.cost ?? ""} | ${description} | tags: ${tags}`;
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

export interface RankResult {
	skipped: boolean;
	eventCount: number;
	scoredCount: number;
	reusedCount: number;
}

export async function rank(ctx: RunContext): Promise<RankResult> {
	const CITY = ctx.city;
	const CITY_TZ = ctx.cityConfig.timezone;
	const FORCE = ctx.force;
	const log = ctx.log;
	const { monday, sunday } = ctx.week;
	const jsonPath = join(DATA_ROOT, `${CITY}.json`);

	if (!existsSync(jsonPath)) {
		throw new Error(`✗ ${jsonPath} not found — run curate.ts first.`);
	}

	const payload = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<
		string,
		unknown
	>;

	// The prompt version is part of "already ranked", not just the date.
	// Stored scores were answers to whatever RANK_SYSTEM asked at the time,
	// so a calibration change has to re-ask even within the same week.
	const storedVersion = payload.rank_prompt_version;
	const sameVersion = storedVersion === RANK_PROMPT_VERSION;
	if (
		!FORCE &&
		payload.ranked_at === toISODate(monday, CITY_TZ) &&
		sameVersion
	) {
		log.log(
			"→ Already ranked for this week — skipping. Set FORCE=true to re-rank.",
		);
		return { skipped: true, eventCount: 0, scoredCount: 0, reusedCount: 0 };
	}
	if (!sameVersion && storedVersion !== undefined) {
		log.log(
			`→ Scores were written under prompt ${String(storedVersion)}, now ${RANK_PROMPT_VERSION} — re-scoring every event.`,
		);
	}

	const events = ((payload.events as Event[]) ?? []).map((e) => {
		const { score: _, ...rest } = e as Event & { score?: unknown };
		return rest;
	});

	if (events.length === 0) {
		throw new Error("✗ No events to rank.");
	}

	log.log(
		`Ranking — ${payload.city as string} — ${fmtDate(monday, CITY_TZ)} to ${fmtDate(sunday, CITY_TZ)}`,
	);
	log.log("=".repeat(50));

	// Reuse last week's score wherever the event and everything the prompt
	// shows about it are unchanged. Skipped entirely on FORCE — a forced run
	// is asking for a fresh answer, not a cached one.
	// Reuse needs the stored scores to have come from the current prompt.
	// RANK_PROMPT_VERSION is inside rankReuseKey, but that alone can never
	// invalidate anything: the key is recomputed for both sides of the
	// comparison, so both always carry the *current* version and always
	// match. The version has to be read back from the file to mean
	// anything.
	const previousByKey = new Map<string, number>();
	if (!FORCE && sameVersion && existsSync(jsonPath)) {
		for (const e of (payload.events as Event[]) ?? []) {
			if (typeof e.score === "number") {
				previousByKey.set(rankReuseKey(CITY, e), e.score);
			}
		}
	}
	const toScore: { event: Event; index: number }[] = [];
	let reused = 0;
	events.forEach((event, index) => {
		const prev = previousByKey.get(rankReuseKey(CITY, event));
		if (prev !== undefined) {
			event.score = prev;
			reused++;
		} else {
			toScore.push({ event, index });
		}
	});
	log.log(
		`→ Scoring ${toScore.length} of ${events.length} events with Google Gemini` +
			`${reused > 0 ? ` (${reused} unchanged from last week, reused)` : ""}…`,
	);

	// Chunked and concurrent: scores are per-event judgements with no
	// cross-event reasoning, so a chunk boundary costs nothing, while one
	// call for 400+ events risked a silent truncation that assigns a
	// neutral 5 to every event and erases the ranking.
	const cfg = ctx.config;
	const chunks = chunkArray(toScore, cfg.stages.rank.batchSize);
	const results = await mapWithConcurrency(chunks, 3, async (chunk, i) => {
		const rawText = await ask(buildRankUser(chunk.map((c) => c.event)), {
			provider: cfg.models.rank.provider as any,
			model: cfg.models.rank.model as any,
			stage: "rank",
			system: RANK_SYSTEM,
			maxOutputTokens: 8192,
			json: true,
			thinking: "off",
		});
		const parsed = parseScores(rawText);
		if (!parsed) {
			log.error(
				`  ⚠ chunk ${i + 1}/${chunks.length}: could not parse scores — those events keep a neutral 5`,
			);
			log.error(`  raw response: ${rawText.slice(0, 200)}`);
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

	// Score first, then soonest — see byScoreThenSoonest. This is the order
	// the site inherits, so getting the tiebreak right here fixes every
	// consumer.
	events.sort(byScoreThenSoonest);

	const high = events.filter(
		(e) => ((e.score as number) ?? 0) >= TOP_PICK_THRESHOLD,
	).length;
	log.log(
		`→ Score distribution: ${high}/${events.length} events score ≥ ${TOP_PICK_THRESHOLD} (${((100 * high) / events.length).toFixed(0)}%)`,
	);

	const updated = {
		...payload,
		ranked_at: toISODate(monday, CITY_TZ),
		rank_prompt_version: RANK_PROMPT_VERSION,
		events,
	};

	writeFileSync(jsonPath, JSON.stringify(updated, null, 2), "utf-8");
	log.log(`→ Written ${jsonPath}`);
	log.log("✓ Ranking complete.");
	return {
		skipped: false,
		eventCount: events.length,
		scoredCount: toScore.length,
		reusedCount: reused,
	};
}
