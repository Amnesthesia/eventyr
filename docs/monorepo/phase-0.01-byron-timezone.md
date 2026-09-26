# Sub-phase 0.1: City time zone comes only from `sources/{city}.yml` (fixes Byron DST); Byron joins the weekly run (PR 0)

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 0.1 (PR 0, city time zones) of the eventyr plan. Read `docs/monorepo/PLAN.md` (D5, D12, D18)
> and `docs/monorepo/phase-0.01-byron-timezone.md`, and no other phase files.
>
> Create branch `fix/byron-timezone` from the planning branch, so this PR also lands `docs/monorepo/` on `main`:
> ```bash
> git fetch origin claude/eventyr-monorepo-plan-i5jfvc main
> git checkout -b fix/byron-timezone origin/claude/eventyr-monorepo-plan-i5jfvc
> git merge origin/main
> ```
> Use that branch even if your environment suggests another. If you can't push to it, stop and ask.
>
> This is a fix on the current single-package layout. **Don't** start any monorepo work. Follow the steps in order,
> one commit per step, and run every verification. Open a PR titled "City time zones from config only; fix Byron DST;
> add Byron to the weekly digest", with the verification results in its description.
>
> If a check fails and the fix isn't obvious and in scope, stop and report. Don't merge.

## Goal

**Rule after this PR:** a city's time zone is stated in exactly one place, `timezone:` (IANA) in
`sources/{city}.yml`. Nothing else hard-codes a zone or an offset:

- no fallback strings
- no default parameters
- no `+10:00` literals
- no `TZ=` pins in workflows

Every offset is derived per date from the city's `timezone`, so DST is handled correctly.

Why now: Byron Bay is in NSW (`Australia/Sydney`), which is +10 normally and +11 from 2026-10-04 to
2027-04-04. It's configured as `Australia/Brisbane`, and the code also assumes +10 in several places
regardless of config, so every Byron time during DST is published an hour off.

This PR also:

- writes `currency: AUD` explicitly in every city file (D18; values unchanged)
- adds Byron to `weekly.yml`
- adds Byron to `CITY_NAMES`/`CITY_TERMS`

Queensland cities must come out **byte-identical**.

## Preconditions

- `main` is green.
- No `digest` run is in progress.

## Inventory: every site this PR removes

This list was found at planning time with
`grep -rn "Australia/Brisbane\|BRISBANE_UTC_OFFSET\|+10:00" src app workers .github astro.config.mjs`.
Re-run it before starting. Comments that only use a zone as an *example* may stay. Code may not.

| Site | Today | After |
|---|---|---|
| `src/adapters/dates.ts:23-30,97` | `BRISBANE_UTC_OFFSET_HOURS = 10` fixed offset, used for chrono and for ISO output | Required `timeZone` parameter, DST-aware (step 3) |
| `src/adapters/normalise.ts:13-16` | `OFFSET_MS` from the constant | Offset derived per date from the city `timezone` |
| `src/rss.ts:66` | `new Date(\`${iso}+10:00\`)` | Parsed with the city's zone |
| `src/shared.ts:959` | `isoWithOffset(…, timeZone = "Australia/Brisbane")` | `timeZone` required |
| `src/ai.ts:322`, `src/curate.ts:62` | `?? "Australia/Brisbane"` fallback | None. The city config is validated to have a `timezone` (step 1) |
| `src/add_city.ts:57` | Skeleton writes `timezone: "Australia/Brisbane"` | Writes the zone passed in (step 8) |
| `src/layouts/Base.astro:122`, `src/pages/[city]/e/[event].astro:83` | `cityData.timezone ?? "Australia/Brisbane"` | `cityData.timezone`. The payload always carries it, and the type makes it required |
| `app/utils/ics.ts:114,137`, `app/utils/calendarLinks.ts:65,85` | Default parameter `"Australia/Brisbane"` | Required parameter; callers pass the city's `timezone` |
| `src/common.ts` `getWeekRange`/`toISODate`/`fmtDate` (comment at :347) | Use the **host's** local time, which is why the workflows pin `TZ` | Take the city's `timeZone` explicitly (step 5) |
| `src/pages/[city]/[timeframe].astro:27` | Build-time "today" from the host clock under `TZ` | "Today" computed in each city's own zone (step 5) |
| `.github/workflows/{digest,deploy,reprobe}.yml` | `TZ: Australia/Brisbane` | Removed once V3 proves host-independence (step 6) |

The prose in `src/ai.ts:489` (llms.txt: "Sunday 06:00 Australia/Brisbane") describes the schedule and
isn't used in any calculation. Leave it, or reword it to "Sunday 06:00 AEST" while you're in the file.

## Steps

1. **Make `timezone` required and validated.**
   - `loadCityConfig` (`src/common.ts`) throws if `timezone` is missing or isn't a valid IANA zone (check with `Intl.DateTimeFormat(undefined, { timeZone })`). The error must name the file.
   - This generalises the check that `ical.ts:146` already does.
   - In the same commit, add `currency: AUD` to all four `sources/*.yml`. If the loader defaults `locale`, write that explicitly too. The values match today's defaults.
2. **Add `src/tz.ts`** with `zonedOffsetMinutes(timeZone, at: Date)` and `zonedDate(timeZone, at: Date)` (the calendar date in that zone), both built on `Intl`.
   - Tests:
     - Brisbane is +600 all year.
     - Sydney is +600 on 2026-10-03 and +660 on 2026-10-05.
     - Sydney's offset changes at 2026-10-04 16:00Z and 2027-04-03 16:00Z.
     - `zonedDate` returns the right date around midnight in each zone.
   - Sub-phase 1.5 later moves this file to `@dothingslol/utils/tz`.
3. **DST-aware parsing in `dates.ts`.**
   - Seed chrono with the zone's offset for the date being parsed, then correct the result with `zonedOffsetMinutes(timeZone, instant)`.
   - **Skipped hour:** 02:00–02:59 on 2026-10-04 in Sydney doesn't exist. Return `null` with a named rejection ("Prefer null over a guess").
   - **Repeated hour:** 02:00–02:59 on 2027-04-04 happens twice. Take the first (daylight) occurrence, and document why.
   - ISO output uses the correct offset for each instant.
   - Keep the existing comment explaining why chrono can't take IANA names, and extend it.
   - With `Australia/Brisbane`, output must be byte-identical to today. Run the existing date tests on both the old and the new path before deleting `BRISBANE_UTC_OFFSET_HOURS`.
4. **Thread the zone through every inventory site.**
   - The pipeline gets it from `loadCityConfig`.
   - The web gets it from the payload (`cityData.timezone`).
   - Make the web's `timezone` parameters required. TypeScript will then find every caller.
5. **Stop depending on the host clock's zone.**
   - `getWeekRange(now, timeZone)`, `toISODate(date, timeZone)` and `fmtDate(…, timeZone)` compute calendar dates in the given zone via `zonedDate`, not `Date#getDate()` and friends.
   - `[timeframe].astro` computes today, tomorrow and this-weekend per city, in that city's zone.
   - Grep for remaining host-local date use in `src/` and `app/` that feeds output: `getDate(`, `getDay(`, `getHours(`, `setHours(`, `toLocaleDateString(` without `timeZone`, and `new Date(y, m, d)`. For each hit, either pass the zone or explain in the PR why it doesn't feed output.
   - Browser code that deliberately uses the *device* zone is PR 2's concern (D7).
6. **Remove the `TZ` pins** from `digest.yml`, `deploy.yml` and `reprobe.yml`, **but only after V3 passes**.
   - Update or remove the comments that explain the pins.
   - In `CLAUDE.md` "Running locally", drop `export TZ=…`.
7. **City maps.** Add `byron` to:
   - `CITY_NAMES` (`src/adapters/discover.ts:69`) as "Byron Bay"
   - `CITY_TERMS` (`src/adapters/probe.ts:465`) as Byron Bay, Byron Shire, Mullumbimby, Bangalow and Suffolk Park, plus whatever localities `sources/byron.yml` actually uses

   Only the source-maintenance tools use these maps. Sub-phase 1.11 later derives them from `name` and `terms` in the YAML.
8. **`add-city`.** Add a required `timezone` input (IANA) to `add-city.yml` and to `add_city.ts` (`CITY_TIMEZONE` env).
   - Validate it the same way as in step 1.
   - Write it into the skeleton YAML together with `currency`.
   - Remove the Brisbane literal.
9. **Config and schedule.**
   - Set `sources/byron.yml` to `timezone: Australia/Sydney`.
   - Add Byron to `weekly.yml` after `sunnycoast`:
     ```yaml
     byron:
       needs: sunnycoast
       uses: ./.github/workflows/digest.yml
       permissions:
         contents: write
       with:
         city: byron
         force: ${{ inputs.force || false }}
         providers: ${{ inputs.providers || 'google,perplexity' }}
       secrets: inherit
     ```
10. **Docs.**
    - Add this rule to `CLAUDE.md` "Source files": *`timezone` (IANA) is required and is the only place a city's zone is stated. Offsets are derived per date. Never hard-code a zone or an offset, and never rely on the host `TZ`.*
    - Remove the "pins `TZ=Australia/Brisbane`" explanations in the pipeline section.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0; test count = baseline plus the new tz and date tests |
| V2 | No hard-coded zones | `grep -rnE "Australia/Brisbane\|BRISBANE_UTC_OFFSET\|\+10:00\|TZ: " src app workers .github --include=*.ts --include=*.tsx --include=*.astro --include=*.yml \| grep -v "\.test\."` | Only prose or example comments remain, each one listed and justified in the PR |
| V3 | **Host-independence** | Run the test suite plus the deterministic publish stages (`geocode`, `ical`, `markdown`, `rss`, `pages`, `build-ai` for all four cities, then `pnpm build`) three times: under `TZ=UTC`, `TZ=Australia/Brisbane` and `TZ=America/Los_Angeles`. Diff the three output trees: `data/*.json`, `public/**`, `*.md`, and `dist/` (via `find dist -type f -exec sha256sum {} +`) | identical across all three |
| V4 | Queensland unchanged | Run the same stages in an `origin/main` worktree (which still pins `TZ=Australia/Brisbane`) and diff against this branch for brisbane, goldcoast and sunnycoast | identical |
| V5 | Byron changes are only the DST shift | The same diff for Byron | Only events on or after 2026-10-04 differ, each by one hour of offset or the correct `TZID` rules. Paste 3 before/after samples |
| V6 | DST edges | The new tests | skipped hour → `null` plus a named rejection; repeated hour → first occurrence |
| V7 | Config validation | Temporarily delete `timezone` from `sources/goldcoast.yml`, then run `CITY=goldcoast pnpm markdown` | Fails and names the file. Revert afterwards |
| V8 | Real Byron page | `CITY=byron pnpm test-adapter <a byron listing URL from sources/byron.yml>` | Times after 4 Oct match the source page |
| V9 | add-city | In a scratch worktree, run `CITY_NAME=Scratch CITY_KEY=scratch CITY_TIMEZONE=Australia/Perth pnpm add-city`, inspect the YAML and `digest.yml`, then discard | Skeleton has `timezone: Australia/Perth` and `currency`, and the option was added |
| V10 | Workflow syntax | `actionlint .github/workflows/*.yml` | clean |

**After merge** (inside the PLAN §4.4 window):

1. `Deploy to GitHub Pages` goes green, now with no `TZ` pin. `/brisbane/today/` shows today's Brisbane date even though the runner is on UTC.
2. Dispatch `digest.yml` for `byron` with `force=true`. Byron's data is stale, so this is a full paid collection; D5 approves that. It must go green.
3. Check three Byron events after 4 Oct against their source pages. They should read in AEDT, because the web shows the city-local string until PR 2's device-time change.
4. Dispatch `digest.yml` for `brisbane` with `force=false`. It must go green, with published output matching its last run.
5. On the following Saturday at 20:00 UTC, `weekly.yml` runs four jobs, and all four must go green.

## Rollback

Revert the squash commit. That restores the `TZ` pins and the +10 assumptions together, and removes
Byron's weekly job.
