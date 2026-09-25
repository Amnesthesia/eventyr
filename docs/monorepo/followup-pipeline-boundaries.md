# Follow-up (not in PR 1 or PR 2): pipeline internal boundaries

> **Handoff: paste into a fresh Claude Code session. Only do this after PR 1 is merged, and only if the owner asks.**
>
> Run the eventyr pipeline-boundaries follow-up.
>
> - Read `docs/monorepo/PLAN.md` and `docs/monorepo/followup-pipeline-boundaries.md`, and no other phase files.
> - Work on a new branch, `refactor/pipeline-boundaries`, from `origin/main`.
> - Each numbered step is one commit, and `pnpm check` must pass after every commit. If context gets tight, stop after a completed step, push, and report.
> - Open a PR and don't merge it. Follow the merge window in PLAN §4.4.

## Why

There are five coupling knots inside `apps/pipeline/src`, listed in PLAN §1.2 item 3. They keep
`scrape`, `llm` and `curate` tangled, and they make swapping the model provider harder than it
should be. You said provider switching is wanted but out of scope for now (D1). This follow-up is
the behaviour-preserving groundwork: after it, `llm/` is one directory behind a small interface,
and making the provider pluggable becomes a focused change.

## Target layout

```
apps/pipeline/src/
  config/   paths.ts, cityConfig.ts, interests.ts, week.ts (getWeekRange + the single publishing window), env.ts
  util/     concurrency.ts (mapWithConcurrency, chunkArray), json.ts (parseJsonArray), text.ts
  llm/      gemini.ts (wrapper; usage sink injected), usage.ts, providers/*.ts
  scrape/   fetch, feeds, extract, embeddedJson, readableText, dates, candidate, pageAdapter, runner,
            registry, render, enrichTimes, extractionCache, normalise, types
  enrich/   annotate.ts, llmExtract.ts
  collect/  collection.ts, scrape.ts (was adapters/collect.ts)
  curate/   curate, dedupe, dedupeClassifier, locality, venues, rank, rankReuse, sourceYield, geocode, templates.ts
  publish/  markdown, ical, rss, pages, ai
  sources/  add_city, probe, discover, triage, testUrl
```

## Import rules

`scripts/check-boundaries.mjs` gets a directory rule for `apps/pipeline/src`. Every directory may
import itself and `@dothingslol/core`. Beyond that:

| Directory | May also import |
|---|---|
| `config` | `util` |
| `util` | nothing |
| `llm` | `config`, `util` |
| `scrape` | `config`, `util` (**never** `llm`) |
| `enrich` | `config`, `util`, `llm`, `scrape` |
| `collect` | `config`, `util`, `llm`, `scrape`, `enrich` |
| `curate` | `config`, `util`, `llm`, `enrich`, and `scrape` types and normalise helpers only |
| `publish` | `config`, `util` |
| `sources` | `config`, `util`, `llm`, `scrape`, `enrich` |

## Steps

1. **Move the utilities out of `providers/base.ts`.** `mapWithConcurrency`, `chunkArray` and `parseJsonArray` go to `util/`.
   - Update the importers: `enrichTimes.ts:39`, `collect.ts:28`, `discover.ts:40`, `locality.ts:38`, `venues.ts:39`, `rank.ts:14`.
2. **Split `common.ts` into `config/*`.** Keep `common.ts` as a re-export barrel while its 33 importers move over, then delete it.
3. **Decouple `gemini.ts`.** It should take a `UsageSink` (`record(provider, model, tokens, cost)`) instead of reading `DATA_ROOT`, `getWeekRange` and `process.env.CITY`.
   - `llm/usage.ts` implements the file sink.
   - Each CLI constructs one sink and passes it in, so there is still one shared instance per process.
4. **Move `isRetiredTemplateDescription`** from `adapters/annotate.ts:261` to `curate/templates.ts`. `curate.ts` then stops loading `@google/genai`.
5. **One publishing window.** Replace the two implementations (`adapters/collect.ts:83-84` and `curate.ts:66-70`) with one in `config/week.ts`.
   - Before deleting either, prove they're identical with a table-driven test covering Sunday, Monday, the Saturday boundary, and events that straddle the week edge.
6. **Directory moves.** `git mv` one directory per commit, updating the pipeline `package.json` script paths each time.
   - Keep basenames: main guards compare them (PLAN §1.6).
   - The one rename is `adapters/collect.ts` → `collect/scrape.ts`. Update its guard or its script.
7. **Enforce the rules** in `check-boundaries.mjs`. Prove it works by temporarily importing `llm/gemini.ts` from `scrape/fetch.ts`: the check must fail.
8. **Docs.** Update every `src/…` path in `CLAUDE.md` and add the rules table.

## Verification

| # | Check | Pass condition |
|---|---|---|
| V1 | `pnpm check` after every commit | exit 0 |
| V2 | Publish parity against an `origin/main` worktree (1.6 V4) | identical |
| V3 | `grep -rn "@google/genai\|llm/" apps/pipeline/src/scrape` | nothing |
| V4 | `grep -n "DATA_ROOT\|process.env.CITY\|getWeekRange" apps/pipeline/src/llm/gemini.ts` | nothing |
| V5 | Every `package.json` script path exists | all resolve |
| V6 | Needs `GOOGLE_API_KEY`: `CITY=brisbane pnpm test-adapter <a known listing URL>` | `data/brisbane/usage/` gains an entry |
| V7 | After merge: dispatch `digest.yml` (brisbane, `force=false`) | green; the usage file updates |

## Rollback

Revert the merge commit. Only code moves in this follow-up; no data paths change.
