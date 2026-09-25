# Sub-phase 1.5: `@dothingslol/utils`

> **Handoff: paste into a fresh Claude Code session**
>
> Execute sub-phase 1.5 (utils package) of PR 1, the eventyr monorepo refactor.
>
> - Read `docs/monorepo/PLAN.md` (especially §2.1, §2.3 and §2.7) and `docs/monorepo/phase-1.05-utils-package.md`. Don't read other phase files.
> - Work on branch `monorepo/refactor`, even if your environment suggests another. If you can't push to it, stop and ask.
> - Sync first, as PLAN §4.3 describes.
> - Follow the ordered steps, using `git mv` wherever a whole file moves.
> - Run every verification. Post the results as a comment on the PR 1 draft and tick 1.5.
> - If a check fails and the fix isn't obvious and in scope, stop and report.
> - Push. Don't merge, and don't start 1.6.

## Goal

Create `packages/utils`: generic, domain-free, **Node-free** helpers that `llm`, `scraper`, the
pipeline, `core`, web and native can all depend on.

- It takes over the general-purpose pieces now trapped in `src/providers/base.ts` and `src/text.ts`.
- Behaviour doesn't change.
- **Scope rule:** if a helper knows what an event, city, source, model or file path is, it does **not** belong here.

## Preconditions

- 1.4 is committed on the branch.

## What moves

| From | To | Notes |
|---|---|---|
| `src/text.ts` (`cleanText`, `cleanUrl`, `he` entity decoding) and `src/text.test.ts` | `packages/utils/src/text.ts` + test | `git mv`. It depends on `he`, which is pure JS and browser-safe. |
| `mapWithConcurrency`, `chunkArray` from `src/providers/base.ts` | `packages/utils/src/concurrency.ts` (+ tests if `base.test.ts` covers them) | Cut out verbatim. `chunkArray` is exported as `chunk`, with `chunkArray` kept as an alias until 1.11 so this commit stays small. |
| `sleep` and the jittered exponential backoff arithmetic in `src/providers/gemini.ts` (`retryDelayMs`: only the `BASE_BACKOFF_MS * 2 ** attempt` + jitter part) | `packages/utils/src/time.ts` (`sleep`, `backoffDelay(attempt, baseMs)`) | The provider-specific parts stay for 1.6: the regex that recognises 429/503 messages and the `Retry-After` parse. |
| `src/tz.ts` (added in PR 0) and its test | `packages/utils/src/tz.ts` + test | `git mv`. It's used by `dates.ts` and the per-city offset sites. `scraper` and `pipeline` share this one implementation. |

**Do not move:**

- `parseJsonArray`: it repairs model output, so it goes to `llm` in 1.6.
- `requireEnv`: pipeline, Node.
- `eventHash` and dates-for-events: core.
- Anything in `common.ts` except what's listed above.

## Steps

1. **Scaffold `packages/utils`.** Use the same shape as core, with:
   - `"name": "@dothingslol/utils"`, `private`, `type: module`, `sideEffects: false`
   - an **explicit** `exports` map: `".": "./src/index.ts"`, `"./text"`, `"./concurrency"`, `"./time"`, `"./tz"`
   - dependencies: `he`
   - devDependencies: `@types/he`, `typescript`, `tsx`
   - scripts: `test`, `typecheck`
   - a tsconfig extending `tsconfig.base.json`, NodeNext, ES2022, no DOM
2. **Add `utils` to the lint and boundary rules.**
   - Add `utils` to the Biome `noNodejsModules` override.
   - Add its row to `scripts/check-boundaries.mjs` (no workspace deps). Add `utils` to the `core` row as allowed.
3. **Moves.** Commit the `git mv` of `text.ts` and its test on its own. Then cut the functions out of `base.ts` and `gemini.ts` in a second commit.
4. **Rewire.**
   - The root package depends on `@dothingslol/utils: workspace:*`.
   - Importers of `text.ts` (`curate.ts` and adapters: `grep -rn "text.ts" src`) switch to `@dothingslol/utils/text`.
   - Importers of `mapWithConcurrency`/`chunkArray` switch to `@dothingslol/utils/concurrency`: `enrichTimes.ts:39`, `collect.ts:28`, `discover.ts:40`, `locality.ts:38`, `venues.ts:39`, `rank.ts:14`, plus anything else `grep -rn "mapWithConcurrency\|chunkArray" src` finds.
   - `base.ts` and `gemini.ts` import the helpers they use from utils.
5. **`CLAUDE.md`.** In "Calling models", the bullet that points at `mapWithConcurrency` (`src/providers/base.ts`) now points at `@dothingslol/utils/concurrency`. In "Key files", add one line describing utils and its scope rule.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0; test count = baseline |
| V2 | Node-free | `pnpm exec biome check packages/utils` | clean (the lint rule is active) |
| V3 | No stragglers | `grep -rnE "export (async )?function (mapWithConcurrency\|chunkArray\|cleanText\|cleanUrl)" src app` | nothing |
| V4 | Boundaries | `node scripts/check-boundaries.mjs` | exit 0 |
| V5 | Behaviour | `CITY=brisbane TZ=Australia/Brisbane pnpm markdown && pnpm rss && git status --porcelain` | empty, or identical to the same commands on `origin/main` |
| V6 | Site unchanged | build + fingerprint diff | no diff |
| V7 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch.
