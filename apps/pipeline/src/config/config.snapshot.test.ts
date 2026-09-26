import * as assert from "node:assert";
import { describe, it } from "node:test";
import { ANNOTATE_MODEL, BATCH_SIZE } from "../adapters/annotate.js";
import { SOURCE_CONCURRENCY } from "../adapters/collect.js";
import { MODEL } from "../adapters/discover.js";
import {
	EXTRACT_MODEL,
	MAX_BATCHES_PER_PAGE,
	MAX_CONCURRENT_CALLS,
	MAX_OUTPUT_TOKENS,
} from "../adapters/llmExtract.js";
import {
	CONCURRENT_HOSTS as CONCURRENT_HOSTS_99,
	DISCOVERY_MODEL,
	MAX_CANDIDATE_FETCHES,
	MAX_EVALUATIONS,
	MAX_KEPT_URLS,
	MAX_PAST_RATIO,
	MAX_SITEMAP_CANDIDATES,
	MIN_DATE_HITS,
	MIN_DATED_TO_PROMOTE,
	MIN_TEXT_LENGTH,
	MIN_UPCOMING_TO_PROMOTE,
	URL_BATCH_CONCURRENCY,
	URL_BATCH_SIZE,
} from "../adapters/probe.js";
import { CONCURRENT_HOSTS, RUN_BUDGET_MS } from "../adapters/render.js";
import {
	MAX_EVALUATIONS as MAX_EVALUATIONS_533,
	MIN_DATED,
	MIN_IN_WINDOW,
} from "../adapters/triage.js";
import { DAY_FILE_LIMIT, WEEK_FILE_LIMIT } from "../ai.js";
import { MAX_PAIRS, MAYBE_MIN, PAIR_BATCH_SIZE } from "../dedupe.js";
import { MODEL as MODEL_626 } from "../dedupeClassifier.js";
import { MAX_CONCURRENT, TIMEOUT_MS } from "../locality.js";
import { MAX_WEB_SEARCHES } from "../providers/anthropic.js";
import { CURATE_MODEL, SEARCH_MODEL } from "../providers/google.js";
import { MAX_TOOL_CALLS } from "../providers/openai.js";
import { RANK_CHUNK, RANK_MODEL } from "../rank.js";
import {
	GRACE_DAYS,
	HIT_WINDOW_WEEKS,
	LEDGER_WEEKS,
	MIN_HISTORY_WEEKS,
} from "../sourceYield.js";
import { BATCH_SIZE as BATCH_SIZE_945, VENUE_MODEL } from "../venues.js";

describe("pipeline config snapshot", () => {
	it("matches expected hardcoded values", () => {
		assert.deepStrictEqual(ANNOTATE_MODEL, "gemini-3.1-flash-lite"); // `models.annotate`
		assert.deepStrictEqual(EXTRACT_MODEL, "gemini-3.1-flash-lite"); // `models.extract`
		assert.deepStrictEqual(DISCOVERY_MODEL, "gemini-3.1-flash-lite"); // `models.probe`
		assert.deepStrictEqual(MODEL, "gemini-3.5-flash"); // `models.discover`
		assert.deepStrictEqual(MODEL_626, "gemini-3.1-flash-lite"); // `models.dedupe`
		assert.deepStrictEqual(VENUE_MODEL, "gemini-3.5-flash"); // `models.venues`
		assert.deepStrictEqual(RANK_MODEL, "gemini-3.5-flash"); // `models.rank`
		assert.deepStrictEqual(SEARCH_MODEL, "gemini-3.1-flash-lite"); // `models.search.google`
		assert.deepStrictEqual(CURATE_MODEL, "gemini-3.1-flash-lite"); // `models.search.googleCurate`
		assert.deepStrictEqual(CONCURRENT_HOSTS, 3); // `scrape.render.concurrentHosts`
		assert.deepStrictEqual(
			RUN_BUDGET_MS,
			Number(process.env.RENDER_RUN_BUDGET_MS ?? 20 * 60_000),
		); // `scrape.render.runBudgetMs`
		assert.deepStrictEqual(SOURCE_CONCURRENCY, 5); // `stages.collectAdapters.concurrency`
		assert.deepStrictEqual(MAX_OUTPUT_TOKENS, 16000); // `stages.extract.maxOutputTokens`
		assert.deepStrictEqual(MAX_CONCURRENT_CALLS, 3); // `stages.extract.concurrency`
		assert.deepStrictEqual(BATCH_SIZE, 40); // `stages.annotate.batchSize`
		assert.deepStrictEqual(MAX_CANDIDATE_FETCHES, 6); // `stages.probe.maxCandidateFetches`
		assert.deepStrictEqual(MAX_KEPT_URLS, 3); // `stages.probe.maxKeptUrls`
		assert.deepStrictEqual(MAX_EVALUATIONS, 2); // `stages.probe.maxEvaluations`
		assert.deepStrictEqual(MAX_EVALUATIONS_533, 2); // `stages.probe.maxEvaluations`
		assert.deepStrictEqual(MAX_SITEMAP_CANDIDATES, 5); // `stages.probe.maxSitemapCandidates`
		assert.deepStrictEqual(URL_BATCH_SIZE, 20); // `stages.probe.urlBatchSize`
		assert.deepStrictEqual(URL_BATCH_CONCURRENCY, 4); // `stages.probe.urlBatchConcurrency`
		assert.deepStrictEqual(
			CONCURRENT_HOSTS_99,
			Number(process.env.PROBE_CONCURRENT_HOSTS ?? 20),
		); // `stages.probe.concurrentHosts`
		assert.deepStrictEqual(MAX_WEB_SEARCHES, 3); // `stages.collect.anthropic.maxWebSearches`
		assert.deepStrictEqual(MAX_TOOL_CALLS, 4); // `stages.collect.openai.maxToolCalls`
		assert.deepStrictEqual(HIT_WINDOW_WEEKS, 8); // `stages.collect.sourceYield.hitWindowWeeks`
		assert.deepStrictEqual(GRACE_DAYS, 28); // `stages.collect.sourceYield.graceDays`
		assert.deepStrictEqual(PAIR_BATCH_SIZE, 30); // `stages.dedupe.pairBatchSize`
		assert.deepStrictEqual(MAX_CONCURRENT, 8); // `stages.locality.concurrency`
		assert.deepStrictEqual(TIMEOUT_MS, 10_000); // `stages.locality.timeoutMs`
		assert.deepStrictEqual(BATCH_SIZE_945, 40); // `stages.venues.batchSize`
		assert.deepStrictEqual(RANK_CHUNK, 60); // `stages.rank.batchSize`
		assert.deepStrictEqual(WEEK_FILE_LIMIT, 200 * 1024); // `publish.ai.weekSplitBytes`
		assert.deepStrictEqual(DAY_FILE_LIMIT, 50 * 1024); // `publish.ai.dayWarnBytes`
		assert.deepStrictEqual(MIN_TEXT_LENGTH, 1200); // `stages.probe.gate.minTextLength`
		assert.deepStrictEqual(MIN_DATE_HITS, 5); // `stages.probe.gate.minDateHits`
		assert.deepStrictEqual(MIN_DATED_TO_PROMOTE, 3); // `stages.probe.promote.minDated`
		assert.deepStrictEqual(MIN_DATED, 3); // `stages.probe.promote.minDated`
		assert.deepStrictEqual(MIN_UPCOMING_TO_PROMOTE, 1); // `stages.probe.promote.minUpcoming`
		assert.deepStrictEqual(MIN_IN_WINDOW, 2); // `stages.probe.promote.minUpcoming`
		assert.deepStrictEqual(MAX_PAST_RATIO, 10); // `stages.probe.promote.maxPastRatio`
		assert.deepStrictEqual(MAX_PAIRS, 3000); // `stages.dedupe.maxPairs`
		assert.deepStrictEqual(MAYBE_MIN, 0.45); // `stages.dedupe.maybeMin`
		assert.deepStrictEqual(MAX_BATCHES_PER_PAGE, 4); // `stages.extract.maxBatchesPerPage`
		assert.deepStrictEqual(LEDGER_WEEKS, 26); // `stages.collect.sourceYield.ledgerWeeks`
		assert.deepStrictEqual(MIN_HISTORY_WEEKS, 8); // `stages.collect.sourceYield.minHistoryWeeks`
	});
});
