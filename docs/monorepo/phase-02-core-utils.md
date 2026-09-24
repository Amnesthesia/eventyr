# Phase 02: move the pure web logic into core

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 02 (core utils) of the eventyr monorepo refactor. Read `docs/monorepo/PLAN.md`
> and `docs/monorepo/phase-02-core-utils.md`, and no other phase files. Branch
> `monorepo/phase-02-core-utils` from the latest `main`. Follow the ordered steps, use `git mv`
> for every move, run every verification command and paste the results into the PR description.
> If a check fails and the fix isn't obvious and inside this phase's scope, stop and report.
> Open a PR, don't merge, and don't start phase 03.

## Goal

Move every pure module under `app/utils/` into `packages/core/src/`, along with its tests. Where
a file mixes pure logic with browser APIs, split it: the pure half goes to core and the
browser-bound half stays in `app/`. The MCP Worker then stops importing from `app/`. There is
no behaviour change.

## Preconditions

- Phase 01 is merged, so `@dothingslol/core` exists and `scripts/check-boundaries.mjs` runs in `pnpm check`.

## Files affected

**Whole-file `git mv` to `packages/core/src/`, each with its test:**
- `search.ts` + `search.test.ts`
- `grouping.ts` + `grouping.test.ts`
- `timeOfDay.ts` + `timeOfDay.test.ts`
- `vibes.ts`
- `tagSpecificity.ts` + `tagSpecificity.test.ts`
- `weekLayout.ts` + `weekLayout.test.ts`
- `savedLink.ts` + `savedLink.test.ts`
- `calendarLinks.ts` + `calendarLinks.test.ts`
- `dates.ts`, plus `displayDatetime.test.ts` and any other `dates` tests

**Split into core and web halves:**

| File | Pure half moves to core | Browser half stays in `app/utils/` |
|---|---|---|
| `taste.ts` | `git mv` to `core/src/taste.ts` | `tasteStore.ts` (new): `load`/`save`, `noteInterest`, `onTasteChange`, anything touching `localStorage`, `window` or `CustomEvent` |
| `tagPrefs.ts` | `git mv` to `core/src/tagPrefs.ts` | `tagPrefsStore.ts` (new) |
| `ics.ts` | `git mv` to `core/src/ics.ts` | `icsDownload.ts` (new): `downloadIcs` |
| `notifications.ts` | new `core/src/reminders.ts`: `calculate1hReminderTime`, `formatEventTime`, `filterEventsForMorningDigest`, `formatMorningDigest` | `notifications.ts` stays: Notification API, service worker, `matchMedia`. `notifications.test.ts` moves to `core/src/reminders.test.ts` via `git mv`, because it tests the pure functions |

**Deleted:** `app/utils/categorySlug.ts` and `app/utils/citySlug.ts`. Both are re-exports of `shared.ts`, so their importers switch to `@dothingslol/core/shared`.

**New in core:**
- `identity.ts`: `eventId` moves here from `app/context.tsx:63`. `app/utils/notifications.ts` currently imports it from the context, which drags React into what should be pure logic.
- `storageKeys.ts`: the `eventyr:*` localStorage key literals, so native mirrors the same names.

**Staying in web:** `mcpInstall.ts`, `platform.ts`, `share.ts`, `pwaStorage.ts`, all hooks, and all components.

**Other edits:**
- `workers/mcp/src/resolveTimeframe.ts:10` changes to `@dothingslol/core/dates`.
- Every `app/` importer of the moved modules.
- The `taste.test.ts` split: storage and `noteInterest` tests go to `app/utils/tasteStore.test.ts`, the rest move with `taste.ts`.

## Steps

1. **Baseline.** Record the web build fingerprint (`/tmp/fp-before.txt`) and the test counts from `pnpm test:app` and `pnpm --filter @dothingslol/core test`.
2. **Whole-file moves.** Do them first, in one commit: run `git mv` for each file, then rewrite imports.
   - Inside core, relative imports keep the `.ts` extension (`./shared.ts`).
   - Consumers import `@dothingslol/core/<module>`.
   - Build the importer list with `grep -rn "utils/<name>" app src workers`.
3. **Splits.** Do each file in its own commit, so the diffs stay reviewable. The pattern is: `git mv` the file to core, create the new web file, then cut the browser-bound functions across.
   - Keep function bodies byte-identical. Only the imports change.
   - Where the web half used to call a pure function, it now imports it from core.
4. **`eventId` and `storageKeys`.**
   - Move `eventId` out of `context.tsx` unchanged. Re-export it from `context.tsx` only if something still needs that import path; otherwise update the importers.
   - Replace the key literals in `taste.ts`, `tagPrefs.ts` and `hooks/useStoredSet.ts` callers with the constants. Their values must stay identical, because stored user data depends on them.
5. **Purity audit.** This must print nothing outside test files:
   ```bash
   grep -nE "\b(window|document|localStorage|sessionStorage|navigator|indexedDB|matchMedia|Blob|CustomEvent)\b" packages/core/src/*.ts | grep -v '\.test\.ts'
   ```
   Also list every use of `URL`, `URLSearchParams`, `btoa`, `atob`, `TextEncoder` and `Intl` in core, and put that list in the PR description. React Native's `URL` and `URLSearchParams` are incomplete, and phase 10 checks each listed use under Hermes.
6. **Scripts.** `test:app` keeps its glob, since the remaining app tests are components plus `tasteStore`. Core's `test` script picks up the moved tests automatically.
7. **Docs.** Update the `app/utils/mcpInstall.ts` mention in `CLAUDE.md` only if its path changed (it shouldn't). Add one line under "Key files" saying `packages/core` holds all node-free, React-free logic shared by web, native, mcp and pipeline.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0. Total test count (app + core) equals the baseline total |
| V2 | Purity | the step 5 grep | no output |
| V3 | No app imports from outside the web | `grep -rn "app/utils" workers src/*.ts src/adapters src/providers packages` | no output |
| V4 | Site unchanged | build + `scripts/site-fingerprint.sh` + diff against the baseline | no diff |
| V5 | Storage keys unchanged | `git diff main -- . \| grep -E '^-.*"eventyr:'`, then check every removed literal reappears in `storageKeys.ts` | same key set |
| V6 | Worker | `pnpm --dir workers/mcp typecheck && pnpm --dir workers/mcp test && pnpm --dir workers/mcp exec wrangler deploy --dry-run --outdir /tmp/mcp` | exit 0 |
| V7 | Browser smoke | `pnpm preview`, open `/brisbane/`, save an event, reload, and check it is still saved. Open the saved calendar. Search for "jazz" | works, no console errors |
| V8 | PR CI | `CI` | green |

**After merge:** `Deploy to GitHub Pages` is green, and `/brisbane/` loads and hydrates (check the
browser console).

## Rollback

Revert the squash-merge. Stored user data is untouched: V5 proves the key values are unchanged.
