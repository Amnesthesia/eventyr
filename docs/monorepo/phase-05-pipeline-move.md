# Phase 05: Move the pipeline to `apps/pipeline`

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 05 (pipeline move) of the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-05-pipeline-move.md`, and no other phase files.
> Branch `monorepo/phase-05-pipeline-move` from the latest `main`. Follow the ordered steps, use
> `git mv` for every move, run every verification command, and paste the results into the PR
> description. If a check fails and the fix isn't obvious and in this phase's scope, stop and
> report. Open a PR; don't merge; don't start phase 06. **This phase changes every workflow
> that runs the pipeline. Whoever merges must follow the merge-window rule in PLAN.md §4.**

## Goal

After phase 04, what's left of `src/` is entirely pipeline. It becomes `@dothingslol/pipeline`
at `apps/pipeline`. The root `package.json` shrinks to proxy scripts, so `pnpm collect`,
`pnpm probe-sources --city=X` and the other documented commands keep working from the repo root.
Workflows stop invoking `src/*.ts` by path. `data/`, `sources/` and the root `{CITY}.md` files
stay where they are.

## Preconditions

- Phase 04 is merged, and at least one digest run since then has committed successfully to `apps/web/public`.
- The `digest` concurrency group is idle, and you are outside the Saturday 18:00–23:00 UTC window.
- Open question Q2 (WhatsApp) is answered. The default is to move `messaging.ts` as it is.

## Files affected

- `git mv src apps/pipeline/src`. This moves every remaining module, `adapters/`, `providers/`, all 29 tests, and `src/tsconfig.json`.
- `git mv tsconfig.scripts.json apps/pipeline/tsconfig.json`, then delete `apps/pipeline/src/tsconfig.json`. It only existed to extend the old file for editors.
- New file: `apps/pipeline/package.json`.
- Root `package.json`, which becomes the workspace root: scripts only, with devDependencies `@biomejs/biome` and `typescript`.
- `apps/pipeline/src/common.ts`: the `PROJECT_ROOT` anchor.
- `apps/pipeline/src/locality.test.ts`: isolate it from the real data.
- Workflows:
  - `.github/workflows/digest.yml` lines 118–119, 207, 213, 216, 221, 227 and 275
  - `.github/workflows/add-city.yml` line 49
  - `.github/workflows/reprobe.yml` lines 121 and 147
- `biome.json`, `CLAUDE.md` and `README.md` (paths).

## Steps

1. **Baseline on `main`.** Copy `data/`, `apps/web/public/` and `BRISBANE.md` to `/tmp/before/`, then run the deterministic stages (listed in V4) in a `main` worktree and copy their outputs to `/tmp/before-run/`.
2. **Moves.** Do the two `git mv`s in a single commit with no content changes.
3. **Re-anchor the paths in `common.ts`.** Right now the file resolves `".."` from `src/`. Replace that with a walk up to the directory containing `pnpm-workspace.yaml`, so the anchor survives phase 07's reorganisation:
   ```ts
   function findRepoRoot(from: string): string {
     for (let dir = from; ; dir = dirname(dir)) {
       if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
       if (dirname(dir) === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`);
     }
   }
   export const PROJECT_ROOT = process.env.EVENTYR_REPO_ROOT ?? findRepoRoot(dirname(fileURLToPath(import.meta.url)));
   ```
   - `DATA_ROOT`, `SOURCES_ROOT` and `WEB_PUBLIC_DIR` don't change; they derive from `PROJECT_ROOT`.
   - Update the comment above it to say why the lookup walks up.
   - Run `grep -rn "process.cwd()\|import.meta.url" apps/pipeline/src`. Every hit must either go through `PROJECT_ROOT` or be a basename-only main guard (`ai.ts:664`, `rss.ts:184`, `venues.ts:493`, `adapters/{discover,render,triage,probe}.ts`). Those guards compare only the basename, so the move doesn't affect them. Confirm each one.
4. **`apps/pipeline/package.json`:**
   - `"name": "@dothingslol/pipeline"`, `"private": true`, `"type": "module"`.
   - **dependencies:** `@anthropic-ai/sdk`, `@google/genai`, `openai`, `chrono-node`, `fast-xml-parser`, `got-scraping`, `he`, `ical.js`, `js-yaml`, `playwright`, `@dothingslol/core: workspace:*`.
   - **devDependencies:** `@types/he`, `@types/js-yaml`, `@types/node`, `tsx: catalog:`, `typescript: catalog:`.
   - Re-check each dependency with `grep -rlE "from ['\"]<dep>" apps/pipeline/src` before moving it off the root.
   - **Scripts:** move every pipeline script from the root, rewriting it as `tsx --env-file-if-exists=../../.env --tsconfig tsconfig.json src/<file>.ts`.
     - The `.env` file stays at the repo root, and pnpm runs scripts with cwd set to `apps/pipeline`. That's why the path is `../../.env`.
     - Add `"triage": "tsx --tsconfig tsconfig.json src/adapters/triage.ts"`. `reprobe.yml` currently calls the file directly.
     - Add `"test": "tsx --tsconfig tsconfig.json --test 'src/**/*.test.ts'"` and `"typecheck": "tsc --noEmit -p tsconfig.json"`.
5. **Root `package.json` becomes proxies.** Give every documented command a root script `"<name>": "pnpm --filter @dothingslol/pipeline <name>"`. The full list: `collect`, `collect-adapters`, `curate`, `venues`, `dedupe-venues`, `rank`, `geocode`, `markdown`, `ical`, `rss`, `pages`, `build-ai`, `messaging`, `add-city`, `probe-sources`, `discover-sources`, `test-adapter`, `render-sources`, `triage`.
   - Set `test:pipeline` to `pnpm --filter @dothingslol/pipeline test`.
   - `check` becomes:
     ```
     pnpm -r typecheck && biome check apps packages scripts && pnpm -r test && node scripts/check-boundaries.mjs
     ```
   - Check that the proxies pass arguments through. pnpm appends extra arguments to the script command. Run `pnpm probe-sources --city=doesnotexist`: it must fail with the unknown-city error, not with a missing-`--city` error. Run `pnpm collect anthropic` with no keys set: it must fail on the missing key for *anthropic*, which proves the argument arrived.
6. **Isolate `locality.test.ts`.** At the moment it writes into the real `DATA_ROOT` (lines 181–229). Make it create an `mkdtemp` directory and set `process.env.EVENTYR_DATA_ROOT` *before* it dynamically imports the modules under test. `DATA_ROOT` is computed when the module loads, so a static import would read the variable too early. Then `git status` after `pnpm test` must be clean.
7. **Workflows.**
   - **`digest.yml`:**
     - The "Typecheck and test" step becomes `pnpm -r typecheck && pnpm -r test`.
     - Replace each `pnpm tsx --tsconfig tsconfig.scripts.json src/<x>.ts` with `pnpm <script>`: `rank`, `geocode`, `markdown`, `ical`, `pages`, `messaging`.
     - Keep every step's `env:` block unchanged.
   - **`add-city.yml`:** `pnpm add-city`.
   - **`reprobe.yml`:** `pnpm triage --render-candidates`, and `pnpm triage` for the report step. Keep all other arguments as they are.
   - `actions/cache` paths (`data/_cache`, `data/_raw`) and the `git add` list don't change.
8. **Tooling and docs.**
   - In `biome.json`, change the `src/**` includes to `apps/pipeline/src/**`.
   - In `CLAUDE.md`, change every `src/<file>` reference to `apps/pipeline/src/<file>`. There are many. Keep the text otherwise identical, and add one sentence saying the root scripts are proxies.
   - In `README.md`, update the paths, including in the Mermaid diagram if it names files.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0, same test count as the baseline |
| V2 | Tests don't touch real data | `pnpm test:pipeline && git status --porcelain data/` | empty |
| V3 | No stray data directory | `find apps -maxdepth 3 -name data -type d` | no output |
| V4 | Publish parity | In both the branch and a `main` worktree, run `for c in brisbane goldcoast sunnycoast; do CITY=$c TZ=Australia/Brisbane pnpm geocode; CITY=$c pnpm ical; done; TZ=Australia/Brisbane pnpm markdown; pnpm rss; pnpm pages; pnpm build-ai`, then `diff -r` the two sets of `data/*.json`, `apps/web/public` and `*.md` | identical |
| V5 | Arguments pass through | the two commands in step 5 | they fail for the expected reason |
| V6 | add-city still edits `digest.yml` | the scratch-worktree check from phase 00 V7, using `pnpm add-city` | the option is added |
| V7 | Offline triage | `pnpm triage` (reads `data/_probe` when present; otherwise confirm it exits with its usual "no probe data" message) | same behaviour as `main` |
| V8 | Workflow syntax | `actionlint .github/workflows/*.yml` | clean |
| V9 | Site still builds | `TZ=Australia/Brisbane pnpm build` plus the fingerprint diff | no diff |
| V10 | PR CI | `CI` | green |

**After merge, straight away:**
1. `Deploy to GitHub Pages` finishes green. The site is unaffected, so the curl list from phase 04 is enough.
2. Dispatch `digest.yml` with `brisbane` and `force=false`. Every step must go green. In the logs, check that `rank`, `geocode`, `markdown`, `ical`, `pages` and `build-ai` ran through the new scripts, and that the commit step's `git add` found its paths.
3. Wait for the next scheduled `weekly.yml` on Saturday at 20:00 UTC, and `reprobe.yml` on the 3rd of the month. Check both. Phase 06 can proceed in the meantime.

## Rollback

Revert the squash merge before the next scheduled `weekly.yml`. Digest commits after this phase
only touch `data/`, `apps/web/public/` and `*.md`, none of which moved here, so a revert applies
cleanly even after a digest run.
