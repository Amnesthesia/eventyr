# Sub-phase 1.2: Create `@dothingslol/core` with `shared.ts` and the event types

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.2 (core package) of PR 1, the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.02-core-package.md`, and no other phase files.
> Work on branch `monorepo/refactor`, even if your environment suggests another. If you can't push
> to it, stop and ask. Sync first as PLAN §4.3 says. Follow the ordered steps and use `git mv` for
> every move. Run every verification, post the results as a comment on the PR 1 draft, and tick
> 1.2. If a check fails and the fix isn't obvious and in scope, stop and report. Push the branch,
> but don't merge and don't start 1.3.

## Goal

Create `packages/core` as a just-in-time TS source package: `exports` points at `.ts` files and
there is no build step. Move `src/shared.ts` and `app/types.ts` into it, and point every consumer
at `@dothingslol/core/*`. Stop `common.ts` (and with it `node:fs`) leaking into the Astro build.
Add the boundary check. Behaviour stays identical.

## Preconditions

- 1.1 is committed on `monorepo/refactor`: pnpm 11, the workspace, CI.

## Files affected

- New: `packages/core/{package.json,tsconfig.json}`, `tsconfig.base.json`, `scripts/check-boundaries.mjs`.
- Renamed: the event type `Event` → `EventData` (step 5b).
- Moved:
  - `src/shared.ts` → `packages/core/src/shared.ts`
  - `src/shared.test.ts` → `packages/core/src/shared.test.ts`
  - `app/types.ts` → `packages/core/src/schema.ts`
- Import sites:
  - 16 files under `app/`
  - `src/pages/**`
  - `src/layouts/Base.astro`
  - `src/common.ts`, `src/organizers.ts`, `src/sourceYield.ts`, plus whatever the grep in step 5 finds
  - `workers/mcp/src/{dothingsClient,tools}.ts`
- Also edited: `src/pages/[city]/[timeframe].astro`, root and `workers/mcp` `package.json`, `biome.json`, and the `CLAUDE.md` "Key files" section.

## Steps

1. **Baseline.** Before changing anything, run `pnpm build && scripts/site-fingerprint.sh dist /tmp/fp-before.txt`.
2. **`tsconfig.base.json`.** Add only the options every package agrees on: `strict`, `skipLibCheck`, `isolatedModules`, `moduleDetection: "force"`, `allowImportingTsExtensions`, `noEmit`, `esModuleInterop`, `resolveJsonModule`.
3. **Package skeleton.**
   ```bash
   mkdir -p packages/core/src
   git mv src/shared.ts packages/core/src/shared.ts
   git mv src/shared.test.ts packages/core/src/shared.test.ts
   git mv app/types.ts packages/core/src/schema.ts
   git commit -m "refactor: move shared.ts and types into packages/core (rename only)"
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
   - `@types/node` is there for `node:test` only. The lint override in step 8 exempts test files.
   - `packages/core/tsconfig.json` extends `../../tsconfig.base.json` and sets:
     - `target`/`lib`: `ES2022`, with **no DOM lib**
     - `module`/`moduleResolution`: `NodeNext`, so imports inside core carry explicit `.ts` extensions (every consumer accepts them)
     - `include`: `["src"]`
   - If the typecheck asks for DOM types, identify the API involved. Core must run on Node, Hermes and Workers, so prefer a narrow `declare` over adding DOM.
4. **Wire the dependency.** Add `"@dothingslol/core": "workspace:*"` to the root `package.json` dependencies and to `workers/mcp/package.json`, then run `pnpm install`.
5. **Rewire imports.**
   - Find the import sites: `grep -rnE "from ['\"][./]+(src/)?shared\.ts['\"]|from ['\"][./]+types(\.ts)?['\"]|@react/types" app src workers --include=*.ts --include=*.tsx --include=*.astro`.
   - Change them to `@dothingslol/core/shared` and `@dothingslol/core/schema`. Use no `.ts` on package specifiers.
   - `src/common.ts` keeps re-exporting core with `export * from "@dothingslol/core/shared";`, so pipeline modules keep one import site.
5b. **Name the event type and give it a schema (D15).** Do this as its own commit, after the move.
   - Rename the event type from `app/types.ts` (`Event`) to **`EventData`** everywhere. Use TypeScript rename, not sed. `Event` shadows the DOM's global `Event` type.
   - Fix the drift listed in PLAN §1.3 so that `EventData` describes what the pipeline actually writes:
     - vibes are always present
     - `score` is `number | null` before ranking. Published payloads always have a number, because rank defaults it to 5. Where web code assumes non-null, narrow the type in a way that preserves behaviour. Don't add new fallbacks.
     - `datetime_end_iso` may be `""` today, so it becomes `string | null` in the type, with `""` still accepted by the schema
     - `venue` (tier) and `venue_name` are present
   - Add `CityPayload`, the shape of `data/{city}.json`, including `ranked_at` and `geocoded_at`.
   - Add **zod schemas** `EventDataSchema` and `CityPayloadSchema` in `core/schema.ts`, with the TypeScript types inferred from them. Add `zod: catalog:` to core's dependencies.
   - **In PR 1, the schemas are used only by tests** (no runtime enforcement, per D1). Add `packages/core/src/schema.data.test.ts`, which parses every committed `data/*.json` and fails with the path of any mismatch. Fix the *schema* until real data passes. Never fix the data.
   - Runtime validation starts in PR 2 (2.2).
6. **Fix the Node leak.**
   - Move `toISODate` (`src/common.ts`, around line 378) into `packages/core/src/shared.ts`. It is pure. `common.ts` re-exports it.
   - Change `src/pages/[city]/[timeframe].astro:10` to import `SITE_URL` and `toISODate` from `@dothingslol/core/shared`.
   - Afterwards, `grep -rn "common" src/pages src/layouts` must print nothing.
7. **`scripts/check-boundaries.mjs`.** Plain Node, no dependencies. It encodes the **allowed dependency table in PLAN §2.3** as data. Packages that don't exist yet are simply absent. It exits non-zero, naming the file and the offending specifier or dependency, when:
   - a workspace package's `package.json` lists a `workspace:` dependency the table doesn't allow;
   - a relative import in a `.ts`, `.tsx`, `.astro`, `.mjs` or `.js` file resolves into a **different** package root. Package roots are `packages/*`, `apps/*`, `workers/*`, plus the root package, which is everything else. Cross-package access must go through the package name;
   - an import reaches into another package's internals (`@dothingslol/x/src/...`) instead of an `exports` entry.

   Skip `node_modules`, `dist` and `.astro`. Later sub-phases only add rows to the table. They never loosen it.
8. **Biome.**
   - Add `packages/**/*.ts` to `files.includes`.
   - Add an `overrides` entry for `packages/core/src/**`, excluding `**/*.test.ts`, that sets `linter.rules.correctness.noNodejsModules` to `"error"`.
   - In `check`, change `biome check src app` to `biome check src app packages`.
9. **Root `check`.** Append:
   ```
   && pnpm --filter @dothingslol/core typecheck && pnpm --filter @dothingslol/core test && node scripts/check-boundaries.mjs
   ```
   Confirm that the frozen `eventHash` pins in `shared.test.ts` still run, now under core.
10. **`CLAUDE.md` "Key files".**
    - Change `src/shared.ts` to `packages/core/src/shared.ts`. Keep the "no `node:` imports" rule and note that Biome now enforces it.
    - Change `app/types.ts` to `packages/core/src/schema.ts`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0; the test count equals the baseline |
| V2 | No stale paths | `grep -rnE "src/shared\|app/types\|\.\./\.\./\.\./src/" app src workers packages --include=*.ts --include=*.tsx --include=*.astro` | nothing |
| V3 | Site unchanged | build, fingerprint, `diff /tmp/fp-before.txt /tmp/fp-after.txt` | no diff |
| V4 | No Node code in the site bundle | `grep -rlE "node:fs\|js-yaml" dist/_astro \|\| echo clean` | `clean` |
| V5 | tsx resolves core | `CITY=brisbane pnpm markdown && git status --porcelain` | exit 0; the diff is empty or identical to the same command run on `origin/main` |
| V6 | Worker | `pnpm --dir workers/mcp typecheck && pnpm --dir workers/mcp test && pnpm --dir workers/mcp exec wrangler deploy --dry-run --outdir /tmp/mcp` | exit 0 |
| V7 | Lint rule bites | temporarily add `import "node:fs";` to `packages/core/src/schema.ts`, then run `pnpm exec biome check packages` | error; then revert |
| V8 | Boundary check bites | temporarily add `import "../../../src/common.ts";` to a core file, then run `node scripts/check-boundaries.mjs` | non-zero exit naming the file; then revert |
| V9 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch.
