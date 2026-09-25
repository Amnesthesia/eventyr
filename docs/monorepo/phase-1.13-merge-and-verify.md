# Sub-phase 1.13: Final verification, merge PR 1, post-merge runbook

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.13 (merge and verify) of PR 1, the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.13-merge-and-verify.md` only, and no other
> phase files. Work on branch `monorepo/refactor`.
>
> 1. Sync as described in PLAN §4.3.
> 2. Run the full pre-merge suite and post the results as a PR comment.
> 3. Mark the PR ready for review.
>
> **You don't merge.** A human merges, inside the window in PLAN §4.4. After the human says it is
> merged, run the post-merge runbook and report back. If any check fails, stop and report.

## Goal

Prove the finished branch is equivalent to `main` for everything the site serves and the pipeline
publishes. Then get it merged safely, and confirm that the deploy, the digest and the weekly run
(now including Byron) all work on the new layout.

## Preconditions

- 1.1 to 1.12 are ticked in the PR description.
- It's early in the working week, so there is room to merge before Saturday (PLAN R9).

## Pre-merge suite (on the branch, after `git -c merge.directoryRenames=true merge origin/main`)

Build `origin/main` in a fresh worktree at `/tmp/main-wt` for comparison. Do it on the same day
and in the same hour as the branch builds.

| # | Check | Command | Pass condition |
|---|---|---|---|
| P1 | Clean install and all checks | `rm -rf node_modules apps/*/node_modules packages/*/node_modules && pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| P2 | Site identical to `main` | Build both. Compare `scripts/site-fingerprint.sh /tmp/main-wt/dist /tmp/fp-main.txt` with `scripts/site-fingerprint.sh apps/web/dist /tmp/fp-branch.txt` using `diff` | no diff |
| P3 | Client behaviour identical | Preview both on different ports. Run `filter-parity.mjs` against each and diff the JSON | no diff |
| P4 | Publish output identical | The deterministic stages from 1.10 V4, run in both trees for all four cities | identical |
| P5 | Worker | `pnpm --filter @dothingslol/mcp exec wrangler deploy --dry-run --outdir /tmp/mcp` | exit 0 |
| P6 | Workflows | `actionlint .github/workflows/*.yml` | clean |
| P7 | add-city regex | scratch-worktree check (1.1 V7) | option added |
| P8 | Deploy build job on branch | dispatch "Deploy to GitHub Pages" on `monorepo/refactor` | build job green, artifact has `.well-known/api-catalog` |
| P9 | History preserved | `git log --follow --oneline apps/web/app/context.tsx apps/pipeline/src/stages/curate.ts packages/core/src/shared.ts packages/scraper/src/fetch.ts \| wc -l` | follows past the moves |
| P10 | No leftovers | `ls src app public workers 2>&1; git grep -nE "tsconfig\.scripts\.json\|src/(rank\|geocode\|markdown\|ical\|pages\|messaging)\.ts" -- .github package.json` | directories are gone; no matches |
| P11 | LLM request parity | `node scripts/llm-parity.mjs && git diff --exit-code test/golden/llm` | no diff |
| P12 | Scrape output parity | `node scripts/scrape-parity.mjs && git diff --exit-code test/golden/scrape` | no diff |
| P13 | Config snapshot | `pnpm --filter @dothingslol/pipeline test -- --test-name-pattern config` | every moved value equals its old constant; `interests.md` byte-identical |
| P14 | Package graph | `node scripts/check-boundaries.mjs` plus `pnpm -r ls --depth 0 --json` (inspect workspace deps against PLAN §2.3) | exit 0; graph matches the table exactly |
| P15 | No cross-package relative imports or SDKs outside `llm` | `git grep -nE "from ['\"](\.\./)+(packages\|apps)/" -- apps packages; git grep -nE "@anthropic-ai/sdk\|from ['\"]openai['\"]\|@google/genai" -- apps packages ':!packages/llm'` | nothing |

Then mark the PR **ready for review**. In the description, remind the merger to:

- use **squash** (PLAN D17), and **don't delete `monorepo/refactor` afterwards**, because it keeps the per-commit rename history
- merge inside the window in PLAN §4.4, after checking that the `digest` concurrency group is idle.

## Post-merge runbook (run immediately after the human merges)

1. **Deploy.** The "Deploy to GitHub Pages" run for the squash commit is green. Then:
   ```bash
   for u in / /brisbane/ /gold-coast/today/ /byron/ /brisbane/feed.xml /brisbane.ics /ai/index.json /llms.txt /.well-known/api-catalog /sitemap.xml /CNAME; do
     printf '%s %s\n' "$(curl -so /dev/null -w '%{http_code}' https://www.dothings.lol$u)" "$u"; done
   curl -sfI https://www.dothings.lol/brisbane/ | grep -i last-modified   # after the merge time
   ```
   - Every URL returns 200.
   - Also open one `/brisbane/e/<slug>/` page and its `.ics`.
   - Run `node scripts/filter-parity.mjs https://www.dothings.lol /tmp/parity-prod.json`. It must complete with no console errors.
2. **Digest on the new layout.**
   - Dispatch `digest.yml` with `brisbane` and `force=false`. Every step must be green, and the install must use pnpm 11.
   - If the run commits, `git show --stat` of the bot commit must touch only `data/`, `apps/web/public/` and `BRISBANE.md`.
   - Check that `git ls-tree origin/main public src app` prints nothing.
   - `force=false` should skip most paid calls. Note any provider spend visible in the logs (PLAN §1.7).
3. **MCP (optional; needs Cloudflare credentials).**
   - Run `pnpm --filter @dothingslol/mcp deploy`.
   - Then run:
     ```bash
     curl -s https://mcp.dothings.lol/mcp -H 'content-type: application/json' \
       -H 'accept: application/json, text/event-stream' \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
     ```
   - The response lists `list_cities` and `get_events`. If you skip the deploy, the live Worker keeps its previous, equivalent build.
4. **Human housekeeping.** Delete the `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` and `WHATSAPP_RECIPIENT` repository secrets (Settings → Secrets and variables → Actions).
5. **First scheduled runs.**
   - The following Saturday 20:00 UTC `weekly.yml` runs four jobs, ending with **byron**, and all of them must be green. The deploy follows via `workflow_run`.
   - `/byron/` then shows the new week, and `/ai/byron/` exists in `/ai/index.json`.
   - Check the usage file for each city (`data/{city}/usage/<week>.json`). Its per-stage call counts must be in line with the previous week, so the `llm` migration hasn't changed request volume.
   - `reprobe.yml` runs on the 3rd of the month. Check it when it does.
   - Post these results on the PR once they're in.

6. **Switch on batch for rank and annotate (D14).** Do this after the first green weekly run on the new layout, which gives the "before" figures.
   - Open a small PR against `main`:
     - `pipeline.yml`: set `stages.rank.batch: true` and `stages.annotate.batch: true` (deadlines 480000 / 300000 ms).
     - `digest.yml`: raise `timeout-minutes` from 20 to 35.
   - Verify with `pnpm check`, then dispatch `digest.yml` for `goldcoast` with `force=true`. That costs one paid run for a smaller city.
     - The run is green.
     - `data/goldcoast/run.json` shows the rank and annotate calls with `viaBatch` counts and `estimatedCostUsd` below the previous week's for those stages.
     - Published event count and top picks are in line with last week.
   - If the batch path hit its deadline, the log shows cancel-and-sync and the run still completes. That's the designed fallback, not a failure.
   - Merge within the PLAN §4.4 window. The next weekly run is the real measurement: post its cost and duration next to the week before in the PR.

## Rollback (after merge)

- **Before any bot commit lands on the new paths:** `git revert <squash-sha>` and push. That restores the old layout in one commit.
- **After a digest has committed to `apps/web/public/`:** the revert conflicts on those regenerated files.
  1. Revert.
  2. For each conflict, take the post-digest content and `git mv` it back under `public/`.
  3. Or forward-fix instead. The failure will almost certainly be a path, and a forward fix is usually smaller.
- **Either way, finish before the next Saturday 20:00 UTC.** If you can't, disable `weekly.yml` (Actions → Disable workflow) until `main` is consistent. Re-enable it and dispatch the missed cities with `force=false`.
