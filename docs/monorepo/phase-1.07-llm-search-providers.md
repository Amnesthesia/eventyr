# Sub-phase 1.7: Search providers through `@dothingslol/llm`

> **Handoff: paste into a fresh Claude Code session**
>
> Execute sub-phase 1.7 (llm search providers) of PR 1, the eventyr monorepo refactor.
>
> - Read `docs/monorepo/PLAN.md` (especially §2.4 and §9) and `docs/monorepo/phase-1.07-llm-search-providers.md`, and no other phase files.
> - Work on branch `monorepo/refactor`, even if your environment suggests another. If you can't push to it, stop and ask.
> - Sync first, as PLAN §4.3 says.
> - Step 1 records goldens on the unmigrated code. Each numbered step is one commit.
> - Run every verification, post the results as a comment on the PR 1 draft, and tick 1.7.
> - If request parity fails, stop and report. Don't regenerate goldens to make it pass.
> - Push, but don't merge, and don't start 1.8.

## Goal

Move the SDK transport for grounded web search into `llm`, for all four providers:

| Provider | Today |
|---|---|
| Gemini | `googleSearch` via `GoogleProvider.searchEvents` |
| Anthropic | `messages.create` with the `web_search_20250305` tool |
| OpenAI | `responses.create` with the `web_search` tool (`gpt-5*`), or `chat.completions` otherwise |
| Perplexity | `chat.completions` via the openai SDK at `api.perplexity.ai` |

The pipeline's `BaseProvider` becomes a **search strategy**. It builds the prompts from `INTERESTS` and the source lists, calls `ask(prompt, { ...provider, search: true })`, parses the events and writes curated files, all exactly as it does today.

Requests must be byte-identical.

## Preconditions

- 1.6 is committed. The replay format, `scripts/llm-parity.mjs` and the fixture city exist.

## Files affected

- **New:** `packages/llm/src/providers/{anthropic,openai,perplexity}.ts`, plus tests.
- **Edited:**
  - `packages/llm/src/providers/gemini.ts`: the search path.
  - `packages/llm/package.json`: `@anthropic-ai/sdk` and `openai` move here from the root.
  - `src/providers/{base,google,anthropic,openai,perplexity}.ts`: these become strategies with no SDK imports.
  - `src/collection.ts`.
- **Deleted:** what's left of `src/providers/gemini.ts`.

## Steps

1. **Record the search goldens.**
   - Extend the 1.6 seam, which is still available through `llm`'s replay mode for Gemini, to the three SDK call sites in the *old* provider files: `anthropic.ts:78`, `openai.ts:60/68`, `perplexity.ts:67`.
   - Record, per call, the normalised request: `{provider, stage, model, <full SDK request body with keys sorted>}`.
   - Write canned responses for each shape: an Anthropic message with `server_tool_use`, an OpenAI `responses` output with `web_search_call` items, a Perplexity chat completion, and a grounded Gemini response.
   - Run `pnpm collect <provider>` on the fixture city for each of `google`, `anthropic`, `openai`, `perplexity`, with `PROVIDERS` and `ANTHROPIC_TIERS=aggregators,institutions` set as `digest.yml` sets them. Store the recordings as `test/golden/llm/collect-<provider>.jsonl`.
   - Also record one `openai` run with a non-`gpt-5` model, so the `chat.completions` branch is covered.
   - Commit these on their own.
2. **Providers in `llm`.** Each adapter maps `AskOptions` onto exactly the request the old provider sent:
   - **Anthropic:** `search: true` → the same `tools` entry (type `web_search_20250305`, same `name`, same `max_uses` and any other fields, passed through `providerOptions` if they are provider-specific). Same `max_tokens` and `system`/`messages` layout. Usage comes from `response.usage` including `server_tool_use.web_search_requests`, recorded exactly as `anthropic.ts:114-129` does today.
   - **OpenAI:** `gpt-5*` → `responses.create` with `tools: [{ type: "web_search", search_context_size: "low" }]`; anything else → `chat.completions.create`. This is today's branch at `openai.ts:30`. Usage accounting follows `openai.ts:106-119`.
   - **Perplexity:** the openai SDK with `baseURL: "https://api.perplexity.ai"`, and the same request fields as `perplexity.ts:67`.
   - **Gemini search:** `search: true` → `tools: [{ googleSearch: {} }]`, plus `searchQueries` accounting from `groundingMetadata.webSearchQueries`.
   - **Keys:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `GOOGLE_API_KEY` by default. A missing key throws `LLMUnavailableError`, and `collection.ts` keeps its current "skip provider with a warning" behaviour.
   - **Concurrency:** today only Gemini goes through a limiter. Give the other three providers **no ceiling** (`Infinity`) so behaviour is unchanged, and add a comment in `client.ts` noting this as a known asymmetry to revisit.
   - **Model selection:** `ANTHROPIC_SEARCH_MODEL` (`anthropic.ts:18`) keeps working. The strategy reads it and passes it as `model`. If it names a model not in `MODELS`, fail fast with a clear message.
2b. **Batch transports for Anthropic and OpenAI (built, unused; D14).**
   - Anthropic uses Message Batches. OpenAI uses the Batch API, with a JSONL upload and the `/v1/responses` or `/v1/chat/completions` endpoint to match the sync branch.
   - Both follow the same contract as Gemini's in 1.6: job IDs persisted via `BatchStore` before polling, resume without resubmitting, results in input order, batch pricing in `pricing.ts`.
   - Perplexity throws `BatchNotSupportedError` (it has no batch API).
   - **Check the current docs** for whether batched requests support the `web_search` tools. If not, `batch` combined with `search` throws `BatchNotSupportedError`.
   - Test these with recorded fixtures only.
3. **Strategies.**
   - `BaseProvider` and its subclasses keep `name`, `tiers`, prompt building, `parseEvents` and `collect()` (which writes curated files). The SDK clients and usage code are removed.
   - `searchEvents()` becomes one `askDetailed()` call plus the parsing that was already there. The `LLMResponse.usage` it gets back feeds the in-memory `SearchCollectResult` that 1.11 types. Curated files on disk keep their exact format.
   - `GoogleProvider.curate`, migrated in 1.6, stays where it is.
   - Rename nothing in this sub-phase. The move to `pipeline/search/` happens in 1.11.
4. **Remove** `src/providers/gemini.ts`, and remove the SDK dependencies from the root `package.json`.
5. **`CLAUDE.md`.** In "Provider architecture", note that providers are search strategies over `@dothingslol/llm`, and that transport, limits and accounting live in the package.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| V2 | Search request parity | `node scripts/llm-parity.mjs && git diff --exit-code test/golden/llm` | no diff, including all four `collect-*` goldens and the non-`gpt-5` branch |
| V2b | Concurrency kept (D19) | peak in-flight and wall-clock for `pnpm collect google,perplexity` in replay, against the step 1 recording. Providers and tiers still run concurrently (`Promise.all`) | peak ≥ golden; wall-clock within +10% |
| V2c | Cost report kept | captured stdout of each `collect` run against its golden | identical, including the `search/<provider>` usage and cost lines |
| V3 | Curated output parity | the replay runs from step 1: compare `data/brisbane/*/curated/*.json` in the temporary data root, old vs new | identical |
| V4 | No SDKs outside llm | `grep -rnE "@anthropic-ai/sdk\|from \"openai\"\|@google/genai" src app` | nothing |
| V5 | Missing key degrades | `PROVIDERS=anthropic pnpm collect` with no `ANTHROPIC_API_KEY` against the fixture | the same warning and exit behaviour as `origin/main` |
| V6 | Boundaries | `node scripts/check-boundaries.mjs` | exit 0 |
| V7 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch.
