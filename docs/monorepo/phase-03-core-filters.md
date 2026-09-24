# Phase 03: extract filtering and sectioning from `context.tsx` into core

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 03 (core filters) of the eventyr monorepo refactor. Read `docs/monorepo/PLAN.md`
> and `docs/monorepo/phase-03-core-filters.md`, and no other phase files. Create branch
> `monorepo/phase-03-core-filters` from the latest `main`. Follow the ordered steps, run every
> verification command, and paste the results into the PR description. If a check fails and the
> fix is not obvious and within this phase's scope, stop and report. Open a PR. Do not merge it
> and do not start phase 04.

## Goal

The filter predicate, the Saved/Picks/All split, the facet lists and counts, `dateMin`/`dateMax`
and `hasActiveFilters` currently live in `useMemo` bodies inside `app/context.tsx` (766 lines).
None of that logic has tests. This phase does two things:

1. It captures the current behaviour **from the outside** with a browser-driven parity script, so the evidence doesn't depend on the code being refactored.
2. It moves the logic into `packages/core/src/filters.ts` as pure functions with unit tests. `context.tsx` then holds only React state and calls into core.

Native will call the same functions.

## Preconditions

- Phase 02 is merged, so `eventId`, `search`, `grouping`, `timeOfDay`, `taste` and `dates` are in core.
- `playwright` is already a devDependency. A Chromium binary is available: in Claude Code cloud sessions it is preinstalled (`PLAYWRIGHT_BROWSERS_PATH`); locally, run `pnpm exec playwright install chromium`.

## Files affected

- New: `scripts/filter-parity.mjs` (a Playwright library script, kept for phases 04 and 09).
- New: `packages/core/src/filters.ts` and `packages/core/src/filters.test.ts`.
- New: `packages/core/src/fixtures/events.ts`, a small hand-built fixture of about 25 events that covers every filter edge case.
- Edited: `app/context.tsx`.

## Steps

1. **Write `scripts/filter-parity.mjs`.**
   - Given a base URL and an output path, it opens `/brisbane/` and runs a fixed script of 15 to 20 interactions:
     - each category chip
     - When: Today, Tomorrow, Weekend, and a custom range
     - each time-of-day band, and two bands together
     - Past: Include and Only
     - each score tier
     - one and then two vibes
     - one and then two tags, via the typeahead
     - a venue from the select
     - search terms `jazz`, `jaz` (typo), `café` vs `cafe`, and a two-token query
     - Clear all
   - After each interaction it records the "X of Y events match" text and the ordered list of card titles per section.
   - It writes the result as JSON.
   - It also records `console.error` messages and fails if any appear.
   - Selectors should use visible text and ARIA roles rather than CSS classes, so phase 09 (React 19) can reuse the script.
2. **Baseline.** On unmodified `main`, run `TZ=Australia/Brisbane pnpm build && pnpm preview &`, then `node scripts/filter-parity.mjs http://localhost:4321 /tmp/parity-before.json`. Commit the script on its own first.
3. **Extract into `filters.ts`.** Move the logic verbatim, turning closed-over state into parameters. Target API:
   ```ts
   export interface FilterState { category: string | null; when: WhenPreset | null; range: DateRange | null;
     timeBands: TimeBand[]; past: "upcoming" | "include" | "only"; minScore: number; vibes: VibeKey[];
     tags: string[]; venue: string | null; query: string; }
   export const DEFAULT_FILTERS: FilterState;
   export interface FilterContext { now: Date; weekStart: string; weekEnd: string; hidden: ReadonlySet<string>; }
   export function applyFilters(events: readonly Event[], f: FilterState, ctx: FilterContext): Event[];
   export function splitSections(filtered: readonly Event[], opts: { starred: ReadonlySet<string>; taste: Taste;
     tagPrefs: TagPrefs; range: DateRange | null; weekStart: string; weekEnd: string }): { saved: Event[]; picks: Event[]; rest: Event[] };
   export function facetCounts(events: readonly Event[], f: FilterState, ctx: FilterContext): { vibes: Record<VibeKey, number>; tags: [string, number][]; venues: [string, number][]; categories: string[] };
   export function dateBounds(events: readonly Event[]): { dateMin: string; dateMax: string };
   export function hasActiveFilters(f: FilterState): boolean;
   ```
   Adjust names and types to match what the code actually does. The goal is to change nothing, not to redesign. Where `context.tsx` reads `Date.now()` or `new Date()` inline, pass `now` in instead, so tests are deterministic.
4. **Unit tests** in `filters.test.ts` against the fixture. Cover at least one case per filter, plus these edge cases:
   - untimed events dropped once a time band is chosen
   - unscored events never hidden by `minScore`
   - an Evening band that wraps past midnight
   - overlap semantics for multi-day events
   - picks capped at 9, requiring a score of 7 or more **and** a start inside the window
   - hidden events excluded
   - tags that duplicate vibe names excluded from the tag facet
5. **Rewire `context.tsx`.** Its `useMemo`s become one-line calls into core. The state shape and setters exposed through the context stay unchanged, so no component changes.
6. **After.** Rebuild and preview, run `node scripts/filter-parity.mjs http://localhost:4321 /tmp/parity-after.json`, then `diff <(jq -S . /tmp/parity-before.json) <(jq -S . /tmp/parity-after.json)`. Do the before and after runs within the same hour, because the "upcoming" logic depends on the current time.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0, with the new `filters.test.ts` counted |
| V2 | Behaviour parity | the step 6 diff | no diff and no console errors |
| V3 | `context.tsx` shrank | `wc -l app/context.tsx` | noticeably below 766. Report the number |
| V4 | Core stays pure | the purity grep from phase 02 | no output |
| V5 | Site HTML unchanged | fingerprint diff against a baseline taken in step 2 | no diff. Prerendered HTML doesn't depend on client filtering, so any diff is a bug |
| V6 | PR CI | `CI` | green |

**After merge:** `Deploy to GitHub Pages` is green. Run `node scripts/filter-parity.mjs https://www.dothings.lol /tmp/parity-prod.json` and spot-check that it completes with no console errors.

## Rollback

Revert the squash-merge.
