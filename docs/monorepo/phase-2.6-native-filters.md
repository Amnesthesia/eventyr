# Sub-phase 2.6 — Native filters and search to parity

> **Handoff — paste into a fresh Claude Code session**
>
> Execute sub-phase 2.6 (native filters) of PR 2, the eventyr React Native app.
>
> - Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-2.6-native-filters.md`, and no other phase files.
> - Work on branch `native/app`, even if your environment suggests another. If you can't push to it, stop and ask.
> - Sync first, as described in PLAN §4.3.
> - Follow the ordered steps and run every verification.
> - Post the results as a comment on the PR 2 draft and tick 2.6.
> - List the device-check items as pending for a human rather than claiming them.
> - If a check fails and the fix isn't obvious and in scope, stop and report.
> - Push, but don't merge, and don't start 2.7.

## Goal

Implement every item under "Filters and search" in PLAN §5, driven by `@dothingslol/core/filters`
with nothing reimplemented. Also turn the web's category and timeframe pages into deep-linkable
presets.

Filter state isn't persisted, which matches the web. Only the city is remembered.

"Today", "Tomorrow" and "Weekend" use the **device** date (D7), the same as the web.

## Preconditions

- 2.5 is committed on the branch.
- `scripts/filter-parity.mjs` (from 1.4) provides the interaction list used as the parity table here.

## Files affected

- **State:** `apps/native/src/state/filters.ts`, a reducer over core's `FilterState`.
- **Routes:**
  - `apps/native/app/[city]/index.tsx`
  - `apps/native/app/[city]/filters.tsx`: a new modal
  - `apps/native/app/[city]/[preset].tsx`: new. It resolves a category slug, `today`, `tomorrow` or `this-weekend` into a preset.
- **Components**, all in `apps/native/src/components/filters/`:
  - `CategoryChips`
  - `WhenSegmented`
  - `DateRangeSheet`
  - `TimeOfDayChips`
  - `PastSegmented`
  - `ScoreTiers`
  - `VibeChips`
  - `TagPicker`
  - `VenuePicker`
  - `SearchField`
  - `ActiveFilterStrip`
  - `ResultsHeader`
  - `HiddenBelowScoreNote`
- **Dependency:** `@react-native-community/datetimepicker`, installed with `expo install`.

## Steps

1. **State.**
   - Use `useReducer(DEFAULT_FILTERS)`. Its actions mirror the setters in `apps/web/app/context.tsx` one to one.
   - Derive everything from core: `applyFilters`, `splitSections`, `facetCounts`, `dateBounds` and `hasActiveFilters`. Pass `keyOf: eventHash` and memoise.
   - Recompute `now` whenever the app returns to the foreground (`AppState` becomes `active`) and at local midnight.
2. **List header**, which is always visible:
   - **`SearchField`.** On iOS this can use `headerSearchBarOptions`. It uses core `search` and shows a live count.
   - **`CategoryChips`.**
   - **`WhenSegmented`** (Any / Today / Tomorrow / Weekend), plus a "Dates…" button that opens `DateRangeSheet`, bounded by `dateMin`/`dateMax`.
   - **"Filters (n)".**
   - **`ActiveFilterStrip`**, with removable chips and "Clear all".
   - **`ResultsHeader`**, showing "X of Y events match" and the range.
3. **Filters modal.**
   - **Time of day:** multi-select.
   - **Past:** Upcoming / Include / Only.
   - **Score tiers:** Any(4) / 6+ / 7+ / 8+.
   - **Vibes:** with counts; disabled when the count is 0.
   - **Tags:** the top 18, plus a typeahead up to 60. Exclude tags that are also vibe names.
   - **Venue:** searchable, with counts.

   All counts come from `facetCounts`.
4. **Card taps.** Wire up the affordances left inert in 2.5. Tapping a venue, vibe or tag toggles that filter.
5. **"N events scoring below X hidden — Show them."** One per group. It sets the minimum score to 0 and uses the web's wording.
6. **Hidden and disliked.** Persist `STORAGE_KEYS.hidden` and `STORAGE_KEYS.disliked` as sets of `eventHash`, because `applyFilters` already takes `hidden`. Their UI arrives in 2.7.
7. **Presets.**
   - `/[city]/[preset]` maps category slugs through the inverse of core's `catToSlug`, and maps `today`, `tomorrow` and `this-weekend` to When presets.
   - Any other value opens the city with no preset. Never show a blank screen.
   - Example: `dothings://gold-coast/today` must open Gold Coast filtered to today.
8. **Parity table.** Encode the `filter-parity.mjs` interaction list as `FilterState` values in `src/state/filters.parity.test.ts`.
   - Run each through the reducer and core, against a `toFeedCity` snapshot of `data/brisbane.json`.
   - Assert that the reducer builds the same `FilterState` the web builds for each interaction, and that the resulting counts are equal.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Native CI | the five `native` commands from 2.4 | exit 0 |
| V3 | Reducer parity | `pnpm --filter @dothingslol/native test` | passes |
| V4 | No reimplemented filtering | `grep -rnE "\.filter\(\(?e(vent)?\)? =>" apps/native/src \| grep -v test` | No event filtering on filter criteria. Justify any remaining hit. |
| V5 | PR CI | `CI` | green |

**Device check (human; compare with the website on the same day):**
1. Run the parity interaction list by hand. "X of Y" matches the web at every step. Record about 20 pairs.
2. The custom date range can't go outside the week.
3. Setting a time band hides untimed events.
4. Searching `jaz` finds jazz events, and `cafe` matches `café`.
5. `dothings://gold-coast/today` and `dothings://brisbane/<category-slug>` open with the preset applied.
6. "Clear all" brings the count back to the unfiltered total.

## Rollback

Revert this sub-phase's commits on the branch.
