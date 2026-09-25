# Sub-phase 1.6: `@dothingslol/llm`: `ask()` and the Gemini provider, with request parity

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.6 (llm package) of PR 1, the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` (especially §2.4 and §9) and `docs/monorepo/phase-1.06-llm-package.md`,
> and no other phase files. Work on branch `monorepo/refactor`, even if your environment suggests
> another; if you can't push to it, stop and ask. Sync first per PLAN §4.3.
>
> **Order matters.** Step 1 records golden requests on the *old* code before anything else changes.
> Each numbered step is one commit. If context gets tight, stop after a completed step, push, and
> report. Run every verification, post the results as a comment on the PR 1 draft, and tick 1.6.
> If request parity fails, stop and report. Don't "fix" the goldens. Push, don't merge, and don't
> start 1.7.

## Goal

Create `packages/llm` with the API in PLAN §2.4, and move every **non-search** Gemini call onto it.
These are the nine `geminiText` call sites, including `GoogleProvider.curate`. Grounded search moves
in 1.7. Along the way:

- The limiter, budget, 429 backoff, price table and usage counters move into `llm`.
- Usage **persistence** (`data/{city}/usage/*.json`) stays in the pipeline, behind a `UsageSink`.
- The content-addressed extraction cache becomes `llm`'s `cache` option, backed by a store the pipeline injects.
- The provider-native **batch transport** (D14) is built, with Gemini first and Anthropic/OpenAI in 1.7. It is tested against recorded batch responses and **not used by any stage**.

The requests sent to Gemini must be byte-identical before and after.

## Preconditions

- 1.5 is committed on the branch.

## Files affected

**New**
- `packages/llm/**`:
  - `src/index.ts`, `src/client.ts` (singleton, `configureLLM`, limiter, budget)
  - `src/providers/gemini.ts`, `src/pricing.ts`, `src/json.ts` (`parseJsonArray`, moved), `src/cache.ts`, `src/replay.ts`, `src/batch.ts`
  - `src/errors.ts`, `src/types.ts`, plus tests
- `src/io/usage.ts` (pipeline `UsageSink`: `usagePath`, `persistUsage`, `reportGeminiUsage`, `installUsageReporting`, moved from `providers/gemini.ts`)
- `src/io/fileCache.ts` (pipeline `CacheStore`, from `adapters/extractionCache.ts`)
- `src/llmBootstrap.ts` (one `configureLLM` call, imported by every CLI that makes model calls)

**Edited**
- The call sites: `src/providers/google.ts` (curate paths only), `src/venues.ts`, `src/rank.ts`, `src/dedupeClassifier.ts`, `src/adapters/{discover,llmExtract,annotate,probe}.ts`
- `src/providers/gemini.ts`: shrinks to a re-export shim for the search providers until 1.7
- Every importer of `parseJsonArray`

## Steps

### 1. Golden requests on the old code (seam + fixture city)

This step must happen before anything moves.

- **Add a record/replay seam inside the existing `geminiText`:**
  - `EVENTYR_LLM_REPLAY=record` appends one JSON line per call to `$EVENTYR_LLM_REPLAY_DIR/requests.jsonl`. Each line is `{stage, model, contents, systemInstruction, maxOutputTokens, temperature, search, extraConfig}`, with keys sorted.
  - `=replay` answers each call from `$EVENTYR_LLM_REPLAY_DIR/responses/<sha256 of that line>.txt`. It throws if a fixture is missing, and makes no network call.
  - When the variable is unset, behaviour is unchanged. Keep the seam small, and mark it with a `ponytail:` comment saying it is replaced by `llm`'s replay mode in step 3.
- **Build `test/fixtures/llm-city/`.** This is a trimmed copy of `data/brisbane/` and `data/brisbane.json` with about 12 events that exercise every stage:
  - a duplicate pair for dedupe
  - two venue spellings
  - an aggregator-tier event for locality
  - an event that has no category
  - one scraper source whose page text needs `llmExtract`

  Put `sources/brisbane.yml`-shaped config alongside it if the stages need one.
- **Write `scripts/llm-parity.mjs`.** For each LLM-using CLI (`curate`, `venues`, `rank`, `collect-adapters --only=<fixture source>`, `probe-sources --city=… ` in dry-run, `discover-sources` dry-run), it:
  1. runs the CLI with `EVENTYR_DATA_ROOT=<tmp copy of the fixture>`, `CITY=brisbane`, `FORCE=true`, `GOOGLE_API_KEY=dummy` and `EVENTYR_LLM_REPLAY=replay`;
  2. collects `requests.jsonl` per CLI into `test/golden/llm/<cli>.jsonl`.

  Before that, the canned `responses/*.txt` have to exist. Author them by hand: short, valid answers in the JSON shape each stage expects (for example `[{"i":0,"score":7}]` for rank). Write each file the first time a request hash misses, then re-run.
- **Commit** the seam, the fixture city, the canned responses and `test/golden/llm/*.jsonl`. These goldens are the contract for everything that follows.

### 2. Scaffold `packages/llm`

- Set `"name": "@dothingslol/llm"` and add an explicit `exports` map (`"."`, `"./testing"` for replay helpers).
- Dependencies: `@google/genai`, `@dothingslol/utils`.
- Dependency on the other SDKs arrives in 1.7.
- Tsconfig: NodeNext, `types: [node]`.
- Add its row to `check-boundaries.mjs` (utils only).

### 3. Implement the API from PLAN §2.4, Gemini only

**`client.ts`**
- A module-level singleton with one limiter per provider. The Gemini ceiling is `GEMINI_CONCURRENCY ?? 4`, the same env var and default as today.
- A global call budget using `GEMINI_MAX_CALLS`. Its semantics are unchanged: it counts Gemini calls only and throws `BudgetExhaustedError` with the same message.
- Usage accounting records the same fields (`GeminiUsage`) through the injected `UsageSink`.
- The retry loop is the same: `MAX_RETRIES = 4`, `BASE_BACKOFF_MS = 5000`, and the same transient-error regex and `Retry-After` parse. It calls utils' `backoffDelay`.

**`providers/gemini.ts`**

Map `AskOptions` to exactly today's `generateContent` call:

| `AskOptions` | `generateContent` config |
|---|---|
| `system` | `systemInstruction` |
| `search: true` | `tools: [{ googleSearch: {} }]` |
| `json: true` | `responseMimeType: "application/json"` |
| `thinking: "off"` | `thinkingConfig: { thinkingBudget: 0 }` |
| `thinking: "low"` | `thinkingConfig: { thinkingLevel: "low" }` |
| `maxOutputTokens` / `temperature` | passed through when set |
| `providerOptions` | merged last, like today's `extraConfig` |

- A single string prompt becomes `contents: <string>`, as today.
- A `string[]` is **N independent prompts with the same options** (D14). The default runs them as concurrent individual calls under the Gemini limiter, which is the same request stream `mapWithConcurrency` produces today.
- Key order inside `config` must produce identical request JSON.

**The rest of the API**
- `ask(string)` → `string` and `ask(string[])` → `string[]`. The array form preserves order and rejects with `BatchError` (which carries per-index outcomes) if any prompt fails.
- `askDetailed` gives the same calls but returns `LLMResponse` / `PromiseSettledResult<LLMResponse>[]` with `usage` (`inputTokens`, `outputTokens`, `thoughtTokens`, `cachedInputTokens`, `totalTokens`, `searchQueries`, `estimatedCostUsd`), `attempts`, `durationMs`, `finishReason`, `fromCache` and `viaBatch`. It is built from the same usage metadata the wrapper already records, so accounting is unchanged.
  - Where a call site today uses `mapWithConcurrency` and handles failures per item, migrate it to `askDetailed(prompts)` so its partial-failure behaviour stays identical. Otherwise keep the site's own loop around single `ask` calls. Choose per site, whichever keeps the request stream identical.
- `usageTotals()` returns per-stage totals. The pipeline's run record uses them in PR 2.
- `askJson` = `json: true` + `parseJsonArray` + optional zod + one retry on an empty answer.
  - Only use the retry where the old call site already retried. Otherwise pass `retryEmpty: false`, so the number of requests stays identical.
- `cache` option backed by `CacheStore`. The key derivation is the same as `adapters/extractionCache.ts` (input text + prompt version), so existing cache files in `data/_cache/extractions` stay valid. Test that an existing entry is read.
- `replay` mode: the same record and replay semantics as the step 1 seam, using the **same line format**, so the goldens apply unchanged.
- `LLMUnavailableError` is thrown for a missing key.
- **Batch transport, Gemini (`src/batch.ts` + `providers/gemini.ts`).** `ask(prompts, { batch: true | { deadlineMs } })` does the following:
  1. Submits one Gemini Batch Mode job. Inline requests are used under 20 MB; above that, a JSONL file.
  2. Persists the job ID via the injected `BatchStore` **before** polling.
  3. Polls with backoff until the job completes or `deadlineMs` passes.
  4. Maps the results back in input order, and records usage at batch pricing (50%; add batch prices to `pricing.ts` with a source comment).

  On resume, a stored job ID for the same request hash is collected, not resubmitted.
  - **Verify against the current docs** whether batch requests support `googleSearch` grounding, `systemInstruction`, JSON mode and thinking config. For anything unsupported, throw `BatchNotSupportedError` naming the option. Never drop it silently.
  - Tests use recorded batch-create, batch-get and results fixtures. **No stage passes `batch` in PR 1.** Adoption is a follow-up (PLAN §11 Q3).

### 4. Pipeline side

- `src/io/usage.ts` implements `UsageSink` using the moved persistence code, so the paths and file format are identical.
- `src/io/fileCache.ts` implements `CacheStore` over `data/_cache/extractions`.
- `src/io/batchStore.ts` implements `BatchStore` under `data/_cache/llm-batches`. It is created now so the transport is testable end to end, but nothing uses it yet.
- `src/llmBootstrap.ts` calls `configureLLM({ usage, cacheStore, batchStore, replay: env… })` once. Every CLI that makes model calls imports it first.

### 5. Migrate the nine call sites

Do them one commit each, in this order: `rank`, `venues`, `dedupeClassifier`, `annotate`, `llmExtract`, `discover`, `probe`, `google.ts` curate ×2.

- Each `geminiText(ai, {...})` becomes `ask(contents, { provider: "gemini", model: <same literal>, stage: <same>, … })` or `askJson`.
- Remove the per-module `new GoogleGenAI(...)`, and have missing-key checks catch `LLMUnavailableError` so the fallback is the same as today.
- Model literals stay at the call sites until 1.11 moves them to config.
- After **each** commit, re-run `scripts/llm-parity.mjs` for the affected CLI and `diff` it against the golden.

### 6. Remove the old paths

- Delete `geminiText`, the seam and the local limiter from `src/providers/gemini.ts`. Keep only what 1.7 still needs, `estimateUsd`/`recordUsage` for the search providers, as thin re-exports from `@dothingslol/llm`.
- Delete `adapters/extractionCache.ts`.

### 7. `CLAUDE.md`

Update "Calling models": the shared wrapper is now `@dothingslol/llm` (`ask` for strings and string arrays, `askDetailed` for usage metadata, `askJson`; `batch: true` for provider-native batch, which no stage uses yet). Add a pointer to the replay harness (`scripts/llm-parity.mjs`) as the way to verify any prompt-adjacent refactor.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| V2 | **Request parity** | `node scripts/llm-parity.mjs && git diff --exit-code test/golden/llm` | no diff for every CLI |
| V3 | No direct SDK use outside llm (Gemini) | `grep -rn "@google/genai\|geminiText(" src app \| grep -v "src/providers/google.ts"` | nothing (google.ts search path moves in 1.7) |
| V4 | Usage files unchanged in format | after a replay run of `rank`, compare `data/brisbane/usage/<week>.json` in the temporary data root with the step-1 run's | same keys, same counts |
| V5 | Extraction cache compatibility | test: an entry written by the old `extractionCache.ts` is a hit via `ask({ cache })` | passes |
| V6 | Budget semantics | unit test: `maxCalls: 2`, three calls → the third throws `BudgetExhaustedError` with the old message | passes |
| V6b | Batch transport | unit tests on recorded Gemini batch fixtures: submit, then persist the job ID, then resume without resubmitting, then map results in order, then the deadline error | pass |
| V6c | Metadata | `askDetailed` on a replayed call returns `inputTokens`, `outputTokens`, `totalTokens`, `estimatedCostUsd` equal to the usage the sink recorded | pass |
| V7 | Boundaries | `node scripts/check-boundaries.mjs` | exit 0 |
| V8 | Site unchanged | build + fingerprint | no diff |
| V9 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch. The goldens from step 1 stay useful even if the
package design changes.
