# Sub-phase 1.4 — Extract filtering and sectioning from `context.tsx` into core

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.4 (core filters) of PR 1, the eventyr monorepo refactor.
>
> 1. Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.04-core-filters.md`, and no other phase files.
> 2. Work on branch `monorepo/refactor`, even if your environment suggests another. If you can't push to it, stop and ask.
> 3. Sync first, as PLAN §4.3 describes.
> 4. Follow the ordered steps and run every verification.
> 5. Post the results as a comment on the PR 1 draft, and tick 1.4.
>
> If a check fails and the fix is not obvious and in scope, stop and report. Push, but don't merge, and don't start 1.5.

## Goal

The filter predicate, the Saved/Picks/All split, facet counts, `dateMin`/`dateMax` and
`hasActiveFilters` currently live in `useMemo` bodies in `app/context.tsx` (766 lines). None of
them have tests.

1. Capture current behaviour **from the browser**, so the evidence doesn't depend on the code being refactored.
2. Move the logic into `packages/core/src/filters.ts` as pure functions with unit tests.
3. Take the storage key as a parameter (`keyOf`). That way web keeps `eventId` and native can pass `eventHash` (PLAN D6) without touching core again.

## Preconditions

- 1.3 is committed on the branch.
- Chromium is available to `playwright`, which is already a devDependency. Cloud sessions have it preinstalled. Locally, run `pnpm exec playwright install chromium`.

## Files affected

- New: `scripts/filter-parity.mjs`. It is reused in 1.9, 1.13 and 2.1.
- New: `packages/core/src/filters.ts`, `packages/core/src/filters.test.ts`, and `packages/core/src/fixtures/events.ts` (about 25 hand-built events covering every edge case).
- Edited: `app/context.tsx`.

## Steps

1. **Write `scripts/filter-parity.mjs`.** It uses the Playwright library, takes a base URL and an output path, opens `/brisbane/`, and runs 15 to 20 fixed interactions:
   - each category chip
   - When: Today, Tomorrow, Weekend, and a custom range
   - each time band, then two bands together
   - Past: Include, then Only
   - each score tier
   - one vibe, then two
   - one tag, then two (via the typeahead)
   - one venue
   - searches for `jazz`, `jaz`, `café` and `cafe`, and a two-token query
   - Clear all

   After each interaction, record the "X of Y events match" text and the ordered card titles per section, and write everything as JSON. Also capture `console.error` output and fail if any appears. Select elements by visible text and ARIA role, not CSS classes, so 2.1 (React 19) can reuse the script.
2. **Baseline.** On the branch before editing: `TZ=Australia/Brisbane pnpm build && pnpm preview &`, then `node scripts/filter-parity.mjs http://localhost:4321 /tmp/parity-before.json`. Commit the script on its own.
3. **Extract, keeping behaviour the same.** Closed-over state becomes parameters, and inline `new Date()` becomes an injected `now`. Target API (adjust names to match the code, but don't redesign):
   ```ts
   export interface FilterState { category: string | null; when: WhenPreset | null; range: DateRange | null;
     timeBands: TimeBand[]; past: "upcoming" | "include" | "only"; minScore: number; vibes: VibeKey[];
     tags: string[]; venue: string | null; query: string; }
   export const DEFAULT_FILTERS: FilterState;
   export type KeyOf = (e: Event) => string;          // web: eventId; native: eventHash
   export interface FilterContext { now: Date; weekStart: string; weekEnd: string; hidden: ReadonlySet<string>; keyOf: KeyOf; }
   export function applyFilters(events: readonly Event[], f: FilterState, ctx: FilterContext): Event[];
   export function splitSections(filtered: readonly Event[], opts: { starred: ReadonlySet<string>; keyOf: KeyOf;
     taste: Taste; tagPrefs: TagPrefs; range: DateRange | null; weekStart: string; weekEnd: string }): { saved: Event[]; picks: Event[]; rest: Event[] };
   export function facetCounts(events: readonly Event[], f: FilterState, ctx: FilterContext): { vibes: Record<VibeKey, number>; tags: [string, number][]; venues: [string, number][]; categories: string[] };
   export function dateBounds(events: readonly Event[]): { dateMin: string; dateMax: string };
   export function hasActiveFilters(f: FilterState): boolean;
   ```
4. **Unit tests** against the fixture. Cover every filter, plus these edge cases:
   - Untimed events are dropped once a time band is set.
   - Unscored events are never hidden by `minScore`.
   - The Evening band wraps past midnight.
   - Multi-day events match by overlap.
   - Picks: at most 9; each needs a score of 7 or more **and** a start inside the window.
   - Hidden events are excluded, and `keyOf` is honoured (test with two different key functions).
   - Tags that duplicate a vibe name are excluded from the tag facet.
5. **Rewire `context.tsx`.** Each `useMemo` becomes a one-line call that passes `keyOf: eventId`. The context's exposed shape and setters stay the same, so no component changes.
6. **After.** Rebuild and preview, run the script to `/tmp/parity-after.json`, then `diff <(jq -S . /tmp/parity-before.json) <(jq -S . /tmp/parity-after.json)`. Do this within the same hour as the baseline, because "upcoming" depends on the current time.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 and `filters.test.ts` counted |
| V2 | Behaviour parity | the diff in step 6 | no diff and no console errors |
| V3 | `context.tsx` shrank | `wc -l app/context.tsx` | well under 766 (report the number) |
| V4 | Core stays pure | the purity grep from 1.3 | nothing |
| V5 | HTML unchanged | fingerprint diff against a step 2 baseline | no diff |
| V6 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch.
