# Phase 07 — Pipeline internal boundaries (optional)

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 07 (pipeline boundaries) of the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-07-pipeline-boundaries.md`, and no other
> phase files. Branch `monorepo/phase-07-pipeline-boundaries` from the latest `main`. Follow the
> ordered steps, use `git mv` for every move, run every verification command, and paste the
> results into the PR description. If a check fails and the fix is not obvious and within this
> phase's scope, stop and report. Open a PR and do not merge it. **The phase is large enough that
> each numbered step should be its own commit; if the session's context gets tight, stop after a
> completed step, push, and report where you stopped.** Follow the merge-window rule in PLAN.md §4.

## Goal

Untangle the five coupling knots listed in PLAN §1.2 and reorganise `apps/pipeline/src` into
directories with boundaries enforced by `scripts/check-boundaries.mjs`. After this phase:

- `scrape/` is LLM-free.
- `llm/` doesn't know about `curate/` or `publish/`.
- Extracting `scraper` or `llm` as packages later only means moving a directory and adding a `package.json`.

This phase changes no behaviour. **It is optional (PLAN Q10) and doesn't block native work.**

## Preconditions

- Phase 05 is merged. Phase 06 isn't required.
- No digest is in flight, and it's outside the Saturday window. Workflows only call `pnpm <script>`, so as long as the pipeline `package.json` scripts are updated, workflows need no edits.

## Target layout

```
apps/pipeline/src/
  config/   paths.ts (PROJECT_ROOT, DATA_ROOT, SOURCES_ROOT, WEB_PUBLIC_DIR, curatedPath, raw/cache paths)
            cityConfig.ts (loadCityConfig, SourceEntry, llmSourceStrings, scraperSources)
            interests.ts (INTERESTS)   week.ts (getWeekRange, fmtDate, publishing window: single impl)
            env.ts (requireEnv)        index.ts (re-exports, so existing `common.ts` importers migrate gradually)
  util/     concurrency.ts (mapWithConcurrency, chunkArray)   json.ts (parseJsonArray)   text.ts
  llm/      gemini.ts (wrapper; usage sink injected), usage.ts (writes data/{city}/usage), providers/*.ts
  scrape/   fetch, feeds, extract, embeddedJson, readableText, dates, candidate, pageAdapter, runner,
            registry, render, enrichTimes, extractionCache, normalise, types
  enrich/   annotate.ts, llmExtract.ts            (LLM steps over scraped content)
  collect/  collection.ts (AI search), scrape.ts (was adapters/collect.ts)
  curate/   curate.ts, dedupe.ts, dedupeClassifier.ts, locality.ts, venues.ts, rank.ts, rankReuse.ts,
            sourceYield.ts, geocode.ts, templates.ts (isRetiredTemplateDescription)
  publish/  markdown.ts, ical.ts, rss.ts, pages.ts, ai.ts
  sources/  add_city.ts, probe.ts, discover.ts, triage.ts, testUrl.ts
  notify/   whatsapp.ts (was messaging.ts, or deleted per PLAN Q2)
```

Allowed imports. Add them to `check-boundaries.mjs` as a directory-level rule for `apps/pipeline/src`:

| From ↓ may import → | config | util | llm | scrape | enrich | collect | curate | publish | sources | notify |
|---|---|---|---|---|---|---|---|---|---|---|
| config | ✓ | ✓ | | | | | | | | |
| util | | ✓ | | | | | | | | |
| llm | ✓ | ✓ | ✓ | | | | | | | |
| scrape | ✓ | ✓ | | ✓ | | | | | | |
| enrich | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | |
| collect | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | | |
| curate | ✓ | ✓ | ✓ | ✓ (types, normalise helpers) | ✓ | | ✓ | | | |
| publish | ✓ | ✓ | | | | | | ✓ | | |
| sources | ✓ | ✓ | ✓ | ✓ | ✓ | | | | ✓ | |
| notify | ✓ | ✓ | | | | | | | | ✓ |

All of these may also import `@dothingslol/core`.

## Steps

Each step is one commit, and `pnpm check` must pass after each.

1. **Utilities out of `providers/base.ts`.**
   - Move `mapWithConcurrency`, `chunkArray` and `parseJsonArray` to `util/`.
   - Re-export them from `base.ts` for this commit only.
   - Update `enrichTimes.ts:39`, `collect.ts:28`, `discover.ts:40`, `locality.ts:38`, `venues.ts:39` and `rank.ts:14`, then drop the re-export.
2. **Split `common.ts`** into `config/*`. Keep `common.ts` as a re-export barrel while its 33 importers move over, then delete it in the last commit of this step.
   - `dedupeEvents` (`common.ts:482`, used by `providers/google.ts`) goes to `curate/` if only curation-like code uses it. Otherwise it goes to `util/`.
3. **Decouple `gemini.ts` from pipeline state.**
   - The wrapper takes a `UsageSink` (`record(provider, model, tokens, cost)`) instead of importing `DATA_ROOT`/`getWeekRange` and reading `process.env.CITY` at `:344`.
   - `llm/usage.ts` implements the file sink.
   - Entrypoints (CLIs) construct it once and pass it in, so there is still one shared instance per process (CLAUDE.md rule).
   - The price table stays with the wrapper.
4. **Move `isRetiredTemplateDescription`** out of `adapters/annotate.ts:261` into `curate/templates.ts`. `curate.ts` then stops loading `@google/genai` through `annotate`.
5. **Single publishing window.** Replace the two implementations (`adapters/collect.ts:83-84`, `curate.ts:66-70`) with one in `config/week.ts`. Before deleting either, confirm they are semantically identical with a table-driven test over Sunday, Monday, the Saturday boundary, and events straddling a week edge.
6. **Directory moves** (`git mv`, one directory per commit), following the layout above.
   - Update pipeline `package.json` script paths after each move.
   - Keep file basenames unchanged, because the main guards compare basenames (PLAN §1.6). The exceptions are `adapters/collect.ts` → `collect/scrape.ts` and `messaging.ts` → `notify/whatsapp.ts`: update their guards, or the scripts that call them, explicitly.
7. **Enforce.** Add the directory table to `check-boundaries.mjs`. Verify it by temporarily importing `llm/gemini.ts` from `scrape/fetch.ts`: the check must fail.
8. **Docs.** Update every `src/…` path in `CLAUDE.md`, the pipeline list, the "Key files" section and the `adapters/` description. Add the boundary table in short form.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks after every commit | `pnpm check` | exit 0 |
| V2 | No behaviour change | Publish parity (phase 05, V4) against a `main` worktree | identical |
| V3 | Scrape is LLM-free | `grep -rn "@google/genai\|llm/" apps/pipeline/src/scrape` | no output |
| V4 | `gemini.ts` is decoupled | `grep -n "DATA_ROOT\|process.env.CITY\|getWeekRange" apps/pipeline/src/llm/gemini.ts` | no output |
| V5 | Scripts still resolve | `for s in collect collect-adapters curate venues rank geocode markdown ical rss pages build-ai add-city probe-sources discover-sources test-adapter render-sources triage; do node -e "const p=require('./apps/pipeline/package.json');const f=p.scripts['$s'].match(/src\/\S+\.ts/)[0];require('fs').accessSync('apps/pipeline/'+f)" \|\| echo MISSING $s; done` | no MISSING |
| V6 | Usage accounting still writes | Needs `GOOGLE_API_KEY`, costs roughly one small call. `CITY=brisbane pnpm test-adapter <a known scraper listing URL>`, then check `data/brisbane/usage/` | the week's file gains an entry |
| V7 | PR CI | `CI` | green |

**After merge:** dispatch `digest.yml` with `brisbane` and `force=false`. It should go green, and the
usage file for this week should update.

## Rollback

Revert the squash-merge. Because each step is its own commit, you can also revert a single step.
This phase only moves code and never touches data paths, so digest commits made after it don't
conflict with a revert.
