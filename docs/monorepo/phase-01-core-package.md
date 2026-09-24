# Phase 01 — Create `@dothingslol/core` with `shared.ts` and the event types

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 01 (core package) of the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-01-core-package.md`, and no other phase files.
> Create branch `monorepo/phase-01-core-package` from the latest `main`. Follow the ordered steps,
> use `git mv` for every move, run every verification command, and paste the results into the PR
> description. If a check fails and the fix is not obvious and within this phase's scope, stop
> and report. Open a PR. Do not merge it, and do not start phase 02.

## Goal

Create `packages/core` as a just-in-time TypeScript source package: `exports` points at `.ts`,
with no build step. Move `src/shared.ts` and `app/types.ts` into it, and point every consumer at
`@dothingslol/core/*`. Stop `common.ts` (and through it `node:fs`) from leaking into the Astro
build. Add the boundary check. After this phase, behaviour is identical.

## Preconditions

- Phase 00 is merged. pnpm 11 and `pnpm-workspace.yaml` exist, and `workers/mcp` is a workspace member.
- `pnpm check` is green on `main`.

## Files affected

- **New:** `packages/core/{package.json,tsconfig.json}`, `tsconfig.base.json`, `scripts/check-boundaries.mjs`.
- **Moved:** `src/shared.ts` → `packages/core/src/shared.ts`, `src/shared.test.ts` → `packages/core/src/shared.test.ts`, `app/types.ts` → `packages/core/src/schema.ts`.
- **Import rewiring:**
  - every file importing `shared.ts` or `types.ts`: 16 under `app/`, `src/pages/**`, `src/layouts/Base.astro`, `src/common.ts`, `src/organizers.ts`, `src/sourceYield.ts`, and whatever else grep finds
  - `workers/mcp/src/{dothingsClient,tools}.ts`
- **Also:** `src/pages/[city]/[timeframe].astro`, `src/common.ts`, root `package.json`, `workers/mcp/package.json`, `biome.json`, and `CLAUDE.md` (Key files section).

## Steps

1. **Record a baseline.** On `main`, run `TZ=Australia/Brisbane pnpm build && scripts/site-fingerprint.sh dist /tmp/fp-before.txt`.
2. **Create `tsconfig.base.json`** at the root with only the options every package agrees on: `strict`, `skipLibCheck`, `isolatedModules`, `moduleDetection: "force"`, `allowImportingTsExtensions`, `noEmit`, `esModuleInterop`, `resolveJsonModule`. Don't change the existing `tsconfig.json` or `tsconfig.scripts.json` in this phase beyond what step 9 needs.
3. **Scaffold the package:**
   ```bash
   mkdir -p packages/core/src
   git mv src/shared.ts packages/core/src/shared.ts
   git mv src/shared.test.ts packages/core/src/shared.test.ts
   git mv app/types.ts packages/core/src/schema.ts
   ```
   `packages/core/package.json`:
   ```json
   {
     "name": "@dothingslol/core",
     "private": true,
     "version": "0.0.0",
     "type": "module",
     "sideEffects": false,
     "exports": { "./*": "./src/*.ts" },
     "scripts": {
       "test": "tsx --test 'src/**/*.test.ts'",
       "typecheck": "tsc --noEmit -p tsconfig.json"
     },
     "devDependencies": { "typescript": "catalog:", "tsx": "catalog:", "@types/node": "^25.8.0" }
   }
   ```
   - `@types/node` is there only because the tests use `node:test`. The `noNodejsModules` override in step 8 applies to non-test files.
   - `packages/core/tsconfig.json` extends `../../tsconfig.base.json`, with `target`/`lib` `ES2022`, `module`/`moduleResolution` `NodeNext` (so imports inside core must carry explicit `.ts` extensions, which every consumer accepts), `include: ["src"]`, and no DOM lib.
   - If the typecheck needs DOM types, find out which API is involved. Core has to run on Node, Hermes and Workers, so prefer a narrow `declare` over adding `DOM`.
4. **Wire the dependency.**
   - Add `"@dothingslol/core": "workspace:*"` to the root `package.json` `dependencies` and to `workers/mcp/package.json`.
   - Run `pnpm install`.
5. **Rewire imports.**
   - Find every importer: `grep -rnE "from ['\"][./]+(src/)?shared\.ts['\"]|from ['\"][./]+types(\.ts)?['\"]|@react/types" app src workers --include=*.ts --include=*.tsx --include=*.astro`.
   - Replace them with `@dothingslol/core/shared` and `@dothingslol/core/schema`. Package specifiers take no `.ts`, because the `exports` map adds it.
   - `src/common.ts` keeps re-exporting core, so pipeline modules still have one import site: `export * from "@dothingslol/core/shared";`.
6. **Fix the Node leak.**
   - Move `toISODate` from `src/common.ts` (around line 378) into `packages/core/src/shared.ts`. It is pure local-date arithmetic.
   - Have `common.ts` re-export it.
   - Change `src/pages/[city]/[timeframe].astro:10` to import `SITE_URL` and `toISODate` from `@dothingslol/core/shared`.
   - Then `grep -rn "common" src/pages src/layouts` must return nothing.
7. **Add `scripts/check-boundaries.mjs`** (Node, no dependencies). It fails, printing the offending file and specifier, when:
   - any `packages/*/package.json` depends on a `workspace:` package
   - any `apps/*/package.json` depends on another `apps/*` package
   - any source file under a workspace package root (`packages/*`, `apps/*`, `workers/*`, or the root package, meaning everything outside those) has a relative import whose resolved path lands in a *different* package root

   It scans `.ts`, `.tsx`, `.astro`, `.mjs` and `.js`, and skips `node_modules`, `dist` and `.astro`.
8. **Biome.**
   - Add `packages/**/*.ts` to `files.includes`.
   - Add an `overrides` entry for `packages/core/src/**` (excluding `**/*.test.ts`) that sets `linter.rules.correctness.noNodejsModules` to `"error"`.
   - Change `check` from `biome check src app` to `biome check src app packages`.
9. **Root scripts.** In `check`, after the existing steps, add:
   ```
   && pnpm --filter @dothingslol/core typecheck && pnpm --filter @dothingslol/core test && node scripts/check-boundaries.mjs
   ```
   - `test:pipeline`'s glob no longer covers `shared.test.ts`. It now runs in core. Make sure the frozen `eventHash` pins still execute.
   - `tsconfig.json`'s `include` needs no change, because core is resolved as a package.
10. **Docs.**
    - In `CLAUDE.md` "Key files", change the `src/shared.ts` bullets to `packages/core/src/shared.ts`. Keep the "must stay free of `node:` imports" rule and note that Biome now enforces it.
    - Change the `app/types.ts` mention to `packages/core/src/schema.ts`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | All checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0. Test count = baseline, with `shared.test.ts` now counted under core |
| V2 | No stale paths | `grep -rnE "src/shared|app/types|\.\./\.\./\.\./src/" app src workers packages --include=*.ts --include=*.tsx --include=*.astro` | no output |
| V3 | Site unchanged | `TZ=Australia/Brisbane pnpm build && scripts/site-fingerprint.sh dist /tmp/fp-after.txt && diff /tmp/fp-before.txt /tmp/fp-after.txt` | no diff |
| V4 | No Node in the site bundle | `grep -rlE "node:fs|js-yaml" dist/_astro \|\| echo clean` | `clean` |
| V5 | tsx resolves core in the pipeline | `CITY=brisbane TZ=Australia/Brisbane pnpm markdown && git status --porcelain` | exits 0. The diff is empty, or identical to running the same command on `main` |
| V6 | Worker | `pnpm --dir workers/mcp typecheck && pnpm --dir workers/mcp test && pnpm --dir workers/mcp exec wrangler deploy --dry-run --outdir /tmp/mcp` | exit 0 |
| V7 | Lint rule bites | temporarily add `import "node:fs";` to `packages/core/src/schema.ts` and run `pnpm exec biome check packages` | error reported. Revert the line |
| V8 | Boundary check bites | temporarily add `import "../../../src/common.ts";` to a core file and run `node scripts/check-boundaries.mjs` | non-zero exit naming the file. Revert |
| V9 | PR CI | `CI` workflow | green |

**After merge:** `Deploy to GitHub Pages` is green, and `curl -sfI https://www.dothings.lol/brisbane/`
returns 200. The pipeline only changed import sites. The next `digest.yml` run exercises it, so a
manual dispatch is optional. If you do one, use `brisbane` with `force=false`.

## Rollback

Revert the squash-merge. Nothing generated depends on this phase.
