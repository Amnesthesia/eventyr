# Sub-phase 1.10: Remove WhatsApp, then move the pipeline to `apps/pipeline`

> **Handoff: paste into a fresh Claude Code session**
>
> Execute sub-phase 1.10 (pipeline move) of PR 1, the eventyr monorepo refactor.
>
> - Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.10-pipeline-move.md`, and no other phase files.
> - Work on branch `monorepo/refactor`, even if your environment suggests another. If you can't push to it, stop and ask.
> - Sync first, as PLAN §4.3 says.
> - Follow the steps in order. Use `git mv` for every move.
> - Run every verification, post the results as a comment on the PR 1 draft, and tick 1.10.
> - If a check fails and the fix isn't obvious and in scope, stop and report.
> - Push. Don't merge, and don't start 1.11.

## Goal

1. Delete the WhatsApp digest completely (D2).
2. Move what's left of `src/`, which is now only pipeline code, to `@dothingslol/pipeline` at `apps/pipeline`. This is a **mechanical move**: internal reorganisation happens in 1.11.
   - The root `package.json` becomes proxy scripts, so `pnpm collect`, `pnpm probe-sources --city=X` and the rest keep working from the repo root.
   - Workflows stop calling `src/*.ts` by path.

Byron's time zone and its weekly slot were fixed in PR 0, before this PR. Nothing here touches them.

## Preconditions

- 1.9 is committed on the branch, so the site is in `apps/web`.

## Files affected

**WhatsApp**
- Delete `src/messaging.ts` and the `messaging` script.
- `digest.yml`: remove
  - the "Send WhatsApp digest" step,
  - the `recipient` input (both `workflow_call` and `workflow_dispatch`),
  - the three `WHATSAPP_*` secret declarations.
- `digest-manual.yml`: remove the `recipient` input and its pass-through.
- Leave `README.md:90` alone. It mentions WhatsApp only as a client that unfurls links.

**Move**
- `git mv src apps/pipeline/src`
- `git mv tsconfig.scripts.json apps/pipeline/tsconfig.json`, then delete `apps/pipeline/src/tsconfig.json`.
- Move `test/fixtures/llm-city` and `test/golden/*` (from 1.6–1.8) with `git mv` to `apps/pipeline/test/…`, and update `scripts/llm-parity.mjs` and `scripts/scrape-parity.mjs` to match.

**Other edits**
- New `apps/pipeline/package.json`. Edit the root `package.json`, `common.ts` (`PROJECT_ROOT`) and `locality.test.ts`.
- Workflows: `digest.yml` (lines 118–119, 207, 213, 216, 221, 227), `add-city.yml:49`, `reprobe.yml:121,147`.
- `biome.json`, `CLAUDE.md`, `README.md`.

## Steps

1. **Baseline.**
   - Create an `origin/main` worktree at `/tmp/main-wt` and install it. 1.13 reuses it.
   - Record the publish parity outputs (V4) and the llm and scrape goldens, which must still pass.
2. **Remove WhatsApp.** One commit, made before the move.
   - Afterwards, `grep -rniE "whatsapp|messaging\.ts|WHATSAPP_|recipient" .github src package.json CLAUDE.md README.md` should print only the README unfurl line.
3. **Move.** Both `git mv`s go in one commit with no content edits.
4. **Re-anchor `PROJECT_ROOT`** in `common.ts` by walking up to `pnpm-workspace.yaml`, so it survives 1.11's reorganisation:
   ```ts
   function findRepoRoot(from: string): string {
     for (let dir = from; ; dir = dirname(dir)) {
       if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
       if (dirname(dir) === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`);
     }
   }
   export const PROJECT_ROOT = process.env.EVENTYR_REPO_ROOT ?? findRepoRoot(dirname(fileURLToPath(import.meta.url)));
   ```
   - Run `grep -rn "process.cwd()\|import.meta.url" apps/pipeline/src`. Every hit must go through `PROJECT_ROOT`, or be a basename-only main guard. Those are replaced by `cli/` in 1.11.
5. **Package and scripts.**
   - `apps/pipeline/package.json`:
     - `name`: `@dothingslol/pipeline`
     - dependencies: `@dothingslol/{core,utils,llm,scraper}: workspace:*`, `js-yaml`, plus anything the remaining pipeline code imports directly (check with `grep -rhoE "from ['\"][^./@][^'\"]*['\"]|from ['\"]@[^'\"]+['\"]" apps/pipeline/src | sort -u`)
     - SDKs, `got-scraping` and `chrono-node` are **not** direct dependencies any more. They sit behind `llm` and `scraper`.
     - devDependencies: `@types/*`, `tsx`, `typescript`
   - Scripts: each moves as `tsx --env-file-if-exists=../../.env --tsconfig tsconfig.json src/<file>.ts`. `.env` stays at the root, and pnpm runs scripts from `apps/pipeline`.
     - Add `triage` (for `src/adapters/triage.ts`), `test` and `typecheck`.
   - Root proxies: `"<name>": "pnpm --filter @dothingslol/pipeline <name>"` for:
     - collect, collect-adapters, curate, venues, dedupe-venues, rank, geocode
     - markdown, ical, rss, pages, build-ai
     - add-city, probe-sources, discover-sources, test-adapter, render-sources, triage
   - Root `check`: `pnpm -r typecheck && biome check apps packages scripts && pnpm -r test && node scripts/check-boundaries.mjs`
   - The root keeps only `@biomejs/biome` and `typescript`.
   - Add the pipeline's row to `check-boundaries.mjs`: it may depend on `core`, `utils`, `llm` and `scraper`.
6. **Test isolation and workflows.**
   - **`locality.test.ts`:** `mkdtemp`, set `EVENTYR_DATA_ROOT`, then dynamically import the modules under test. `DATA_ROOT` is computed at module load, so this is the only order that works.
   - **`digest.yml`:**
     - "Typecheck and test" becomes `pnpm -r typecheck && pnpm -r test`.
     - Each `pnpm tsx --tsconfig tsconfig.scripts.json src/<x>.ts` becomes `pnpm <script>`.
     - Leave the `env:` blocks, cache paths and git add list unchanged.
   - **`add-city.yml`:** `pnpm add-city`.
   - **`reprobe.yml`:** `pnpm triage --render-candidates`, and `pnpm triage` for the report.
7. **Tooling and docs.**
   - `biome.json`: change `src/**` to `apps/pipeline/src/**`.
   - `CLAUDE.md`: change `src/<file>` to `apps/pipeline/src/<file>`, and add that root scripts are proxies.
     - Drop the WhatsApp mentions.
   - `README.md`: update the paths and the Mermaid diagram.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0; same test count |
| V2 | Tests leave data alone | `pnpm test:pipeline && git status --porcelain data/` | empty |
| V3 | No stray data directory | `find apps -maxdepth 3 -name data -type d` | nothing |
| V4 | Publish parity | Run `for c in brisbane goldcoast sunnycoast byron; do CITY=$c TZ=Australia/Brisbane pnpm geocode; CITY=$c pnpm ical; done; TZ=Australia/Brisbane pnpm markdown; pnpm rss; pnpm pages; pnpm build-ai` on the branch and in `/tmp/main-wt`, then `diff -r` `data/*.json`, `*.md` and the public trees | identical |
| V5 | Goldens | `node scripts/llm-parity.mjs && node scripts/scrape-parity.mjs && git diff --exit-code apps/pipeline/test/golden` | no diff |
| V6 | Arguments pass through | `pnpm probe-sources --city=doesnotexist` gives the unknown-city error. `pnpm collect anthropic` with no keys gives the anthropic-key error | failure for the expected reason |
| V7 | `add-city` still edits `digest.yml` | scratch-worktree check from 1.1 V7, using `pnpm add-city` | option added |
| V8 | Offline triage | `pnpm triage` against `pnpm tsx src/adapters/triage.ts` in `/tmp/main-wt` | same behaviour |
| V9 | WhatsApp is gone | the grep from step 2 | only the README unfurl line |
| V10 | Workflow syntax | `actionlint .github/workflows/*.yml` | clean |
| V11 | Site still builds | build and fingerprint | no diff from 1.9's result |
| V12 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch.
