# Sub-phase 1.9 — Move the website to `apps/web`

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.9 (web move) of PR 1, the eventyr monorepo refactor.
>
> - Read only `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.09-web-move.md`, no other phase files.
> - Work on branch `monorepo/refactor`, even if your environment suggests a different branch. If you can't push to it, stop and ask.
> - Sync first, as PLAN §4.3 describes, using `merge.directoryRenames=true`.
> - Follow the ordered steps and use `git mv` for every move.
> - Run every verification, post the results as a comment on the PR 1 draft, and tick 1.9.
> - If a check fails and the fix isn't obvious and in scope, stop and report.
> - Push the branch. Don't merge, and don't start 1.10.

## Goal

Make the Astro site the workspace package `@dothingslol/web` at `apps/web`. Everything the site
serves moves to `apps/web/public`, including the feeds the pipeline generates. The pipeline is
still at the repo root and writes into the new location through one constant. `data/` and
`sources/` stay at the root and are read through a single resolver.

**Branch timing.** From this sub-phase on, the weekly bot commits to `main` touch paths that have
moved on the branch. Keep 1.9 → 1.13 within one working week (PLAN R9).

## Preconditions

- 1.8 is committed on the branch. That gives you `filter-parity.mjs`, `site-fingerprint.sh`, CI and the four packages. The pipeline still lives in `src/`.

## Files affected

Each row is one `git mv`, all in a single rename-only commit:

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

New files:
- `apps/web/package.json`
- `apps/web/src/lib/paths.ts`

Edited files:
- Pipeline writers:
  - `src/common.ts`: add `WEB_PUBLIC_DIR`
  - `src/ai.ts`: lines 69, 563, 581, 617, 654
  - `src/ical.ts`: lines 212, 258
  - `src/rss.ts`: line 174
  - `src/pages.ts`: line 129
- The 7 files that read `process.cwd()`.
- Root `package.json`.
- `tsconfig.scripts.json`: drop the `src/pages` and `src/layouts` excludes.
- `biome.json`.
- `.githooks/pre-commit`.
- `.github/workflows/digest.yml`: the git add list, lines 247–251.
- `.github/workflows/deploy.yml`: the artifact path.
- `CLAUDE.md` and `README.md`: paths only.

## Steps

1. **Baseline, on the same day as the checks.**
   - Run `TZ=Australia/Brisbane pnpm build && scripts/site-fingerprint.sh dist /tmp/fp-before.txt`.
   - Run the parity script against preview and save it as `/tmp/parity-before.json`.
   - Run `cp -r public /tmp/public-before`.
2. **Moves.** Run every `git mv` in the table above. Commit them on their own with no content edits.
3. **`apps/web/package.json`.**
   - Name: `@dothingslol/web`.
   - Scripts:
     - `dev`: `astro dev`
     - `build`: `astro build`
     - `preview`: `astro preview`
     - `test`: `tsx --test 'app/**/*.test.ts' 'app/**/*.test.tsx'`
     - `typecheck`: `tsc --noEmit -p tsconfig.json`
   - Move these dependencies from the root: `astro`, `@astrojs/react`, `@picocss/pico`, `lucide-react`, `qrcode-generator`, `react`, `react-dom`. Add `js-yaml` (used by organizers) and `@dothingslol/core: workspace:*`.
   - Dev dependencies: `sass`, `@types/react`, `@types/react-dom`, `@types/js-yaml`, `typescript`, `tsx`.
   - Before moving each dependency, confirm it by grepping for its imports. At planning time, the React, Astro, lucide, qrcode and pico packages were web-only, `js-yaml` was used by both, and `sass` was used implicitly through `app/pico.scss`.
   - The root keeps the pipeline's dependencies until 1.10.
4. **Add `apps/web/src/lib/paths.ts`.**
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
   - Replace every `join(process.cwd(), "data"|"sources", …)` in these files: `index.astro`, `[city].astro`, `[city]/[category].astro`, `[city]/[timeframe].astro`, `[city]/e/[event].astro`, `ai.astro` and `lib/organizers.ts`.
   - Afterwards, `grep -rn "process.cwd" apps/web/src` should show only `paths.ts`.
5. **Astro config.**
   - `outDir: "./dist"` now resolves to `apps/web/dist`. `.gitignore`'s `dist/` already covers it.
   - The `@react` alias still resolves from `import.meta.url`.
   - Keep `vite.resolve.dedupe: ["react"]`.
6. **`apps/web/tsconfig.json`.** Extend `../../tsconfig.base.json`, keep `paths: { "@react/*": ["./app/*"] }`, and set `include: ["app", "src"]`.
7. **Pipeline writes into web.**
   - In `src/common.ts`, next to `DATA_ROOT`, add:
     ```ts
     /** Where the site's static files live. The pipeline writes feeds here; see docs/monorepo/PLAN.md §2.3. */
     export const WEB_PUBLIC_DIR = resolve(PROJECT_ROOT, "apps", "web", "public");
     ```
   - Replace every `join(PROJECT_ROOT, "public", …)` with `join(WEB_PUBLIC_DIR, …)`.
   - Afterwards, `grep -rn '"public"' src` should print nothing.
   - `markdown.ts` still writes `{KEY}.md` to the root.
8. **Root `package.json`.**
   - `build`, `dev` and `preview` become `pnpm --filter @dothingslol/web <script>`.
   - `test:app` becomes `pnpm --filter @dothingslol/web test`.
   - In `check`, the first `tsc` becomes `pnpm --filter @dothingslol/web typecheck`, and the biome path `app` becomes `apps/web/app`.
9. **Tooling paths.**
   - `biome.json` includes: `apps/web/app/**/*.ts(x)`, `apps/web/src/**/*.ts`, `apps/web/scripts/**`.
   - `.githooks/pre-commit`: watch `apps/web/` and `packages/core/`.
   - `tsconfig.scripts.json`: remove the `exclude`.
10. **Workflows.**
    - `digest.yml` "Commit data files": change `public/...` to `apps/web/public/${CITY}.ics`, `apps/web/public/sitemap.xml`, `apps/web/public/*/feed.xml`, `apps/web/public/*/e/`, `apps/web/public/ai/`, and `apps/web/public/llms.txt`. Update the path mentioned in the comment above it too.
    - `deploy.yml`: change the upload `path` to `apps/web/dist`.
    - `ci.yml`: needs no change because `pnpm build` proxies. Confirm this.
11. **Docs.** In `CLAUDE.md` and `README.md`, update the paths only (`app/`, `src/pages/`, `public/…`, `src/pages/ai.astro`, `app/utils/mcpInstall.ts`).

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0, with the same test count |
| V2 | Renames tracked | `git show --stat -M HEAD~N` on the move commit, and `git log --follow --oneline apps/web/app/context.tsx \| wc -l` | renames detected; history continues past the move |
| V3 | Site unchanged | build, then `scripts/site-fingerprint.sh apps/web/dist /tmp/fp-after.txt`, then diff | no diff |
| V4 | Client behaviour unchanged | preview, then `filter-parity.mjs` to `/tmp/parity-after.json`, then diff | no diff |
| V5 | Publish writes to the new place | Run `for c in brisbane goldcoast sunnycoast byron; do CITY=$c TZ=Australia/Brisbane pnpm geocode && CITY=$c pnpm ical; done; TZ=Australia/Brisbane pnpm markdown && pnpm rss && pnpm pages && pnpm build-ai`, then `test ! -e public && diff -r /tmp/public-before apps/web/public` | No root `public/` is recreated. The diff is empty or equals what the same commands produce in an `origin/main` worktree. |
| V6 | Nothing stray | `git status --porcelain \| grep -vE '^.. (apps/web/public\|data)/\|^.. [A-Z]+\.md$'` | nothing |
| V7 | Workflow syntax | `actionlint .github/workflows/*.yml` | clean |
| V8 | Hook | Stage a whitespace change in `apps/web/app/EventApp.tsx`, then run `.githooks/pre-commit` | runs `pnpm build`; then unstage |
| V9 | Deploy build job | Dispatch "Deploy to GitHub Pages" on `monorepo/refactor` | the build job is green and the artifact contains `index.html` and `.well-known/api-catalog` (download the artifact from the run page) |
| V10 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch. If `main` has already been merged in after the
move, revert the merge commit first. Rolling back after PR 1 merges is covered in 1.13.
