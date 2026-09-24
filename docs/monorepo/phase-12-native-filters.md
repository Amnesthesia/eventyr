# Phase 12: Native filters and search to parity

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 12 (native filters) of the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-12-native-filters.md`, and no other phase
> files. Create branch `monorepo/phase-12-native-filters` from the latest `main`. Follow the
> ordered steps, run every verification command, and paste the results into the PR description.
> List the device-check items as pending for a human rather than claiming them. If a check fails
> and the fix isn't obvious and within scope, stop and report. Open a PR. Don't merge it, and
> don't start phase 13.

## Goal

Every filter, search, facet and result affordance in PLAN §5 under "Filters and search", driven
by `@dothingslol/core/filters` with no reimplementation. This phase also covers the web's
category and timeframe pages, which become deep-linkable filter presets. Filter state is **not**
persisted, matching the web; only the city is.

## Preconditions

- Phase 11 is merged.
- The web's filter behaviour is characterised by `scripts/filter-parity.mjs` (phase 03). This phase reuses its interaction list as the device test script.

## Files affected

**Screens and state:**
- `apps/native/src/state/filters.ts`: a reducer over core's `FilterState`.
- `apps/native/app/[city]/index.tsx`
- `apps/native/app/[city]/filters.tsx`: new modal route.
- `apps/native/app/[city]/[preset].tsx`: new; resolves category slugs and `today|tomorrow|this-weekend` into a preset and redirects.

**New components** in `apps/native/src/components/filters/`:
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

**New dependency:** `@react-native-community/datetimepicker`, installed with `expo install`.

## Steps

1. **State.**
   - `useReducer` with `DEFAULT_FILTERS`. Actions mirror the web's context setters one to one; read `apps/web/app/context.tsx` for the list.
   - Derived data comes only from core: `applyFilters`, `splitSections`, `facetCounts`, `dateBounds`, `hasActiveFilters`. Memoise per `(events, filters, hidden, now)`.
   - Recompute `now` on app foreground (`AppState` "active") and at local midnight, the way the web does on `visibilitychange`/`focus`.
2. **The "today" question.** Use the answer to PLAN Q7.
   - If "city time zone": pass the city's `timezone` from the feed into core's date helpers. Phase 02 made `todayIso(tz?)` accept one; add the parameter now if it's still missing, with web behaviour unchanged when it's omitted.
   - If "device": pass nothing.
   - Record which one you used in the PR.
3. **List header (always visible).** It contains:
   - `SearchField`. On iOS this can be expo-router's `headerSearchBarOptions`. Search runs through core `search` with the web's semantics: diacritics, token AND, one typo for tokens of four or more characters. It shows a live count.
   - `CategoryChips`, single select.
   - `WhenSegmented` (Any / Today / Tomorrow / Weekend) with a "Dates…" button that opens `DateRangeSheet`. The sheet is bounded by `dateMin`/`dateMax`.
   - A "Filters (n)" button that opens the modal.
   - `ActiveFilterStrip`: removable chips plus "Clear all".
   - `ResultsHeader`: "X of Y events match" plus the date range.
4. **Filters modal.** It holds:
   - `TimeOfDayChips`: Morning, Afternoon, Evening; multi-select.
   - `PastSegmented`: Upcoming, Include past, Past only.
   - `ScoreTiers`: Any(4), 6+, 7+, 8+.
   - `VibeChips`: shows counts, and is disabled at zero.
   - `TagPicker`: shows the top 18, typeahead up to 60, and excludes tags that duplicate vibe names. Core's facet function should already do the exclusion; check it.
   - `VenuePicker`: a searchable list of `venue_name` values with counts.

   Every count comes from `facetCounts`.
5. **Card taps.** Wire up the phase 11 no-ops: tapping the venue, a vibe or a tag toggles that filter.
6. **Per-group "N events scoring below X hidden — Show them".** It sets the minimum score to 0, and its text must match the web's.
7. **Hidden events.**
   - Persist `STORAGE_KEYS.hidden` now, even though the "not interested" UI arrives in phase 13, because `applyFilters` already takes `hidden`.
   - Persist `STORAGE_KEYS.disliked` alongside it.
   - The "Unhide N hidden" UI ships in phase 13.
8. **Presets and deep links.**
   - `/[city]/[preset]` maps category slugs via core's `catToSlug` inverse, and `today`, `tomorrow` and `this-weekend` to When presets.
   - Anything else routes to the city list with no preset. Never show a blank screen.
   - `dothings://gold-coast/today` must open Gold Coast filtered to today.
9. **Parity script port.**
   - Take the interaction list from `scripts/filter-parity.mjs` and encode the same filter states as a table in `apps/native/src/state/filters.parity.test.ts`.
   - Run each through the reducer and core, over a snapshot of `data/brisbane.json` converted with `toFeedCity`, and assert the counts equal what core returns for the web's `FilterState`.
   - This proves the native reducer builds the same `FilterState` the web does for each interaction.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Native CI | phase 10's five `native` commands | exit 0 |
| V3 | Reducer parity | `pnpm --filter @dothingslol/native test` | the parity table passes |
| V4 | No re-implemented filtering | `grep -rnE "\.filter\(\(?e(vent)?\)? =>" apps/native/src \| grep -v test` | nothing that filters events on filter criteria. List any hits and justify them in the PR |
| V5 | PR CI | `CI` | green |

**Device check (human; compare side by side with the website on the same day):**

1. Run the filter-parity interaction list by hand. After each interaction, the "X of Y" on the phone equals the website's. Record the ~20 pairs in the PR.
2. Custom date range: the picker can't select outside the week's bounds.
3. With a time-of-day band set, untimed events disappear.
4. Typo search `jaz` finds jazz events. `cafe` matches `café`.
5. `dothings://gold-coast/today` and `dothings://brisbane/<a category slug>` open with the filter applied.
6. Clear all resets everything, and the result count equals the unfiltered total.

## Rollback

Revert the squash-merge. The `hidden` and `disliked` keys written by this phase are harmless to
earlier builds.
