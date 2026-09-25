# Pipeline constants inventory

Scope: every module-level SCREAMING_CASE `const` in `src/**/*.ts` (excluding `src/pages`, `src/layouts`, `*.test.ts`), plus model-name literals passed at call sites and `process.env.X ?? default` reads. Inventory date: 2026-09-25.
Rule applied: **CONFIG** means an operator might tune it without a code change (models, concurrency, budgets, batch sizes, timeouts, retries/backoff, per-host rate limits, cost-driving limits, publishing window, output-split sizes, cache TTLs). They are proposed for `apps/pipeline/config/pipeline.yml`.
**CODE** stays in the code next to its comment. That covers hostile-input caps, protocol/format facts, internal enums/maps, runtime inputs (env/CLI/secrets), paths and prompt versions. **CORE** means `src/shared.ts` values shared with web/native, which move to the `core` package. **DECIDE** means genuinely ambiguous.
The owner decides the DECIDE rows and can override any row. Regexes and prompt/instruction text are listed by name only in the appendix.

## How to decide

- To mark a decision, change the row's section by moving the row, or append **`→ CONFIG`** / **`→ CODE`** to its Trade-off/Reason cell. Sub-phase 1.11 applies whatever this file says when it runs. Unresolved DECIDE rows stay in code.
- **Resolved by PR 0, before 1.11:**
  - `BRISBANE_UTC_OFFSET_HOURS` is removed in favour of each city's DST-aware `timezone`.
  - `CITY_NAMES`/`CITY_TERMS` gain Byron.
- **Needs a behaviour decision, not a placement one:** `MIN_IN_WINDOW` in `triage.ts` is a stale mirror (PLAN §12).

## Summary

| Classification | Rows |
|---|---|
| CONFIG | 55 |
| DECIDE | 24 |
| CORE | 14 |
| CODE | 115 |
| Appendix (regexes 52, prompts/templates 11) | 63 |
| **Total** | **271** (267 SCREAMING consts + 2 call-site model literals + 2 env-only rows) |

Cross-cutting notes the rows depend on:

- **Cache keys omit the model.** Four caches are keyed on a prompt version and not on the model name: `extractionCache.ts` PROMPT_VERSION, `annotate.ts` ANNOTATE_PROMPT_VERSION, `rankReuse.ts` RANK_PROMPT_VERSION and `venues.ts` VENUE_PROMPT_VERSION. The venues comment says to bump the version when the model changes. Once `models.*` is in YAML, a model change would reuse stale cached answers unless the model name is added to those keys.
- **Duplicates.** The publish window (`WINDOW_TO`) is written out in 3 files. Probe's gate thresholds are copied into `triage.ts`, and one copy has drifted (`MIN_IN_WINDOW`, see DECIDE). `LISTING_PATH` is an identical regex in `probe.ts` and `triage.ts`. `pages.ts` CATEGORY_SLUGS repeats the slugs in `shared.ts` CATEGORY_META.
- **Env overrides no workflow sets.** `.github/workflows/*` does not set PROBE_CONCURRENT_HOSTS, PROBE_SOURCE_TIMEOUT_MS, RENDER_RUN_BUDGET_MS, ANTHROPIC_SEARCH_MODEL, GEMINI_CONCURRENCY, GEMINI_MAX_CALLS, EVENTYR_DATA_ROOT or DISABLE_PROVIDERS. The workflows set only `PROVIDERS` (digest.yml) and `CHROME_PATH` (digest.yml, reprobe.yml).

## CONFIG

### models

| Constant | File:line | Current value | Env override | Proposed YAML key | Reason |
|---|---|---|---|---|---|
| ANNOTATE_MODEL | src/adapters/annotate.ts:21 | `"gemini-3.1-flash-lite"` | — | `models.annotate` | Per-event classification; independent items, so a small model suffices. |
| EXTRACT_MODEL | src/adapters/llmExtract.ts:27 | `"gemini-3.1-flash-lite"` | — | `models.extract` | LLM extraction over page text (scrape ladder's last rung). |
| DISCOVERY_MODEL | src/adapters/probe.ts:152 | `"gemini-3.1-flash-lite"` | — | `models.probe` | flash-lite for bulk batched listing-URL discovery. |
| MODEL | src/adapters/discover.ts:63 | `"gemini-3.5-flash"` | — | `models.discover` | Grounded per-niche venue discovery calls. |
| MODEL | src/dedupeClassifier.ts:17 | `"gemini-3.1-flash-lite"` | — | `models.dedupe` | Classifies the ambiguous-pair minority; tiny JSON in/out. |
| VENUE_MODEL | src/venues.ts:45 | `"gemini-3.5-flash"` | — | `models.venues` | flash-lite merged distinct branches; answers cached for good. |
| RANK_MODEL | src/rank.ts:22 | `"gemini-3.5-flash"` | — | `models.rank` | Scores events 1–10 against INTERESTS. |
| SEARCH_MODEL | src/providers/google.ts:7 | `"gemini-3.1-flash-lite"` | — | `models.search.google` | Google provider's grounded event search. |
| CURATE_MODEL | src/providers/google.ts:8 | `"gemini-3.1-flash-lite"` | — | `models.search.googleCurate` | Google provider's curate/enrich pass over raw search text. |
| SEARCH_MODEL | src/providers/anthropic.ts:18 | `"claude-sonnet-5"` | `ANTHROPIC_SEARCH_MODEL` | `models.search.anthropic` | Sonnet default; Haiku is a cost experiment, not a default. |
| (call-site default `model =`) | src/providers/openai.ts:39 | `"gpt-5-mini"` | — | `models.search.openai` | OpenAIProvider constructor default model. |
| (call-site arg to `super`) | src/providers/perplexity.ts:11 | `"sonar-pro"` | — | `models.search.perplexity` | Perplexity passes its model into OpenAIProvider. |

### llm

| Constant | File:line | Current value | Env override | Proposed YAML key | Reason |
|---|---|---|---|---|---|
| CONCURRENCY | src/providers/gemini.ts:129 | `4` | `GEMINI_CONCURRENCY` | `llm.concurrency.gemini` | Process-wide; spend-per-minute binds, bursts trip it. |
| MAX_CALLS | src/providers/gemini.ts:133 | `0` → unlimited | `GEMINI_MAX_CALLS` | `llm.budget.maxCalls` | Hard per-run ceiling; stops cleanly, scripts are resumable. |
| MAX_RETRIES | src/providers/gemini.ts:135 | `4` | — | `llm.retries.max` | Retries on 429/503/overload errors. |
| BASE_BACKOFF_MS | src/providers/gemini.ts:136 | `5_000` | — | `llm.retries.baseBackoffMs` | Base for 429-aware exponential backoff. |
| MAX_AGE_DAYS | src/adapters/extractionCache.ts:43 | `60` | — | `llm.cache.extractionMaxAgeDays` | Cache persists across CI; prune stale entries or they accumulate. |

### scrape

| Constant | File:line | Current value | Env override | Proposed YAML key | Reason |
|---|---|---|---|---|---|
| DEFAULT_MIN_INTERVAL_MS | src/adapters/fetch.ts:94 | `1000` | — | `scrape.perHost.minIntervalMs` | One request per second per host. |
| DEFAULT_MAX_CONCURRENCY_PER_HOST | src/adapters/fetch.ts:95 | `2` | — | `scrape.perHost.maxConcurrency` | At most two concurrent requests per host. |
| DEFAULT_MAX_RETRIES | src/adapters/fetch.ts:96 | `3` | — | `scrape.retries.max` | Fetch retry attempts. |
| BASE_BACKOFF_MS | src/adapters/fetch.ts:97 | `1000` | — | `scrape.retries.baseBackoffMs` | Base for jittered exponential fetch backoff. |
| CONCURRENCY | src/adapters/enrichTimes.ts:48 | `4` | — | `scrape.detailPages.concurrency` | Detail pages in flight; per-host limit applies separately. |
| CONCURRENT_HOSTS | src/adapters/render.ts:46 | `3` | — | `scrape.render.concurrentHosts` | Each host holds a browser context; bounds memory and politeness. |
| PAGE_TIMEOUT_MS | src/adapters/render.ts:49 | `25_000` | — | `scrape.render.pageTimeoutMs` | Measured worst case ~7s; 25s means it won't work. |
| RUN_BUDGET_MS | src/adapters/render.ts:58 | `20 * 60_000` | `RENDER_RUN_BUDGET_MS` | `scrape.render.runBudgetMs` | Whole-run ceiling so slow hosts cannot hang the cron job. |

### stages.collectAdapters / stages.extract / stages.annotate

| Constant | File:line | Current value | Env override | Proposed YAML key | Reason |
|---|---|---|---|---|---|
| SOURCE_CONCURRENCY | src/adapters/collect.ts:81 | `5` | — | `stages.collectAdapters.concurrency` | Bounded by LLM extraction calls in flight, not politeness. |
| MAX_OUTPUT_TOKENS | src/adapters/llmExtract.ts:28 | `16000` | — | `stages.extract.maxOutputTokens` | Per-call output ceiling for extraction. |
| MAX_CONCURRENT_CALLS | src/adapters/llmExtract.ts:34 | `3` | — | `stages.extract.concurrency` | Concurrent extraction calls per page. |
| BATCH_SIZE | src/adapters/annotate.ts:25 | `40` | — | `stages.annotate.batchSize` | Independent classification; bigger batch costs little accuracy, halves calls. |
| MAX_CONCURRENT_CALLS | src/adapters/annotate.ts:27 | `6` | — | `stages.annotate.concurrency` | Concurrent annotate calls per source. |

### stages.probe / stages.discover

| Constant | File:line | Current value | Env override | Proposed YAML key | Reason |
|---|---|---|---|---|---|
| MAX_CANDIDATE_FETCHES | src/adapters/probe.ts:90 | `6` | — | `stages.probe.maxCandidateFetches` | Suggested URLs fetched per source; fetching is cheap. |
| MAX_KEPT_URLS | src/adapters/probe.ts:93 | `3` | — | `stages.probe.maxKeptUrls` | Listing URLs kept per promoted source; drives weekly scrape volume. |
| MAX_EVALUATIONS | src/adapters/probe.ts:101 | `2` | — | `stages.probe.maxEvaluations` | Paid extractions per source; sixth candidate never verified. |
| MAX_EVALUATIONS | src/adapters/triage.ts:132 | `2` | — | `stages.probe.maxEvaluations` | Mirror of probe's value; must read the same key. |
| MAX_SITEMAP_CANDIDATES | src/adapters/probe.ts:420 | `5` | — | `stages.probe.maxSitemapCandidates` | Sitemap-derived candidates kept per source. |
| URL_BATCH_SIZE | src/adapters/probe.ts:153 | `20` | — | `stages.probe.urlBatchSize` | Sources per batched listing-URL request; smaller keeps attention. |
| URL_BATCH_CONCURRENCY | src/adapters/probe.ts:154 | `4` | — | `stages.probe.urlBatchConcurrency` | Concurrent batched discovery requests. |
| CONCURRENT_HOSTS | src/adapters/probe.ts:167 | `20` | `PROBE_CONCURRENT_HOSTS` | `stages.probe.concurrentHosts` | I/O-bound across different hosts; per-host politeness enforced elsewhere. |
| SOURCE_TIMEOUT_MS | src/adapters/probe.ts:170 | `180_000` | `PROBE_SOURCE_TIMEOUT_MS` | `stages.probe.sourceTimeoutMs` | Wall-clock ceiling per source; generous but finite. |
| CONCURRENCY | src/adapters/discover.ts:65 | `4` | — | `stages.discover.concurrency` | Niche calls in flight per city. |

### stages.collect

| Constant | File:line | Current value | Env override | Proposed YAML key | Reason |
|---|---|---|---|---|---|
| MAX_WEB_SEARCHES | src/providers/anthropic.ts:25 | `3` | — | `stages.collect.anthropic.maxWebSearches` | The provider's whole cost: ~$0.06 per search on Sonnet 5. |
| MAX_TOOL_CALLS | src/providers/openai.ts:17 | `4` | — | `stages.collect.openai.maxToolCalls` | Uncapped agentic loop is an uncapped bill. |
| HIT_WINDOW_WEEKS | src/sourceYield.ts:23 | `8` | — | `stages.collect.sourceYield.hitWindowWeeks` | Source silent this long is dropped from the search prompts. |
| GRACE_DAYS | src/sourceYield.ts:26 | `28` | — | `stages.collect.sourceYield.graceDays` | New source keeps its place this long before being judged. |

### stages.dedupe / stages.locality / stages.venues / stages.rank

| Constant | File:line | Current value | Env override | Proposed YAML key | Reason |
|---|---|---|---|---|---|
| PAIR_BATCH_SIZE | src/dedupe.ts:45 | `30` | — | `stages.dedupe.pairBatchSize` | Pairs per LLM call. |
| MAX_CONCURRENT_CALLS | src/dedupeClassifier.ts:20 | `6` | — | `stages.dedupe.concurrency` | ~67 batches possible; uncapped fan-out just earns 429s. |
| MAX_CONCURRENT | src/locality.ts:42 | `8` | — | `stages.locality.concurrency` | Concurrent geocode requests; quota generous, this is politeness. |
| TIMEOUT_MS | src/locality.ts:43 | `10_000` | — | `stages.locality.timeoutMs` | Per-request Geocoding API timeout. |
| BATCH_SIZE | src/venues.ts:51 | `40` | — | `stages.venues.batchSize` | Cross-item matching; small enough to keep every name in view. |
| RANK_CHUNK | src/rank.ts:29 | `60` | — | `stages.rank.batchSize` | Bounds a parse failure's blast radius; chunks run concurrently. |

### publish

| Constant | File:line | Current value | Env override | Proposed YAML key | Reason |
|---|---|---|---|---|---|
| WINDOW_TO | src/adapters/collect.ts:84 | coming Sunday + 7 days | — | `publish.windowDaysAfterWeek` | Window is today → end of next week; keeps thin weeks full. |
| WINDOW_TO | src/adapters/probe.ts:226 | coming Sunday + 7 days | — | `publish.windowDaysAfterWeek` | Same window as scrape so probe and collect agree. |
| WINDOW_TO | src/curate.ts:69 | coming Sunday + 7 days | — | `publish.windowDaysAfterWeek` | Copied, not imported, so curate doesn't depend on collect. |
| WEEK_FILE_LIMIT | src/ai.ts:71 | `200 * 1024` | — | `publish.ai.weekSplitBytes` | Week file above this gets the per-category split. |
| DAY_FILE_LIMIT | src/ai.ts:70 | `50 * 1024` | — | `publish.ai.dayWarnBytes` | Soft target, logged only; day files are never split. |

### schedule

No constants in `src/`. The schedule lives in `.github/workflows/weekly.yml` (cron) and in `getWeekRange()` logic, which is code.

## DECIDE

| Constant | File:line | Current value | Env override | Proposed YAML key | Trade-off |
|---|---|---|---|---|---|
| MIN_TEXT_LENGTH | src/adapters/probe.ts:80 | `1200` | — | `stages.probe.gate.minTextLength` | Labeled "tuning", retunable via --report-only; but it's a correctness gate. |
| MIN_TEXT_LENGTH | src/adapters/triage.ts:124 | `1200` | — | `stages.probe.gate.minTextLength` | Mirror of probe; wherever it lives, both must read one value. |
| MIN_DATE_HITS | src/adapters/probe.ts:84 | `5` | — | `stages.probe.gate.minDateHits` | Decides who gets an LLM call (cost) vs refusing real listings. |
| MIN_DATED_TO_PROMOTE | src/adapters/probe.ts:125 | `3` | — | `stages.probe.promote.minDated` | Promotion evidence threshold: tuning moves coverage, but it's a verification rule. |
| MIN_DATED | src/adapters/triage.ts:129 | `3` | — | `stages.probe.promote.minDated` | Mirror of probe MIN_DATED_TO_PROMOTE. |
| MIN_UPCOMING_TO_PROMOTE | src/adapters/probe.ts:143 | `1` | — | `stages.probe.promote.minUpcoming` | Was 2-in-window, rejected 30 real sources; policy knob vs verification rule. |
| MIN_IN_WINDOW | src/adapters/triage.ts:130 | `2` | — | `stages.probe.promote.minUpcoming` | **Stale mirror** of a removed probe constant (now 1, any-future); fix either way. |
| MAX_PAST_RATIO | src/adapters/probe.ts:144 | `10` | — | `stages.probe.promote.maxPastRatio` | Archive detector; generous for galleries. Tunable, but defines "listing page". |
| MAX_FETCHES_PER_SOURCE | src/adapters/enrichTimes.ts:52 | `150` | — | `scrape.detailPages.maxPerSource` | Fan-out cap against hostile listings, yet raised from 80 for coverage. |
| MAX_PAIRS | src/dedupe.ts:55 | `3000` | — | `stages.dedupe.maxPairs` | O(n²) safety guard vs cost ceiling; old 400 truncated live data. |
| MAYBE_MIN | src/dedupe.ts:43 | `0.45` | — | `stages.dedupe.maybeMin` | Lower means more LLM calls and fewer missed duplicates; also algorithm-defining. |
| MAX_BATCHES_PER_PAGE | src/adapters/llmExtract.ts:30 | `4` | — | `stages.extract.maxBatchesPerPage` | Hostile-page fan-out cap that also sets max paid calls per page. |
| ICAL_EXPAND_DAYS | src/adapters/feeds.ts:872 | `60` | — | `publish.icalExpandDays` | Must exceed the publish window; better derived from `publish.*` than set separately. |
| SETTLE_MS | src/adapters/render.ts:52 | `6_000` | — | `scrape.render.settleMs` | A wait, but pinned to an observed 5s interstitial reload. |
| USER_AGENT | src/adapters/fetch.ts:35 | `"Mozilla/5.0 (Macintosh…) Chrome/131…"` | — | `scrape.userAgent` | Operators may bump the Chrome version; changing it silently shifts block rates. |
| LEDGER_WEEKS | src/sourceYield.ts:21 | `26` | — | `stages.collect.sourceYield.ledgerWeeks` | File-growth bound, but must stay ≥ hitWindowWeeks once that is configurable. |
| MIN_HISTORY_WEEKS | src/sourceYield.ts:32 | `8` | — | `stages.collect.sourceYield.minHistoryWeeks` | Fail-safe guard; lowering it prunes on thin history (cheap-branch failure). |
| NICHES | src/adapters/discover.ts:83 | 13 `{tier, label}` entries | — | `stages.discover.niches` | One grounded call per niche (cost), but the labels are prompt text. |
| PRICES | src/providers/gemini.ts:50 | USD table for 6 models | — | `llm.prices` | Vendor data that changes without code; only feeds spend estimates. |
| BRISBANE_UTC_OFFSET_HOURS | src/adapters/dates.ts:23 | `10` | — | per-city `timezone` in `sources/{city}.yml` | Fixed +10 is right for QLD only; byron (NSW, DST) is a digest option. |
| CITY_NAMES | src/adapters/discover.ts:69 | brisbane/goldcoast/sunnycoast | — | per-city `sources/{city}.yml` (`name`) | Per-city data duplicating the yml `name`; byron missing (falls back to key). |
| CITY_TERMS | src/adapters/probe.ts:465 | brisbane/goldcoast/sunnycoast | — | per-city `sources/{city}.yml` | Per-city data that add_city does not write; byron missing. |
| AU_CURRENCY | src/adapters/extract.ts:127 | `"AUD"` | — | per-city `currency` in `sources/{city}.yml` | Rewrites any 3-letter JSON-LD currency to AUD; ignores the city's `currency`. |
| (env) PROVIDERS / DISABLE_PROVIDERS | src/collection.ts:97–98 | unset → every provider with a key | `PROVIDERS`, `DISABLE_PROVIDERS` | `stages.collect.providers` | Default set could live in YAML; digest.yml input already overrides PROVIDERS. |

## CORE

All in `src/shared.ts`, which is imported by the browser bundle, so they move to the shared `core` package.

| Constant | File:line | Current value | Env override | Reason |
|---|---|---|---|---|
| CATEGORIES | src/shared.ts:10 | 6 category labels | — | Category enum shared by pipeline, site and feeds. |
| CATEGORY_EMOJI | src/shared.ts:21 | category → emoji map | — | Display mapping used by site and markdown. |
| TOP_PICK_THRESHOLD | src/shared.ts:30 | `7` | — | Score at which an event surfaces as a top pick. |
| LOW_SCORE_THRESHOLD | src/shared.ts:32 | `4` | — | Below this a score is "low"; site filter hides these. |
| TAGS | src/shared.ts:90 | tag vocabulary array | — | Controlled tag enum. |
| TAG_SET | src/shared.ts:209 | `new Set(TAGS)` | — | Fast membership test for coerce() and search. |
| VACUOUS_TAGS | src/shared.ts:223 | set of rejected tags | — | Vibe restatements and non-informative tags stripped from output. |
| TAG_MATCHERS | src/shared.ts:339 | tag → RegExp[] map | — | Implied-tag expansion rules (regex map, but defines tag semantics). |
| MATCHER_ENTRIES | src/shared.ts:405 | `Object.entries(TAG_MATCHERS)` | — | Derived from TAG_MATCHERS. |
| MONTH_NUM | src/shared.ts:504 | month abbrev → number | — | Calendar fact for shared date parsing. |
| CATEGORY_META | src/shared.ts:583 | category → {slug, short} | — | URL slugs and short names per category. |
| SITE_URL | src/shared.ts:602 | `"https://www.dothings.lol"` | — | Canonical site origin. |
| KEY_TO_SLUG | src/shared.ts:606 | 4 cities (incl. byron) | — | City key → public URL slug. |
| DEFAULT_COST_LOCALE | src/shared.ts:775 | `{locale: "en-AU", currency: "AUD"}` | — | Default when a city sets no locale/currency. |

## CODE

| Constant | File:line | Current value | Env override | Reason |
|---|---|---|---|---|
| ANNOTATE_PROMPT_VERSION | src/adapters/annotate.ts:154 | `"v4"` | — | Cache-key version; bumped with prompt edits. |
| MAX_TAGS | src/adapters/annotate.ts:159 | `8` | — | Must move with the prompt's own ceiling. |
| CITY | src/adapters/collect.ts:53 | `requireEnv("CITY")` | `CITY` | Runtime input, not a setting. |
| GOOGLE_API_KEY | src/adapters/collect.ts:54 | `requireEnv(…)` | `GOOGLE_API_KEY` | Secret. |
| FORCE | src/adapters/collect.ts:55 | `false` unless 1/true/yes | `FORCE` | Per-run cache bypass flag. |
| ONLY | src/adapters/collect.ts:63 | `--only=` CLI list | — | Per-run CLI filter. |
| WINDOW_FROM | src/adapters/collect.ts:83 | today | — | Window always starts today; can't resurrect past events. |
| OFFSET_MS | src/adapters/dates.ts:24 | derived from offset hours | — | Derived value. |
| TIMEZONE | src/adapters/dates.ts:30 | offset hours × 60 | — | chrono needs minutes; IANA name silently fell back to host TZ. |
| DAY_MS | src/adapters/dates.ts:124 | `86_400_000` | — | Arithmetic constant. |
| MONTH_NAMES | src/adapters/dates.ts:164 | 12 month names | — | Calendar fact. |
| IS_MAIN | src/adapters/discover.ts:52 | argv check | — | CLI-vs-import guard. |
| CITY | src/adapters/discover.ts:60 | `--city` flag | — | Runtime CLI input. |
| APPLY | src/adapters/discover.ts:61 | `--apply` flag | — | Runtime CLI input. |
| CONTINUE_DELIMITER | src/adapters/discover.ts:67 | `"-----"` | — | Prompt format marker. |
| MIN_DESCRIPTION_CHARS | src/adapters/enrichTimes.ts:59 | `80` | — | Measured: fillers 60–90 chars, real blurbs ~100. |
| MIN_FOUND_DESCRIPTION_CHARS | src/adapters/enrichTimes.ts:62 | `40` | — | Shorter detail-page find is a badge, not a description. |
| MIN_PARAGRAPH_CHARS | src/adapters/enrichTimes.ts:64 | `100` | — | Shorter paragraph is a caption, date line or button. |
| EVENT_TYPES | src/adapters/extract.ts:8 | schema.org Event subtypes | — | Format fact (schema.org types). |
| PROMPT_VERSION | src/adapters/extractionCache.ts:33 | `"v3"` | — | Cache-key version; bump on prompt/shape change. |
| CACHE_DIR | src/adapters/extractionCache.ts:35 | `DATA_ROOT/_cache/extractions` | via `EVENTYR_DATA_ROOT` | Path. |
| MAX_EVENTS_PER_FEED | src/adapters/feeds.ts:59 | `2500` | — | Hostile-response cap, well above real feeds (~2000). |
| SPECIAL_MAX_SESSIONS | src/adapters/feeds.ts:538 | `2` | — | Measured gap: specials 1–2 sessions, releases 9+. |
| SPECIAL_RELEASE_SLACK_DAYS | src/adapters/feeds.ts:546 | `14` | — | Specials carry screening date as release date. |
| FIVESTAR_SPECIAL_ATTRS | src/adapters/feeds.ts:560 | set of session labels | — | Third-party API labels. |
| READING_SITE | src/adapters/feeds.ts:666 | `{"3": angelikacinemas…}` | — | Third-party countryId → site mapping. |
| PALACE_SPECIAL_ATTRS | src/adapters/feeds.ts:750 | set of session labels | — | Third-party session labels marking an occasion. |
| ICAL_MAX_STEPS | src/adapters/feeds.ts:875 | `5000` | — | Unbounded RRULE must not spin forever. |
| BLOCKED_TEXT_LENGTH | src/adapters/fetch.ts:397 | `512` | — | Measured shells at 76 chars; real listings far above. |
| RETRY_MIN_TEXT | src/adapters/llmExtract.ts:32 | `2000` | — | Below this, an empty extraction is plausible, not suspicious. |
| OFFSET_MS | src/adapters/normalise.ts:16 | derived from offset hours | — | Duplicate of dates.ts derivation. |
| DAYS | src/adapters/normalise.ts:45 | weekday abbreviations | — | Calendar fact. |
| MONTHS_SHORT | src/adapters/normalise.ts:46 | month abbreviations | — | Calendar fact. |
| MAX_FEED_CANDIDATES | src/adapters/probe.ts:107 | `4` | — | Hostile `<head>` must not open unbounded feed fetches. |
| RESULTS_PATH | src/adapters/probe.ts:190 | `DATA_ROOT/_probe/results.jsonl` | — | Path. |
| LISTING_URLS_PATH | src/adapters/probe.ts:197 | `DATA_ROOT/_probe/listing-urls.json` | — | Path. |
| WINDOW_FROM | src/adapters/probe.ts:225 | today | — | Window start is always today. |
| IS_MAIN | src/adapters/probe.ts:305 | argv check | — | CLI-vs-import guard. |
| CITIES | src/adapters/probe.ts:313 | `[--city]` | — | Runtime CLI input. |
| ONLY | src/adapters/probe.ts:314 | `--only` list | — | Runtime CLI input. |
| LIMIT | src/adapters/probe.ts:325 | `--limit` or 0 | — | Runtime CLI input. |
| APPLY | src/adapters/probe.ts:326 | `--apply` | — | Runtime CLI input. |
| FORCE | src/adapters/probe.ts:328 | `--force` | — | Runtime CLI input: ignore caches. |
| APPLY_EVERY | src/adapters/probe.ts:339 | `20` | — | Durability flush cadence, not cost or coverage. |
| REPORT_ONLY | src/adapters/probe.ts:340 | `--report-only` | — | Runtime CLI input. |
| MAX_SITEMAP_FETCHES | src/adapters/probe.ts:418 | `14` | — | Bound on nested sitemap-index fetches. |
| MAX_SITEMAP_URLS | src/adapters/probe.ts:419 | `8000` | — | Bound on sitemap URLs read (hostile-input cap). |
| MIN_DESCENDANTS_FOR_INDEX | src/adapters/probe.ts:422 | `15` | — | Pages nested under a URL before it counts as an index. |
| MAX_PAGES_PER_HOST | src/adapters/render.ts:43 | `2` | — | Landing page plus one guess; more is a crawl. |
| RENDER_ONLY_MIN_DATE_HITS | src/adapters/render.ts:320 | `3` | — | 1–2 hits is a copyright year and opening hours. |
| RAW | src/adapters/testUrl.ts:24 | `--raw` | — | Runtime CLI input. |
| ALL | src/adapters/testUrl.ts:25 | `--all` | — | Runtime CLI input. |
| GOOGLE_API_KEY | src/adapters/testUrl.ts:33 | `requireEnv(…)` | `GOOGLE_API_KEY` | Secret. |
| CAUSES | src/adapters/triage.ts:69 | cause enum array | — | Internal enum. |
| REMEDY | src/adapters/triage.ts:94 | cause → remedy text | — | Internal map. |
| SUB_THRESHOLD_BAND | src/adapters/triage.ts:127 | `0.25` | — | Diagnostic band near a cutoff (crowbar 1164, milani 1192). |
| RICH_TEXT | src/adapters/triage.ts:135 | `3000` | — | Plainly-had-content heuristic for extraction-failure diagnosis. |
| RICH_DATE_HITS | src/adapters/triage.ts:136 | `5` | — | Paired with RICH_TEXT. |
| EVENT_API_SIGNATURES | src/adapters/triage.ts:174 | set of signature labels | — | Internal enum. |
| MAX_BODIES_PER_SOURCE | src/adapters/triage.ts:226 | `4` | — | ponytail cap; one source has 291 MB cached. |
| MAX_BODY_BYTES | src/adapters/triage.ts:227 | `512 * 1024` | — | ponytail cap; signatures live near `<head>`. |
| SUCCESS | src/adapters/triage.ts:273 | `{"html","jsonld"}` | — | Internal enum. |
| CITY_NAME | src/add_city.ts:18 | `requireEnv("CITY_NAME")` | `CITY_NAME` | Runtime input. |
| CITY_KEY | src/add_city.ts:19 | `requireEnv("CITY_KEY")` | `CITY_KEY` | Runtime input. |
| DIGEST_WF | src/add_city.ts:21 | `.github/workflows/digest.yml` | — | Path. |
| AI_ROOT | src/ai.ts:69 | `public/ai` | — | Path. |
| CITY | src/collection.ts:9 | `requireEnv("CITY")` | `CITY` | Runtime input. |
| GOOGLE_API_KEY | src/collection.ts:10 | `requireEnv(…)` | `GOOGLE_API_KEY` | Secret. |
| FORCE | src/collection.ts:11 | 1/true/yes | `FORCE` | Per-run flag. |
| PROVIDER_ARG | src/collection.ts:22 | `argv[2]` | — | Runtime CLI input. |
| ALIASES | src/collection.ts:24 | gemini→google, claude→anthropic… | — | CLI alias map. |
| PROVIDERS | src/collection.ts:45 | provider → {env, make} | — | Registry of key env names and factories. |
| PROVIDER_NAMES | src/collection.ts:65 | `Object.keys(PROVIDERS)` | — | Derived. |
| PROJECT_ROOT | src/common.ts:12 | repo root | — | Path. |
| DATA_ROOT | src/common.ts:15 | `PROJECT_ROOT/data` | `EVENTYR_DATA_ROOT` | Path; env override exists for tests. |
| SOURCES_ROOT | src/common.ts:17 | `PROJECT_ROOT/sources` | — | Path. |
| SOURCE_TIERS | src/common.ts:113 | aggregators/institutions/independents | — | Data-shape enum. |
| CITY | src/curate.ts:49 | `requireEnv("CITY")` | `CITY` | Runtime input. |
| FORCE | src/curate.ts:50 | 1/true/yes | `FORCE` | Per-run flag. |
| CITY_NAME | src/curate.ts:54 | `cityCfg.name` | — | Derived from city yml. |
| COST_LOCALE | src/curate.ts:57 | city yml ?? DEFAULT_COST_LOCALE | — | Derived from city yml. |
| WINDOW_FROM | src/curate.ts:68 | today | — | Window start is always today. |
| OUT_PATH | src/curate.ts:73 | `DATA_ROOT/{city}.json` | — | Path. |
| PREVIOUS | src/curate.ts:78 | previous `data/{city}.json` | — | Loaded state for carry-forward. |
| PROVIDER_KEY | src/curate.ts:161 | `"_provider"` | — | Internal field name. |
| SCRAPE_PROVIDER | src/curate.ts:163 | `"adapters"` | — | Directory name distinguishing scrape from LLM providers. |
| TEXT_FIELDS | src/curate.ts:234 | event text field names | — | Data shape. |
| URL_FIELDS | src/curate.ts:242 | `["link","location_url"]` | — | Data shape. |
| TIER_TO_VENUE | src/curate.ts:283 | tier → venue label | — | Data-shape map. |
| AUTO_MATCH | src/dedupe.ts:41 | `0.85` | — | Mirrors common.ts's hardcoded Dice > 0.85; must stay equal. |
| CITY | src/geocode.ts:11 | `requireEnv("CITY")` | `CITY` | Runtime input. |
| FORCE | src/geocode.ts:12 | 1/true/yes | `FORCE` | Per-run flag. |
| CITY | src/ical.ts:22 | `requireEnv("CITY")` | `CITY` | Runtime input. |
| ENDPOINT | src/locality.ts:40 | Google Geocoding JSON URL | — | Third-party API URL. |
| EARTH_RADIUS_KM | src/locality.ts:82 | `6371` | — | Physical constant. |
| NO_SUCH_PLACE | src/locality.ts:200 | `ZERO_RESULTS`, `INVALID_REQUEST` | — | API status values. |
| TOO_COARSE | src/locality.ts:209 | `country`, `administrative_area_level_1` | — | API result-type values. |
| CITY | src/messaging.ts:13 | `requireEnv("CITY")` | `CITY` | Runtime input. |
| WA_TOKEN | src/messaging.ts:14 | `requireEnv(…)` | `WHATSAPP_TOKEN` | Secret. |
| WA_PHONE_ID | src/messaging.ts:15 | `requireEnv(…)` | `WHATSAPP_PHONE_ID` | Secret/account id. |
| WA_TO | src/messaging.ts:16 | comma list | `WHATSAPP_RECIPIENT` | Recipients; personal data, keep in secrets. |
| MAX_CHARS | src/messaging.ts:21 | `4000` | — | Under WhatsApp's per-message length limit. |
| BASE_URL | src/pages.ts:14 | `SITE_URL` | — | Alias of CORE value. |
| CATEGORY_SLUGS | src/pages.ts:16 | 6 slugs | — | Duplicates CATEGORY_META slugs; should derive from core. |
| TIMEFRAME_SLUGS | src/pages.ts:26 | today/tomorrow/this-weekend | — | Must match `[timeframe].astro` routes. |
| PROMPT_CACHE_KEY | src/providers/openai.ts:9 | `"eventyr-events-search"` | — | OpenAI prompt-cache bucket key. |
| CITY | src/rank.ts:31 | `requireEnv("CITY")` | `CITY` | Runtime input. |
| GOOGLE_API_KEY | src/rank.ts:32 | `requireEnv(…)` | `GOOGLE_API_KEY` | Secret. |
| FORCE | src/rank.ts:33 | 1/true/yes | `FORCE` | Per-run flag. |
| RANK_DESCRIPTION_CHARS | src/rankReuse.ts:13 | `300` | — | Part of the rank prompt input and reuse key. |
| RANK_PROMPT_VERSION | src/rankReuse.ts:23 | `"v4"` | — | Persisted version; mismatch forces re-scoring. |
| UNLISTED_REPORT_MIN | src/sourceYield.ts:34 | `5` | — | Report threshold for unlisted hosts worth probing. |
| JSON_ESCAPE_MAP | src/text.ts:48 | escape → char map | — | Format fact. |
| VENUE_PROMPT_VERSION | src/venues.ts:48 | `5` | — | Cache version; bump on prompt, model or rawVenue change. |
| (env) CHROME_PATH | src/adapters/render.ts:223, 512 | `\|\| undefined` (Playwright default) | `CHROME_PATH` | Runner binary path; set by digest.yml and reprobe.yml. |

## Appendix: regexes and prompts (name, file only)

**Prompts / instruction text / templates**

- SYSTEM_PROMPT — src/adapters/annotate.ts
- SYSTEM_PROMPT — src/adapters/discover.ts
- SYSTEM_PROMPT — src/adapters/llmExtract.ts
- LISTING_SYSTEM — src/adapters/probe.ts
- SYSTEM_PROMPT — src/dedupeClassifier.ts
- RANK_SYSTEM — src/rank.ts
- SYSTEM_PROMPT — src/venues.ts
- INTERESTS — src/common.ts (the interest profile; the owner may still want it in config)
- TIER_INSTRUCTIONS — src/providers/base.ts
- OUTPUT_FORMAT_RULES — src/providers/base.ts
- HEADER — src/add_city.ts (YAML header template)

**Regexes (and regex fragments)**

- RETIRED_TEMPLATE_CATEGORY_WORD — src/adapters/annotate.ts
- NOT_A_DATE, ON_NOW, RELATIVE_MARKER, MONTHS (fragment), EXPLICIT_DATE, WEEKDAY_THEN_DAY — src/adapters/dates.ts
- KEY (map of regexes), MONTH (fragment) — src/adapters/embeddedJson.ts
- PARAGRAPH_BOILERPLATE, DATETIME_WITH_TIME, LABELLED_TIME, TIME_ONLY, TIME_KEY, META_TAG — src/adapters/enrichTimes.ts
- NOT_AN_EVENT_PAGE, COUNCIL_HOST, TRUMBA_ATOM_ROOT, FIVESTAR_HOST, READING_API, PALACE_HOST, FESTIVAL_PREFIX — src/adapters/feeds.ts
- COUNCIL_TRUMBA_EMBED — src/adapters/normalise.ts
- PLATFORMS, ARCHIVE_URL, LISTING_PATH, OTHER_REGION — src/adapters/probe.ts
- BOILERPLATE_TAGS, LINK_TAG — src/adapters/readableText.ts
- FEED_SIGNATURES (label/regex pairs), EMBED_HOSTS, RELOAD_SHELL, LISTING_PATH (identical to probe.ts), EVENT_WORDS, DATED_SLUG, PLACEHOLDER_SITEMAP — src/adapters/triage.ts
- HTML_TAG — src/ai.ts
- TIMED, DATE_ONLY — src/ical.ts
- UNINFORMATIVE_COST, FREE_COST, SINGLE_AMOUNT, MARKED_AMOUNT, MARKDOWN_LINK, PARENTHESISED_URL, BARE_URL, WWW_URL, MARKDOWN_EMPHASIS, MARKDOWN_BLOCK — src/shared.ts (these move to core with the file)
- TAG, JSON_ESCAPE — src/text.ts
- FLOOR_SEGMENT — src/venues.ts
