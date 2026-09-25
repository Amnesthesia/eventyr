# Sub-phase 1.11: Restructure the pipeline into config, stage functions and CLIs

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.11 (pipeline restructure) of PR 1, the eventyr monorepo refactor.
>
> - Read `docs/monorepo/PLAN.md` (especially §2.6, §2.7 and §9) and `docs/monorepo/phase-1.11-pipeline-restructure.md`, and no other phase files.
> - Work on branch `monorepo/refactor`, even if your environment suggests another branch. If you can't push to it, stop and ask.
> - Sync first per PLAN §4.3.
> - This is the largest sub-phase. Each numbered step is one commit, and `pnpm check` plus both parity scripts must pass after every commit. If context gets tight, stop after a completed step, push, and report where you stopped. The next session resumes from the next step.
> - Run every verification, post the results as a comment on the PR 1 draft, and tick 1.11.
> - Push. Don't merge, and don't start 1.12.

## Goal

Turn `apps/pipeline` from a folder of scripts around the `common.ts` grab-bag into:

- **`config/`**:
  - `pipeline.yml` holds the models per stage and the operator tunables.
  - `interests.md` holds the interest profile.
  - Both are validated at load.
- **Exported stage functions** that take a `RunContext`. `src/index.ts` exports them (PLAN §2.6).
- **Thin `cli/` entrypoints.** One per `package.json` script. Each reads env and argv, builds the `RunContext`, and calls the stage. This replaces the basename-keyed main guards.
- **Directories by concern**, with import rules enforced.

Behaviour stays identical. Parity is proven by the llm and scrape goldens, the publish parity check, and a config snapshot.

## Preconditions

- 1.10 is committed on the branch.

## Target layout

```
apps/pipeline/
  config/pipeline.yml   config/interests.md
  src/
    config/   load.ts (zod schema + loader + env overrides), paths.ts, city.ts (sources yml via core schema),
              week.ts (getWeekRange, fmtDate, the single publishing window), env.ts (requireEnv), context.ts (RunContext)
    stages/   collectScraped.ts, collectSearch.ts, curate.ts, dedupe.ts, dedupeClassifier.ts, locality.ts,
              venues.ts, rank.ts, rankReuse.ts, sourceYield.ts, geocode.ts, annotate.ts, extract.ts (LLM fallback),
              normalise.ts, templates.ts
    search/   base.ts, google.ts, anthropic.ts, openai.ts, perplexity.ts   (strategies over @dothingslol/llm)
    publish/  markdown.ts, ical.ts, rss.ts, pages.ts, ai.ts
    sources/  addCity.ts, probe.ts, discover.ts, triage.ts, render.ts (promotion half), testUrl.ts, registry.ts
    io/       usage.ts, fileCache.ts, httpCache.ts, curatedFiles.ts, barren.ts
    cli/      one file per package.json script
    index.ts
```

Import rules, added to `check-boundaries.mjs` as a directory rule. Every directory may also import
`@dothingslol/*` according to PLAN §2.3.

| From | May import |
|---|---|
| `config` | — |
| `io` | `config` |
| `search` | `config`, `io` |
| `stages` | `config`, `io`, `search` |
| `publish` | `config`, `io` |
| `sources` | `config`, `io`, `stages` (`normalise`, `extract` only) |
| `cli` | anything |

## Steps

1. **Config snapshot first.**
   - Inventory every module-level SCREAMING_CASE constant in `apps/pipeline/src`. There were 211 at planning time, excluding prompts, regexes and prices.
   - Classify each one with the §2.6 rule as **config** (operator tunable) or **code** (safety cap, protocol fact, regex/prompt, or a value shared with web/native). Write the result as a table in the PR comment, with a one-line reason per config item.
   - Include every model literal (the nine call sites plus the search strategies), `GEMINI_CONCURRENCY`/`GEMINI_MAX_CALLS` defaults, batch sizes, timeouts, per-host rate limits and `aiWeekSplitBytes`.
   - Add `src/config/config.snapshot.test.ts`. It asserts the current value of each constant classified as config. This is the golden for step 3.
   - Commit.
2. **Dissolve `common.ts`.**
   - Split it into:
     - `config/paths.ts`: `PROJECT_ROOT`, `DATA_ROOT`, `SOURCES_ROOT`, `WEB_PUBLIC_DIR`, `curatedPath`, raw/cache paths
     - `config/city.ts`: `loadCityConfig`, `llmSourceStrings`, `scraperSources`
     - `config/week.ts`
     - `config/env.ts`
   - Move `dedupeEvents` (`common.ts:482`, used by `search/google`) to `stages/dedupe.ts` or `search/`, wherever its only callers are.
   - Leave `common.ts` as a re-export barrel for this commit. The final commit of this step removes it after all 33 importers are migrated.
   - The re-export of `@dothingslol/core/shared` goes away. Importers import `core` directly.
3. **`config/pipeline.yml` and `interests.md`.**
   - Write the YAML (shape in PLAN §2.6) with the values from step 1.
   - Move `INTERESTS` verbatim to `config/interests.md`. Add a test asserting byte equality with the old constant, then delete the constant.
   - `config/load.ts` does the following:
     - Parses the YAML with `js-yaml`.
     - Validates with zod. Model entries must be members of `@dothingslol/llm`'s `MODELS`, and the loader fails with the offending key path.
     - Applies env overrides for the variables workflows already set: `PROVIDERS`, `ANTHROPIC_TIERS`, `ANTHROPIC_SEARCH_MODEL`, `GEMINI_CONCURRENCY`, `GEMINI_MAX_CALLS`.
     - Returns a typed `PipelineConfig`.
   - Replace each constant classified as config with a read from `ctx.config`. The step 1 snapshot test now reads through the loader, and it must still pass unchanged.
   - `llmBootstrap` (1.6) takes its `configureLLM` values from the config.
4. **Unify the source schema.**
   - The three views of `sources/{city}.yml` become one zod schema in `packages/core/src/sources.ts`:
     - `SourceEntry` (`common.ts:133`)
     - `SourceDefinition` (`adapters/types.ts:36`)
     - `OrganizerSource` (`core/shared.ts:1089`)
   - Include `centre`, `timezone`, the tiers and the `venue.aliases`.
   - The pipeline's `config/city.ts` and web's `lib/organizers.ts` both parse through it.
   - Resolve the known disagreements as follows, and keep behaviour identical:
     - `homepage` optional vs `string|null`
     - `venue` optional vs `VenueRecord`
     - the three-value `method` union, whose comment says two
   - Test that all four real `sources/*.yml` files validate.
5. **Stage functions and `cli/`.** Do one stage per commit, in pipeline order:
   - `collectScraped` ← `adapters/collect.ts`
   - `collectSearch` ← `collection.ts`
   - `curate`, `canonicaliseVenues` ← `venues.ts`
   - `rank`, `geocode`
   - the publish functions
   - the `sources/*` tools

   For each one:
   - Move its body into `export async function <stage>(ctx: RunContext, opts)`.
   - Stop reading `process.env` at import time: `CITY`, `FORCE` and friends come in through `ctx`.
   - Return a small report object (`found → kept`, with the reasons for the gap), and make the CLI print what the script prints today. **stdout must be identical.** Capture it in the parity runs and diff it.
   - Create `cli/<script>.ts` with the env and argv parsing, `llmBootstrap`, the `RunContext` build, and the call.
   - Point the `package.json` script at the CLI file, and delete the old main guard.
6. **Directory moves.**
   - `git mv` the files into the target layout, one directory per commit.
   - `adapters/` and `providers/` disappear.
   - Update imports and CLI paths.
7. **Enforce.**
   - Add the directory rule to `check-boundaries.mjs`.
   - Prove it bites: temporarily import `publish/ai.ts` from `stages/rank.ts`. The check must fail. Revert.
8. **Exports and docs.**
   - `src/index.ts` exports the stage functions from PLAN §2.6.
   - Update `CLAUDE.md` throughout: the pipeline list, "Provider architecture", "Key files" and "Running locally". Add `config/pipeline.yml` as *the* place to change a model or tunable, and state the §2.6 rule for what belongs there.
   - Update the `README.md` Mermaid diagram paths.

## Verification

Run these after every commit where the step says so, and all of them at the end.

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| V2 | LLM and scrape goldens | `node scripts/llm-parity.mjs && node scripts/scrape-parity.mjs && git diff --exit-code apps/pipeline/test/golden` | no diff |
| V3 | Publish parity | 1.10 V4 against `/tmp/main-wt` | identical, apart from the approved D12 Byron differences |
| V4 | stdout parity | For `rank`, `curate`, `venues` and `collect-adapters` in replay mode on the fixture city, diff stdout between the branch before this sub-phase (tag it locally) and now | identical, or timing lines only |
| V5 | Config snapshot | `config.snapshot.test.ts` | passes through the loader |
| V6 | `common.ts` gone | `test ! -e apps/pipeline/src/common.ts && git grep -n "common.ts" -- apps packages` | nothing |
| V7 | No env reads at import | `grep -rn "process.env" apps/pipeline/src \| grep -v "src/cli/\|src/config/"` | nothing |
| V8 | No main guards | `grep -rn "process.argv\[1\]\|import.meta.url === " apps/pipeline/src \| grep -v src/cli/` | nothing |
| V9 | Invalid config fails loudly | set `models.rank.model: nope` in a temporary copy, then run `pnpm rank` | exits with a message naming `models.rank.model` |
| V10 | Boundaries | `node scripts/check-boundaries.mjs` | exit 0 |
| V11 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch. Because steps are separate commits, you can revert
back to any completed step.
