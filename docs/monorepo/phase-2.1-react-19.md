# Sub-phase 2.1 — Move the web app to React 19 (opens PR 2)

> **Handoff — paste into a fresh Claude Code session**
>
> Execute sub-phase 2.1 (React 19) of PR 2, the eventyr React Native app.
>
> 1. **Check that PR 1 is merged into `main`.** If it isn't, stop.
> 2. Create the branch: `git fetch origin && git checkout -b native/app origin/main`. Use `native/app` even if your environment suggests a different branch. If you can't push to it, stop and ask.
> 3. Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-2.1-react-19.md`. Don't read any other phase files.
> 4. Follow the steps in order.
> 5. Push the branch and open a **draft** PR titled "React Native app (PR 2)". Its description should hold a checklist of sub-phases 2.1–2.9.
> 6. Post your verification results as a PR comment and tick 2.1.
>
> If a check fails and the fix isn't obvious and in scope, stop and report. Don't merge, and don't start 2.2.

## Goal

Upgrade `apps/web` from React 18.3.1 to the **exact** React version bundled with the Expo SDK
that the app will use. That leaves one React version in the workspace (PLAN R4). Astro stays on 6.x,
because `@astrojs/react@5` already accepts React 19.

## Preconditions

- PR 1 is merged, and its post-merge runbook steps 1 and 2 are green.
- **Pick the Expo SDK now.** Take the latest stable version (`npm view expo version`). Then read that SDK's React version from `bundledNativeModules.json` on the `sdk-<N>` branch of expo/expo. At planning time this was SDK 57 with React 19.2.3.
  - Record the SDK and React version in the PR description. Every later sub-phase uses them.

## Files affected

- `pnpm-workspace.yaml`: the catalog entries for `react`, `react-dom`, `@types/react` and `@types/react-dom`.
- `apps/web/app/**`: only where React 19 types or behaviour force a change.
- `pnpm-lock.yaml`.

## Steps

1. **Baseline, in the same session as the checks below.**
   - Build: `TZ=Australia/Brisbane pnpm build`.
   - Fingerprint: `scripts/site-fingerprint.sh apps/web/dist /tmp/fp-before.txt`.
   - Start `pnpm preview &`, then run `node scripts/filter-parity.mjs http://localhost:4321 /tmp/parity-before.json`.
2. **Update the catalog.**
   - Set `react` and `react-dom` to the exact SDK version, with no caret.
   - Set `@types/react` and `@types/react-dom` to the matching `^19.x`.
   - Run `pnpm install`.
3. **Fix what `pnpm --filter @dothingslol/web typecheck` reports.** The usual React 19 type breaks are:
   - the global `JSX` namespace is gone, so use `React.JSX` (find uses with `grep -rn "JSX\." apps/web/app`)
   - `useRef()` needs an argument
   - `ReactElement` props default to `unknown`
   - ref callbacks can't implicitly return a value

   Fix only what fails. Don't adopt new React 19 APIs.
4. **Exercise the behaviour most likely to change.**
   - Hydration of the `client:load` island
   - `hooks/useModalDialog.ts` (`<dialog>`)
   - `hooks/useLongPress.ts`
   - `SavedCalendarQr`
   - service worker registration
5. **Clear peer warnings.** `pnpm install` must print no unmet React peer warnings. If any package still pins React 18, report it rather than force-resolving it.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Behaviour parity | rebuild, preview, run `filter-parity.mjs` → `/tmp/parity-after.json`, then diff against the baseline | no diff and no console errors (the script fails on hydration errors) |
| V3 | Prerendered HTML | fingerprint diff | Only island serialisation markers may differ. Inspect each changed file and paste a representative hunk into the comment. No visible text changes. |
| V4 | Single React | `pnpm why react --depth=10` | exactly one version, equal to the SDK's |
| V5 | Manual smoke (`pnpm preview`) | save an event → Saved section → week calendar → QR → share link → open it in a new tab → "Save all" → swipe mode (save, skip, undo) → preferences pane → theme toggle → "Send test notification" | everything works, with no console errors |
| V6 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on `native/app`.
