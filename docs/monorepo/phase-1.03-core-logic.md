# Sub-phase 1.3 — Move the pure web logic into core

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.3 (core logic) of PR 1, the eventyr monorepo refactor.
>
> - Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.03-core-logic.md`. Don't read any other phase files.
> - Work on branch `monorepo/refactor`, even if your environment suggests another branch. If you can't push to it, stop and ask.
> - Sync first, following PLAN §4.3.
> - Follow the steps in order and use `git mv` for every move.
> - Run every verification. Post the results as a comment on the PR 1 draft, then tick 1.3.
> - If a check fails and the fix isn't obvious and in scope, stop and report.
> - Push. Don't merge, and don't start 1.4.

## Goal

Move every pure module under `app/utils/` into `packages/core/src/`, along with its tests. Where a
module mixes pure logic with browser APIs, split it: the pure half goes to core and the browser
half stays in `app/`. The MCP Worker then stops importing from `app/`. No behaviour changes.

## Preconditions

- 1.2 is committed on the branch.

## Files affected

**Whole files, moved with `git mv` to `packages/core/src/` together with their tests:**
- `search.ts` (+ `search.test.ts`)
- `grouping.ts` (+ test)
- `timeOfDay.ts` (+ test)
- `vibes.ts`
- `tagSpecificity.ts` (+ test)
- `weekLayout.ts` (+ test)
- `savedLink.ts` (+ test)
- `calendarLinks.ts` (+ test)
- `dates.ts` (+ `displayDatetime.test.ts`)

**Split files:**

| File | Moves to core (`git mv`) | Stays in `app/utils/` |
|---|---|---|
| `taste.ts` | `core/src/taste.ts` | new `tasteStore.ts`: `loadTaste`/`saveTaste`, `noteInterest`, `onTasteChange`, and anything touching `localStorage`, `window` or `CustomEvent` |
| `tagPrefs.ts` | `core/src/tagPrefs.ts` | new `tagPrefsStore.ts`: `loadTagPrefs`/`saveTagPrefs` |
| `ics.ts` | `core/src/ics.ts` | new `icsDownload.ts`: `downloadIcs` |
| `notifications.ts` | new `core/src/reminders.ts`: `calculate1hReminderTime`, `formatEventTime`, `filterEventsForMorningDigest`, `formatMorningDigest`. Also `git mv notifications.test.ts core/src/reminders.test.ts`. | `notifications.ts` stays for the Notification API, service worker and `matchMedia` |

**Deleted:** `app/utils/categorySlug.ts` and `app/utils/citySlug.ts`. Both are re-exports of `shared.ts`, so their importers switch to `@dothingslol/core/shared`.

**New in core:**
- `identity.ts`: `eventId`, moved from `app/context.tsx:63`. `notifications.ts` currently imports it from the React context.
- `storageKeys.ts`: every `eventyr:*` key literal, so native uses identical names.

**Stays in web:** `mcpInstall.ts`, `platform.ts`, `share.ts`, `pwaStorage.ts`, all hooks and all components.

**Other edits:**
- `workers/mcp/src/resolveTimeframe.ts:10` imports `@dothingslol/core/dates` instead.
- Every `app/` importer of a moved module.
- Split `taste.test.ts`: the storage and `noteInterest` cases move to `app/utils/tasteStore.test.ts`, and the rest go to core along with `taste.ts`.

## Steps

1. **Baseline.** Record the fingerprint (`/tmp/fp-before.txt`), plus the test counts from `pnpm test:app` and `pnpm --filter @dothingslol/core test`.
2. **Whole-file moves, in one commit.** Run `git mv`, then rewrite the imports.
   - Imports inside core keep their `.ts` extension (`./shared.ts`).
   - Consumers import `@dothingslol/core/<module>`.
   - Find the importers with `grep -rn "utils/<name>" app src workers`.
3. **Splits, one commit per file.** For each split file:
   - `git mv` the file to core.
   - Create the new web file.
   - Cut the browser-bound functions across unchanged (byte-identical bodies). The web half imports the pure functions from core.
4. **`eventId` and `storageKeys`.**
   - Move `eventId` out of `context.tsx` unchanged, then update its importers.
   - Replace the key literals with constants. The **values must stay identical**, because users' stored data depends on them.
5. **Purity audit.** This must print nothing:
   ```bash
   grep -nE "\b(window|document|localStorage|sessionStorage|navigator|indexedDB|matchMedia|Blob|CustomEvent)\b" packages/core/src/*.ts | grep -v '\.test\.ts'
   ```
   List every use of `URL`, `URLSearchParams`, `btoa`, `atob`, `TextEncoder` and `Intl` in core in the PR comment. React Native's `URL` and `URLSearchParams` are incomplete, and 2.4 checks each listed use under Hermes.
6. **Docs.** Add one line to `CLAUDE.md` "Key files": `packages/core` holds all node-free, React-free logic shared by web, native, mcp and pipeline.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0; total tests (app + core) equal the baseline |
| V2 | Purity | the step 5 grep | nothing |
| V3 | No app imports outside web | `grep -rn "app/utils" workers src/*.ts src/adapters src/providers packages` | nothing |
| V4 | Site unchanged | fingerprint diff | no diff |
| V5 | Storage keys unchanged | `git diff origin/main -- . \| grep -E '^-.*"eventyr:'`, then confirm each removed literal is in `storageKeys.ts` | same key set |
| V6 | Worker | `pnpm --dir workers/mcp typecheck && pnpm --dir workers/mcp test && pnpm --dir workers/mcp exec wrangler deploy --dry-run --outdir /tmp/mcp` | exit 0 |
| V7 | Browser smoke | `pnpm preview`, then on `/brisbane/`: save an event and reload (still saved), open the saved calendar, search "jazz" | works, no console errors |
| V8 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch.
