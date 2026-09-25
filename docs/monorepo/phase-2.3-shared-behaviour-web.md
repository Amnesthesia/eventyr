# Sub-phase 2.3 — Shared behaviour changes on web: device time, taste model v2, Settings page

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 2.3 (shared behaviour, web) of PR 2, the eventyr React Native app. Read
> `docs/monorepo/PLAN.md` (especially §7 and §8) and `docs/monorepo/phase-2.3-shared-behaviour-web.md`,
> and no other phase files. Work on branch `native/app`, even if your environment suggests another;
> if you can't push to it, stop and ask. Sync first per PLAN §4.3. Parts A, B and C are each one
> commit, or a small series of commits. If context gets tight, stop after a completed part, push,
> and report. Run every verification, post the results as a comment on the PR 2 draft, and tick 2.3.
> If a check fails and the fix isn't obvious and in scope, stop and report. Push, but don't merge,
> and don't start 2.4.
>
> **Scope guard:** if the owner has said Settings and taste v2 are native-only (PLAN §0, the D10
> assumption), do Part A only and stop.

## Goal

Make the three behaviour changes the owner asked for. Their logic lives in `@dothingslol/core`, so
the web adopts them first and native (2.5–2.8) reuses them:

- **A.** Times display in the device's time zone (PLAN §8, D7).
- **B.** Taste model v2: likes and dislikes write directly into visible, overridable weights, and auto-learning can be switched off. Existing web users are migrated (PLAN §7.2).
- **C.** A web `/settings/` page covering notifications, taste, and appearance (PLAN §7.3).

## Preconditions

- 2.2 is committed on the branch.

## Files affected

- **Core:**
  - `packages/core/src/when.ts` (new) and its tests
  - `packages/core/src/tasteProfile.ts` (new) and its tests
  - `packages/core/src/storageKeys.ts`: add `eventyr:taste-profile` and `eventyr:notifications`
  - `packages/core/src/grouping.ts`: tier sort from v2 overrides
  - `packages/core/src/filters.ts`: `splitSections` takes a `TasteProfileV2`
  - `taste.ts` and `tagPrefs.ts`: removed once nothing imports them. Keep the v1 reading code needed by the migration inside `tasteProfile.ts`.
- **Web:**
  - `apps/web/app/utils/{tasteStore,tagPrefsStore}.ts` are replaced by `tasteProfileStore.ts`
  - `apps/web/app/context.tsx`
  - `apps/web/app/components/{EventCard,Header,PreferencesPane,NotificationPrompt,SwipeMode,CardActionSheet}.tsx`
  - `apps/web/app/utils/notifications.ts`
  - `apps/web/app/hooks/useColorTheme.ts`
  - `apps/web/src/pages/settings.astro` (new)
  - `apps/web/app/SettingsApp.tsx` (new)
  - `apps/web/src/pages/[city]/e/[event].astro`: time-zone label on the static time

## Part A — device-time display

1. **Add `core/when.ts`:**
   ```ts
   export function formatWhen(e: Pick<Event,"datetime"|"datetime_iso"|"datetime_end_iso">,
     opts: { now: Date; cityTimeZone: string; locale?: string; timeZone?: string /* default: device */ }): string;
   ```
   - Timed events are formatted from the ISO values with `Intl.DateTimeFormat`, with `timeZone` left undefined so the device zone applies.
   - An ISO value with no offset is interpreted in `cityTimeZone`.
   - Date-only values never shift.
   - It keeps the existing "On now — until …" and multi-day wording from `displayDatetime`. Move those rules here and don't rewrite them.
   - It falls back to `datetime` only when the ISO can't be parsed.
2. **Tests.** Pass an explicit `timeZone` so they're deterministic:
   - Brisbane device: output equals today's `displayDatetime` for a fixture set (the regression guard).
   - Sydney device in DST: timed events show +1 h; date-only events stay the same.
   - An ISO with no offset.
   - "On now".
3. **Web.** `EventCard` and other callers of `displayDatetime` switch to `formatWhen`.
   - Prerendered HTML can't know the viewer's zone. For the SSR and pre-hydration fallback, render the city-local string plus the city zone abbreviation, for example "Sat 27 Sep, 7:00 pm AEST". The island reformats after hydration.
   - The static `/e/` page shows the city-local time with its zone label, plus a tiny inline script that rewrites it into device time.

## Part B — taste model v2

Build exactly what PLAN §7.2 specifies:

1. **`core/tasteProfile.ts`:**
   - Types `TasteKey`, `TasteEntry` and `TasteProfileV2`.
   - `emptyProfile()`, then `like`, `unlike`, `dislike`, `undislike`, and `noteShare`/`noteCalendar`. Each takes `(profile, event, ctx)` and returns a new profile.
     - When `autoLearn` is false, these return the profile unchanged apart from the `applied` bookkeeping, which needs no deltas in that case.
     - Deltas are recorded under `applied["like:"+eventHash]` and the equivalent keys, so reversals are exact.
   - `setOverride(profile, key, value)`, clamped to −3…+3; `clearOverride(profile, key)`; `resetLearning(profile)`; `clearOverrides(profile)`; `setAutoLearn(profile, on)`.
   - `effectiveWeights(profile)`.
   - `tasteBoost(event, profile)` and `rankByTaste(events, profile)`. These carry the v1 formula over unchanged: ±4 cap, 0.55/0.25/0.2, curve 1.5, `MIN_SIGNAL` on learned signal only, and any override counts as signal.
   - `prefTier(event, profile)`: +1 if any tag has `override === 3`, −1 if any has `override === -3`, otherwise 0. It replaces the v1 `tagPrefs` tier.
   - `migrateFromV1(taste: Record<string, number>, tagPrefs: Record<string, 1 | -1>): TasteProfileV2`.
2. **Equivalence tests.** These guard PLAN R11. For fixture v1 states (no prefs, prefs only, learned only, both), `rankByTaste(events, migrateFromV1(v1))` must produce the **same order** as v1's `rankByTaste(events, effectiveTaste(v1taste, v1prefs))` plus the v1 tier sort. Keep a frozen copy of the v1 functions in the test file, marked `ponytail:` with a note to delete it after one release.
3. **Web store: `tasteProfileStore.ts`.**
   - Load `eventyr:taste-profile`. If it's absent, run `migrateFromV1(eventyr:taste, eventyr:tag-prefs)`.
   - **Leave the v1 keys in place.**
   - Keep the `eventyr:taste-change` event.
   - Save, share, calendar-add, dislike and unhide in `context.tsx`, `SwipeMode` and `CardActionSheet` call the v2 functions.
4. **`PreferencesPane`.** The dialog is removed and its entry point links to `/settings/#taste`. Tag chips on cards still tint by effective weight: more for > 0, less for < 0.

## Part C — the `/settings/` page

1. **Route.** `src/pages/settings.astro` uses the Base layout and a `SettingsApp` island (`client:load`). It isn't per-city. Tag lists come from the union of tags across all cities in `data/index.json` payloads at build time, ordered by frequency, top 150.
2. **Sections and copy.** Use the text in PLAN §7.3 verbatim:
   - **Notifications.** A toggle stored in `eventyr:notifications` (`"on"` or `"off"`; absent means on, which matches today's behaviour), with the explanation copy.
     - Off cancels in-page timers and posts a cancel message to the service worker.
     - `NotificationPrompt` and the auto-prompt on first save respect the toggle.
   - **Your taste.** The privacy note, the "Learn from likes and dislikes" toggle, then Tags (with search), Vibes and Categories.
     - Each row shows the weight bar (−3…+3), a "learned" or "set by you" badge, − and + buttons, and reset.
     - "Reset all learning" and "Clear all overrides", each with a confirm dialog.
   - **Appearance.** System, Light or Dark. System removes the `theme` key. `useColorTheme` gains the explicit system option.
3. **Header.** Add a gear link to `/settings/` with `aria-label="Settings"`. The existing theme toggle stays.
4. **Accessibility.** The +/− buttons are labelled "Increase {tag}" and "Decrease {tag}". The weight is exposed as text, not only as a bar.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 with the new core tests |
| V2 | Device-time regression | the `when.ts` Brisbane fixture test | identical strings |
| V3 | Migration equivalence | the `tasteProfile` equivalence tests | same ordering in every fixture |
| V4 | Web behaviour with a Brisbane zone | `TZ=Australia/Brisbane`, then preview and run `filter-parity.mjs` against the 2.1 baseline (rebuild the baseline from `origin/main` if the data moved) | counts identical. Card titles and order are identical for a fresh profile. |
| V5 | Existing user migration (manual) | On `origin/main`'s build, save 3 events and set 2 tag prefs. Then switch to this build on the same origin (both `pnpm preview` on port 4321). | Picks order unchanged, the settings page shows the 3 learned tags and the 2 "+3/−3 set by you" entries, and v1 keys are still present in DevTools → Application |
| V6 | Device time (manual) | Chrome DevTools → Sensors → time zone `Australia/Sydney` | timed events move +1 h during DST, date-only events are unchanged, and the static `/e/` page matches after hydration |
| V7 | Settings (manual) | Toggle notifications off, then save an event | no permission prompt and no scheduling. Turning it back on restores the behaviour. |
| V8 | Opt-out (manual) | Turn learning off, then like 3 events | weights unchanged. Turning it back on and liking one event changes the weights. |
| V9 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch. After PR 2 merges, a revert returns web users to
the untouched v1 keys. Changes they made in Settings since the merge are lost, but nothing breaks.
