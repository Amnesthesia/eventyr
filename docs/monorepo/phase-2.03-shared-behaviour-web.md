# Sub-phase 2.3 — Shared behaviour changes on web: device time, taste model v2, Settings page

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 2.3 (shared behaviour, web) of PR 2, the eventyr React Native app. Read
> `docs/monorepo/PLAN.md` (especially §7 and §8) and `docs/monorepo/phase-2.03-shared-behaviour-web.md`,
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
  - `packages/core/src/grouping.ts`: the tier comparator now reads v2 `prefTier` (the hard tier is kept, D13)
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
   export function formatWhen(e: Pick<EventData,"datetime"|"datetime_iso"|"datetime_end_iso">,
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

## Part B: taste model v2 (D13)

Build exactly what PLAN §7.2 specifies.

1. **`core/tasteProfile.ts`**
   - **Types:** `TasteKey`, `TasteState` (`"off" | "unset" | "on"`) and `TasteProfileV2` (`weights`, `manual`, `applied`, `signals`, `autoLearn`).
   - **Signal functions:** `emptyProfile()`, `like`, `unlike`, `dislike`, `undislike`, `noteShare`, `noteCalendar`. Each takes `(profile, event, ctx)` and returns a new profile. All of them apply these rules:
     - **Skip manual keys.**
     - **Respect `autoLearn`.** When it's off, weights stay unchanged. The event-level bookkeeping still runs, so an unlike later reverses nothing.
     - **Record deltas** under `applied["like:"+eventHash]` and the equivalent keys for the other signals.
   - **User actions:**
     - `setState(profile, key, state)`. If `state` equals the current state, nothing happens. Otherwise it writes −1 / 0 / +1 and marks the key manual. `"unset"` deletes the weight and the manual mark, and increments `signals`.
     - `stateOf(profile, key)` returns `sign(weight)` as a `TasteState`.
     - `resetAll(profile)` and `setAutoLearn(profile, on)`.
   - **Ranking:** `tasteBoost(event, profile)` and `rankByTaste(events, profile)` keep the v1 formula: ±4 cap, 0.55/0.25/0.2 weights, 1.5 curve. **Manual keys count at their group's strongest absolute weight** (v1 `effectiveTaste` semantics). `MIN_SIGNAL` counts `signals`.
   - **Hard tier (kept, D13):** `prefTier(event, profile)` returns +1 if any of the event's tags is manually On, −1 if any is manually Off (Off wins, matching v1), and 0 otherwise. `grouping.ts` sorts by it first, exactly as v1 did with more/less.
   - **Migration:** `migrateFromV1(taste: Record<string, number>, tagPrefs: Record<string, 1 | -1>): TasteProfileV2`.
     - `weights` come from `taste`.
     - Each pref becomes a manual key with weight ±1.
     - `signals` is the v1 save count plus the number of prefs.
2. **Equivalence tests** (PLAN R11). Keep a frozen copy of the v1 functions in the test file, marked `ponytail:` with a note to delete it after one release.
   - **No stated prefs:** `rankByTaste(events, migrateFromV1(v1))` must order events **exactly** as v1 did.
   - **With stated prefs:** also **exact**. Manual keys at full group strength plus the kept tier reproduce v1's `effectiveTaste` and tier sort. Any difference is a bug.
3. **Web store: `tasteProfileStore.ts`**
   - Load `eventyr:taste-profile`. If it's absent, migrate from `eventyr:taste` + `eventyr:tag-prefs`. **Leave the v1 keys in place.**
   - Keep the `eventyr:taste-change` event.
   - Save, share, calendar-add, dislike and unhide in `context.tsx`, `SwipeMode` and `CardActionSheet` call the v2 functions.
4. **`PreferencesPane`.** Remove the dialog. Its entry point links to `/settings/#taste`. Tag chips on cards tint by state: "on" as more, "off" as less.

## Part C: the `/settings/` page

1. **Route.** `src/pages/settings.astro` uses the Base layout plus a `SettingsApp` island (`client:load`). It isn't per-city. Tags are the union across all cities' payloads at build time, ordered by frequency, top 150, plus a search field over all tags.
2. **Sections and copy.** Use the text in PLAN §7.3 verbatim.
   - **Notifications.** A toggle in `eventyr:notifications`, with values `"on"` or `"off"`. An absent key means on, which is today's behaviour. Show the explanation copy.
     - Off cancels in-page timers and posts a cancel message to the service worker.
     - `NotificationPrompt` and the auto-prompt on first save respect the toggle.
   - **Your taste.** Show the privacy note, then the "Learn from likes and dislikes" toggle, then Tags (with search), Vibes and Categories.
     - Each row is a segmented **Off · Unset · On** control (`stateOf` / `setState`).
     - **No numbers** and no learned/manual badge.
     - "Reset all preferences" has a confirm dialog.
   - **Appearance.** System, Light or Dark. System removes the `theme` key. `useColorTheme` gains the explicit system option.
3. **Header.** Add a gear link to `/settings/` with `aria-label="Settings"`. The existing theme toggle stays.
4. **Accessibility.** Each segmented control is a radio group labelled with the tag name, for example "jazz: Off, Unset, On", with the selected state announced.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 with the new core tests |
| V2 | Device-time regression | the `when.ts` Brisbane fixture test | identical strings |
| V3 | Migration equivalence | the `tasteProfile` equivalence tests | identical order, with and without prefs |
| V4 | Web behaviour with a Brisbane zone | `TZ=Australia/Brisbane`, then preview and run `filter-parity.mjs` against the 2.1 baseline (rebuild the baseline from `origin/main` if the data moved) | counts identical. Card titles and order are identical for a fresh profile. |
| V5 | Existing user migration (manual) | On `origin/main`'s build, save 3 events and set 2 tag prefs (one more, one less). Then switch to this build on the same origin (`pnpm preview` on port 4321 for both) | Settings shows the 3 learned tags as On and the 2 prefs as On/Off. Picks order unchanged. v1 keys are still present in DevTools → Application |
| V6 | Device time (manual) | Chrome DevTools → Sensors → time zone `Australia/Sydney` | timed events move +1 h during DST, date-only events are unchanged, and the static `/e/` page matches after hydration |
| V7 | Settings (manual) | Toggle notifications off, then save an event | no permission prompt and no scheduling. Turning it back on restores the behaviour. |
| V8 | Manual pin and opt-out (manual) | Set a tag Off, then like an event that has that tag; separately, turn learning off and like 3 events | The Off tag stays Off (manual keys aren't touched by learning). With learning off, no state changes. Turned back on, liking one event flips an Unset tag to On |
| V9 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch. After PR 2 merges, a revert returns web users to
the untouched v1 keys. Changes they made in Settings since the merge are lost, but nothing breaks.
