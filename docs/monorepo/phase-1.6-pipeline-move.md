# Sub-phase 1.6: Remove WhatsApp, move the pipeline to `apps/pipeline`, add Byron to weekly

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.6 (pipeline move) of PR 1, the eventyr monorepo refactor.
> - Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.6-pipeline-move.md`, and no other phase files.
> - Work on branch `monorepo/refactor`, even if your environment suggests another. If you can't push to it, stop and ask.
> - Sync first as PLAN §4.3 says.
> - Follow the ordered steps, and use `git mv` for every move.
> - Run every verification, post the results as a comment on the PR 1 draft, and tick 1.6.
> - If a check fails and the fix isn't obvious and within scope, stop and report.
> - Push. Don't merge, and don't start 1.7.

## Goal

1. Delete the WhatsApp digest completely (PLAN D2).
2. Turn what's left of `src/` into `@dothingslol/pipeline` at `apps/pipeline`. The root `package.json` becomes proxy scripts, so `pnpm collect`, `pnpm probe-sources --city=X` and the other documented commands keep working from the repo root. Workflows stop calling `src/*.ts` by path.
3. Add Byron to `weekly.yml` (PLAN D5).

`data/`, `sources/`, `.env` and the root `{CITY}.md` files stay where they are.

## Preconditions

- 1.5 is committed on the branch.

## Files affected

**WhatsApp removal:**
- Delete `src/messaging.ts`.
- Remove the `messaging` script from the root `package.json`.
- In `.github/workflows/digest.yml`, remove:
  - the "Send WhatsApp digest" step (around line 267)
  - the `recipient` input, under both `workflow_call` and `workflow_dispatch`
  - the `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` and `WHATSAPP_RECIPIENT` secret declarations
- In `.github/workflows/digest-manual.yml`, remove the `recipient` input and the `recipient:` pass-through.
- Update any doc mentions of the digest. `README.md:90` mentions WhatsApp only as a link-unfurl client, so **keep that line**.

**Move:**
- `git mv src apps/pipeline/src`
- `git mv tsconfig.scripts.json apps/pipeline/tsconfig.json`, then delete `apps/pipeline/src/tsconfig.json`

**Byron:** `.github/workflows/weekly.yml`.

**New and edited:**
- New: `apps/pipeline/package.json`.
- Edited:
  - root `package.json`
  - `apps/pipeline/src/common.ts` (`PROJECT_ROOT`)
  - `apps/pipeline/src/locality.test.ts`
  - the workflows: `digest.yml` lines 118–119, 207, 213, 216, 221 and 227; `add-city.yml` line 49; `reprobe.yml` lines 121 and 147
  - `biome.json`, `CLAUDE.md`, `README.md`

## Steps

1. **Baseline.** Create an `origin/main` worktree at `/tmp/main-wt` and install it. Keep it: V4 and 1.8 use it.
2. **Remove WhatsApp.** Do this in one commit, before the move, so there's less to move.
   - Run `git rm src/messaging.ts` and remove the `messaging` script.
   - Edit the two workflows as listed under "Files affected".
   - Then `grep -rniE "whatsapp|messaging\.ts|WHATSAPP_|recipient" .github src package.json CLAUDE.md README.md` must print only the README unfurl line.
3. **Move.** Run both `git mv`s in one rename-only commit.
4. **Re-anchor `PROJECT_ROOT`** in `common.ts`. It currently takes `".."` from `src/`. Replace that with a walk up to `pnpm-workspace.yaml`, so the anchor survives any later reorganisation:
   ```ts
   function findRepoRoot(from: string): string {
     for (let dir = from; ; dir = dirname(dir)) {
       if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
       if (dirname(dir) === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`);
     }
   }
   export const PROJECT_ROOT = process.env.EVENTYR_REPO_ROOT ?? findRepoRoot(dirname(fileURLToPath(import.meta.url)));
   ```
   - Update the comment so it explains why the lookup walks up.
   - `DATA_ROOT`, `SOURCES_ROOT` and `WEB_PUBLIC_DIR` derive from `PROJECT_ROOT` and don't change.
   - Run `grep -rn "process.cwd()\|import.meta.url" apps/pipeline/src`. Every hit must either go through `PROJECT_ROOT` or be a basename-only main guard (`ai.ts:664`, `rss.ts:184`, `venues.ts:493`, `adapters/{discover,render,triage,probe}.ts`). Confirm each one.
5. **`apps/pipeline/package.json`.**
   - `name: "@dothingslol/pipeline"`, `private`, `type: module`.
   - **dependencies:** `@anthropic-ai/sdk`, `@google/genai`, `openai`, `chrono-node`, `fast-xml-parser`, `got-scraping`, `he`, `ical.js`, `js-yaml`, `playwright`, `@dothingslol/core: workspace:*`.
   - **devDependencies:** `@types/he`, `@types/js-yaml`, `@types/node`, `tsx: catalog:`, `typescript: catalog:`.
   - Re-check each dependency with `grep -rlE "from ['\"]<dep>" apps/pipeline/src`.
   - **Scripts:**
     - Move each pipeline script from the root, rewritten as `tsx --env-file-if-exists=../../.env --tsconfig tsconfig.json src/<file>.ts`. `.env` stays at the root, and pnpm runs scripts with cwd `apps/pipeline`.
     - Add `triage: tsx --tsconfig tsconfig.json src/adapters/triage.ts`. `reprobe.yml` calls that file directly today.
     - Add `test: tsx --tsconfig tsconfig.json --test 'src/**/*.test.ts'` and `typecheck: tsc --noEmit -p tsconfig.json`.
6. **Root proxies.** Each documented command becomes `"<name>": "pnpm --filter @dothingslol/pipeline <name>"`:
   - `collect`, `collect-adapters`, `curate`, `venues`, `dedupe-venues`, `rank`, `geocode`
   - `markdown`, `ical`, `rss`, `pages`, `build-ai`
   - `add-city`, `probe-sources`, `discover-sources`, `test-adapter`, `render-sources`, `triage`

   Also:
   - `test:pipeline` becomes `pnpm --filter @dothingslol/pipeline test`.
   - `check` becomes `pnpm -r typecheck && biome check apps packages scripts && pnpm -r test && node scripts/check-boundaries.mjs`.
   - The root keeps `@biomejs/biome` and `typescript` as devDependencies only.
7. **Isolate `locality.test.ts`.** Lines 181–229 write into the real `DATA_ROOT`. Change the test to `mkdtemp` a directory and set `process.env.EVENTYR_DATA_ROOT` **before** dynamically importing the modules under test. A static import is too early, because `DATA_ROOT` is computed when the module loads.
8. **Workflows.**
   - **`digest.yml`:**
     - "Typecheck and test" becomes `pnpm -r typecheck && pnpm -r test`.
     - Each `pnpm tsx --tsconfig tsconfig.scripts.json src/<x>.ts` becomes `pnpm <script>` (`rank`, `geocode`, `markdown`, `ical`, `pages`).
     - Leave every `env:` block, the `actions/cache` paths and the git add list unchanged.
   - **`add-city.yml`:** `pnpm add-city`.
   - **`reprobe.yml`:** `pnpm triage --render-candidates`, and `pnpm triage` for the report step.
9. **Byron in the weekly run.** In `weekly.yml`, add a fourth job after `sunnycoast`:
   ```yaml
   byron:
     needs: sunnycoast
     uses: ./.github/workflows/digest.yml
     permissions:
       contents: write
     with:
       city: byron
       force: ${{ inputs.force || false }}
       providers: ${{ inputs.providers || 'google,perplexity' }}
     secrets: inherit
   ```
   Check `sources/byron.yml` has a `centre` and at least one source per tier, the same as the other cities. Byron's data is from the week of 2026-09-07, so its first weekly run does a full collection. PLAN §10 Q4 covers the cost.
10. **Tooling and docs.**
    - `biome.json`: change `src/**` to `apps/pipeline/src/**`.
    - `CLAUDE.md`: change every `src/<file>` to `apps/pipeline/src/<file>`. Add one sentence saying root scripts are proxies. Remove any WhatsApp or messaging mentions. Note that `weekly.yml` now runs four cities.
    - `README.md`: update the paths, and the Mermaid diagram if it names files or cities.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0. Test count = baseline, with no messaging tests (there were none) |
| V2 | Tests don't touch real data | `pnpm test:pipeline && git status --porcelain data/` | empty |
| V3 | No stray data directory | `find apps -maxdepth 3 -name data -type d` | nothing |
| V4 | Publish parity | Run `for c in brisbane goldcoast sunnycoast byron; do CITY=$c TZ=Australia/Brisbane pnpm geocode; CITY=$c pnpm ical; done; TZ=Australia/Brisbane pnpm markdown; pnpm rss; pnpm pages; pnpm build-ai` on the branch and in `/tmp/main-wt`, then `diff -r` the `data/*.json`, `*.md` and the public trees (`apps/web/public` vs `public`) | identical |
| V5 | Args pass through | `pnpm probe-sources --city=doesnotexist` fails with the unknown-city error, not a missing `--city` error. `pnpm collect anthropic` with no keys fails on the anthropic key specifically | failure for the expected reason |
| V6 | add-city still edits digest.yml | scratch-worktree check from 1.1 V7, using `pnpm add-city` | option added |
| V7 | Offline triage | `pnpm triage` | same behaviour as `pnpm tsx src/adapters/triage.ts` in `/tmp/main-wt` |
| V8 | WhatsApp gone | the step 2 grep | only the README unfurl line |
| V9 | Workflow syntax | `actionlint .github/workflows/*.yml` | clean |
| V10 | Site still builds | build + fingerprint diff vs 1.5's result | no diff |
| V11 | PR CI | `CI` | green |

The live checks (a manual digest, then the first weekly run with Byron) are in the 1.8 runbook.

## Rollback

Revert this sub-phase's commits on the branch.
