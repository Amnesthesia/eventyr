# Phase 04 — Move the website to `apps/web`

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 04 (web move) of the eventyr monorepo refactor. Read `docs/monorepo/PLAN.md`
> and `docs/monorepo/phase-04-web-move.md`, and no other phase files. Branch
> `monorepo/phase-04-web-move` from the latest `main`. Follow the ordered steps, use `git mv`
> for every move, run every verification command and paste the results into the PR
> description. If a check fails and the fix isn't obvious and within this phase's scope, stop
> and report. Open a PR. Don't merge it and don't start phase 05. **This phase changes the
> paths the weekly digest commits. Whoever merges must follow the merge-window rule in
> PLAN.md §4.**

## Goal

Make the Astro site a workspace package at `apps/web`, called `@dothingslol/web`. Everything
the site serves, including the feeds the pipeline generates, moves into `apps/web/public`. The
pipeline stays at the repo root for now and writes into the new location through a single
constant. `data/` and `sources/` stay at the root and are read through one resolver.

## Preconditions

- Phase 03 is merged. That gives `scripts/filter-parity.mjs`, `scripts/site-fingerprint.sh`, and CI.
- The `digest` concurrency group is idle, and the merge will happen outside Saturday 18:00–23:00 UTC.

## Files affected (all via `git mv`)

| From | To |
|---|---|
| `app/` | `apps/web/app/` |
| `src/pages/` | `apps/web/src/pages/` |
| `src/layouts/` | `apps/web/src/layouts/` |
| `src/env.d.ts` | `apps/web/src/env.d.ts` |
| `src/organizers.ts` | `apps/web/src/lib/organizers.ts` |
| `public/` | `apps/web/public/` |
| `astro.config.mjs` | `apps/web/astro.config.mjs` |
| `tsconfig.json` | `apps/web/tsconfig.json` |
| `scripts/generate-icons.mjs` | `apps/web/scripts/generate-icons.mjs` |

**New files:**
- `apps/web/package.json`
- `apps/web/src/lib/paths.ts`

**Edited files:**
- Pipeline writers:
  - `src/common.ts`: add `WEB_PUBLIC_DIR`
  - `src/ai.ts`: lines 69, 563, 581, 617, 654
  - `src/ical.ts`: lines 212, 258
  - `src/rss.ts`: line 174
  - `src/pages.ts`: line 129
- The seven page files that read `process.cwd()`.
- Root `package.json`.
- `tsconfig.scripts.json`: drop the `src/pages` and `src/layouts` excludes.
- `biome.json`.
- `.githooks/pre-commit`.
- `.github/workflows/digest.yml`: git add list, lines 247–251.
- `.github/workflows/deploy.yml`: artifact path.
- `.github/workflows/ci.yml`.
- `CLAUDE.md` and `README.md`: paths only, including the Mermaid diagram's file names if it names paths.

## Steps

1. **Baseline on `main`, same day.**
   - `TZ=Australia/Brisbane pnpm build && scripts/site-fingerprint.sh dist /tmp/fp-before.txt`.
   - Run the parity script against preview: `/tmp/parity-before.json`.
   - Copy the tree so you can compare publish output later: `cp -r public /tmp/public-before`.
2. **Moves.** Do all the `git mv`s in the table in one commit, with no content edits. This keeps rename detection at 100%.
3. **`apps/web/package.json`.**
   - Name it `@dothingslol/web`.
   - Scripts:
     - `dev: astro dev`
     - `build: astro build`
     - `preview: astro preview`
     - `test: tsx --test 'app/**/*.test.ts' 'app/**/*.test.tsx'`
     - `typecheck: tsc --noEmit -p tsconfig.json`
   - Dependencies to move from root to web: `astro`, `@astrojs/react`, `@picocss/pico`, `lucide-react`, `qrcode-generator`, `react`, `react-dom`, plus `js-yaml` (used by `organizers.ts`) and `@dothingslol/core: workspace:*`.
   - Dev dependencies: `sass`, `@types/react`, `@types/react-dom`, `@types/js-yaml`, `typescript`, `tsx`.
   - Confirm each assignment by grepping the imports. When the plan was written: `astro`, React, lucide, qrcode and pico were web-only; `js-yaml` is used by both; `sass` is used implicitly through `app/pico.scss`.
   - The root keeps the pipeline dependencies until phase 05.
4. **Path resolver: `apps/web/src/lib/paths.ts`.**
   ```ts
   // Build-time only. Resolved from cwd, not import.meta.url: Astro's prerender bundle relocates
   // modules under dist/, so import.meta.url no longer points at the source tree (the reason
   // organizers.ts already used cwd). pnpm runs package scripts with cwd = apps/web.
   import { existsSync } from "node:fs";
   import { resolve } from "node:path";
   export const REPO_ROOT = process.env.EVENTYR_REPO_ROOT ?? resolve(process.cwd(), "../..");
   export const DATA_ROOT = process.env.EVENTYR_DATA_ROOT ?? resolve(REPO_ROOT, "data");
   export const SOURCES_ROOT = resolve(REPO_ROOT, "sources");
   if (!existsSync(resolve(DATA_ROOT, "index.json"))) {
     throw new Error(`data/index.json not found under ${DATA_ROOT}; run from apps/web or set EVENTYR_REPO_ROOT`);
   }
   ```
   Replace every `join(process.cwd(), "data", …)` and `join(process.cwd(), "sources", …)` in `index.astro`, `[city].astro`, `[city]/[category].astro`, `[city]/[timeframe].astro`, `[city]/e/[event].astro`, `ai.astro` and `lib/organizers.ts`. Afterwards, `grep -rn "process.cwd" apps/web/src` must show only `paths.ts`.
5. **Astro config.**
   - `outDir: "./dist"` now resolves to `apps/web/dist`. `.gitignore`'s `dist/` pattern already covers that.
   - The `@react` alias is built from `import.meta.url`, so it still points at `apps/web/app`.
   - Keep `vite.resolve.dedupe: ["react"]`.
6. **`apps/web/tsconfig.json`.** Extend `../../tsconfig.base.json`. Keep `paths: { "@react/*": ["./app/*"] }`, and set `include` to `["app", "src"]`.
7. **Pipeline writes into web.**
   - In `src/common.ts`, next to `DATA_ROOT`, add:
     ```ts
     /** Where the site's static files live. The pipeline writes feeds here; see PLAN §2.3. */
     export const WEB_PUBLIC_DIR = resolve(PROJECT_ROOT, "apps", "web", "public");
     ```
   - Replace every `join(PROJECT_ROOT, "public", …)` with `join(WEB_PUBLIC_DIR, …)`.
   - Afterwards, `grep -rn '"public"' src` must return nothing.
   - `markdown.ts` still writes `{KEY}.md` to the repo root. That is unchanged.
8. **Root `package.json`.**
   - Set `build` to `pnpm --filter @dothingslol/web build`. Do the same for `dev` and `preview`.
   - Set `test:app` to `pnpm --filter @dothingslol/web test`.
   - In `check`, change the first `tsc` to `pnpm --filter @dothingslol/web typecheck`.
   - Change the biome target from `app` to `apps/web/app`.
   - The pipeline scripts don't change.
9. **Tooling paths.**
   - `biome.json` `files.includes`: `apps/web/app/**/*.ts(x)`, `apps/web/src/**/*.ts`, `apps/web/scripts/**`.
   - `.githooks/pre-commit`: watch `apps/web/ packages/core/` instead of `app/ src/pages/ src/layouts/ astro.config.mjs`.
   - `tsconfig.scripts.json`: remove the now-meaningless `exclude`.
10. **Workflows.**
    - `digest.yml` "Commit data files": change the `public/...` entries to `apps/web/public/${CITY}.ics`, `apps/web/public/sitemap.xml`, `apps/web/public/*/feed.xml`, `apps/web/public/*/e/`, `apps/web/public/ai/`, `apps/web/public/llms.txt`. Keep the comment and update the path it mentions.
    - `deploy.yml`: set `upload-pages-artifact` `path: apps/web/dist`.
    - `ci.yml`: no change needed, because `pnpm build` proxies. Confirm this.
11. **Docs.** Update the paths in `CLAUDE.md` and `README.md`. That covers `app/`, `src/pages/`, `public/{city}.ics`, `public/ai/…`, `src/pages/ai.astro` and `app/utils/mcpInstall.ts`. Change nothing else.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0, same test count |
| V2 | Rename fidelity | `git diff --stat -M main... \| grep -c '=>'` and `git log --follow --oneline apps/web/app/context.tsx \| wc -l` | the renames are detected, and history continues past this commit |
| V3 | Site unchanged | `TZ=Australia/Brisbane pnpm build && scripts/site-fingerprint.sh apps/web/dist /tmp/fp-after.txt && diff /tmp/fp-before.txt /tmp/fp-after.txt` | no diff |
| V4 | Client behaviour unchanged | `pnpm preview &` then `node scripts/filter-parity.mjs http://localhost:4321 /tmp/parity-after.json`, then diff against the before file | no diff |
| V5 | Publish stages write to the new place | `for c in brisbane goldcoast sunnycoast; do CITY=$c TZ=Australia/Brisbane pnpm geocode && CITY=$c pnpm ical; done; TZ=Australia/Brisbane pnpm markdown && pnpm rss && pnpm pages && pnpm build-ai`, then `test ! -e public && diff -r /tmp/public-before apps/web/public` | no root `public/` is recreated. The diff is empty, or shows only what the same commands produce on `main` (run them in a `main` worktree to compare if anything differs) |
| V6 | Nothing stray | `git status --porcelain \| grep -vE '^.. (apps/web/public\|data)/\|^.. [A-Z]+\.md$'` | no output |
| V7 | Workflow syntax | `actionlint .github/workflows/*.yml` | clean |
| V8 | Hook | stage a whitespace change in `apps/web/app/EventApp.tsx` and run `.githooks/pre-commit` | it runs `pnpm build`. Unstage afterwards |
| V9 | PR CI | `CI` | green |

**After merge.** Do this immediately, and don't leave it until Sunday.

1. **Deploy.** `Deploy to GitHub Pages` is green. Then check:
   ```bash
   for u in / /brisbane/ /gold-coast/today/ /brisbane/feed.xml /brisbane.ics /ai/index.json /llms.txt /.well-known/api-catalog /sitemap.xml /CNAME; do
     printf '%s %s\n' "$(curl -so /dev/null -w '%{http_code}' https://www.dothings.lol$u)" "$u"; done
   ```
   Every URL returns 200. Also open one per-event page (`/brisbane/e/<slug>/`) and its `.ics`.
2. **Cron.**
   - Dispatch `digest.yml` with `brisbane` and `force=false`. It must be green.
   - If it commits, confirm the commit touches `apps/web/public/…` and not `public/…`: `git show --stat HEAD` on `main`.
   - Then check that `git ls-tree main public` is empty.

## Rollback

- **Before any digest has committed under `apps/web/public`:** revert the squash-merge.
- **After a digest has committed there:** a plain revert conflicts on the regenerated feeds.
  1. Revert.
  2. Resolve the conflicts by taking the post-digest versions. Run `git checkout --theirs` on the conflicting paths, then `git mv` them back to `public/`.
  3. Or forward-fix instead. That is usually smaller, because the failure will be a path.

Either way, finish before the next Saturday 20:00 UTC digest. If you can't, disable
`weekly.yml` (Actions → Disable workflow) until `main` is consistent.
