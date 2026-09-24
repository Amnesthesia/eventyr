# Phase 09 — Align the web app on React 19

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 09 (React 19) of the eventyr monorepo refactor. Read `docs/monorepo/PLAN.md`
> and `docs/monorepo/phase-09-react-19.md`, and no other phase files. Branch
> `monorepo/phase-09-react-19` from the latest `main`. Follow the ordered steps, run every
> verification command and paste the results into the PR description. If a check fails and the
> fix is not obvious and within this phase's scope, stop and report. Open a PR, don't merge it,
> and don't start phase 10.

## Goal

Upgrade `apps/web` from React 18.3.1 to the exact React version bundled by the Expo SDK that
phase 10 will use. That leaves one React version in the workspace. Expo documents that duplicate
React in one app is a runtime error. A single catalog version removes the hoisting and peer
ambiguity for shared tooling as well. **Astro stays on 6.x**: `@astrojs/react` 5 already accepts
React 19. The Astro 7 upgrade is a separate follow-up (PLAN §9).

## Preconditions

- Phase 04 is merged, so web is at `apps/web`. The parity script (`scripts/filter-parity.mjs`) exists.
- Decide on the Expo SDK now. Use the latest stable SDK: `npm view expo version`, then read that SDK's React version from `bundledNativeModules.json` on the `sdk-<N>` branch of expo/expo. When this plan was written that was SDK 57 with React **19.2.3**. If SDK 58 is stable by the time you run this, use its React (19.3.x per its preview) and record the choice in the PR, because phase 10 must use the same SDK.

## Files affected

- `pnpm-workspace.yaml` catalog: `react`, `react-dom`, `@types/react`, `@types/react-dom`.
- `apps/web/app/**`: only where React 19 types or behaviour require a change.
- `pnpm-lock.yaml`.

## Steps

1. **Baseline on `main`, same session.**
   - Build the site with `TZ=Australia/Brisbane pnpm build`.
   - Run `scripts/site-fingerprint.sh apps/web/dist /tmp/fp-before.txt`.
   - Run `pnpm preview &`, then `node scripts/filter-parity.mjs http://localhost:4321 /tmp/parity-before.json`.
2. **Catalog.** Set `react` and `react-dom` to the exact SDK version (for example `19.2.3`, with no caret, so a later install can't drift ahead of Expo). Set `@types/react` and `@types/react-dom` to the matching `^19.x`. Then run `pnpm install`.
3. **Fix what the compiler reports.** Run `pnpm --filter @dothingslol/web typecheck`. The usual React 19 type breaks are:
   - The global `JSX` namespace is gone. Use `React.JSX`: `grep -rn "JSX\." apps/web/app`.
   - `useRef()` now requires an argument.
   - `ReactElement` props default to `unknown`.
   - Ref callbacks can't implicitly return a value.

   Fix only what fails. Don't adopt new React 19 APIs in this phase.
4. **Runtime behaviour to check deliberately:**
   - Hydration of the `client:load` island. React 19 reports hydration mismatches differently.
   - The `<dialog>` handling in `hooks/useModalDialog.ts`.
   - Long-press timers in `hooks/useLongPress.ts`.
   - `SavedCalendarQr` (`qrcode-generator` is React-independent).
   - Service worker registration.
5. **Peer warnings.** `pnpm install` must print no unmet-peer warnings for React. `lucide-react@0.469` declares `^19`, and `@astrojs/react@5` declares `^19`. If any other package pins React 18, report it. Don't force-resolve it.
6. **Confirm one React.** `pnpm why react --depth=10` must show exactly one version.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 (component tests render under React 19) |
| V2 | Behaviour parity | Rebuild, run `pnpm preview`, run `filter-parity.mjs` to produce `/tmp/parity-after.json`, then `diff <(jq -S . /tmp/parity-before.json) <(jq -S . /tmp/parity-after.json)` | no diff, and the script's `console.error` capture is empty (a hydration error would show up there) |
| V3 | Prerendered HTML | fingerprint diff | Differences are allowed only in island serialisation markers. Inspect each changed file's diff and paste a representative hunk into the PR. Visible text must not change |
| V4 | Single React | `pnpm why react --depth=10` | one version, equal to the Expo SDK's |
| V5 | Manual smoke (`pnpm preview`) | Save an event → Saved section → week calendar → QR → share link → open the link in a new tab → "Save all". Swipe mode: save, skip, undo. Preferences pane. Theme toggle. Notification prompt → "Send test notification" | all of these work, with no console errors |
| V6 | PR CI | `CI` | green |

**After merge:** `Deploy to GitHub Pages` is green. On production, run `filter-parity.mjs` against
`https://www.dothings.lol`: it must complete with no console errors. Then load `/brisbane/` on a
real phone and try one save and one share.

## Rollback

Revert the squash-merge. No stored data or generated files depend on the React version.
