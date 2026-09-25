# Sub-phase 0.1: Byron time zone, DST-aware parsing, and Byron in the weekly run (PR 0)

> **Handoff: paste into a fresh Claude Code session**
>
> Execute sub-phase 0.1 (PR 0, Byron fix) of the eventyr plan. Read `docs/monorepo/PLAN.md` (D5 and D12) and
> `docs/monorepo/phase-0.01-byron-timezone.md`, and no other phase files.
>
> Create branch `fix/byron-timezone` **from `origin/claude/eventyr-monorepo-plan-i5jfvc`** (`git fetch origin claude/eventyr-monorepo-plan-i5jfvc main && git checkout -b fix/byron-timezone origin/claude/eventyr-monorepo-plan-i5jfvc && git merge origin/main`). That way this PR also lands `docs/monorepo/` on `main` for every later session. Use that branch even if your environment suggests
> another. If you can't push to it, stop and ask.
>
> This is a bug fix on the current single-package layout. **Don't** start any monorepo work. Follow the
> ordered steps and run every verification. Open a PR titled "Fix Byron time zone (NSW DST) and add Byron to
> the weekly digest", and put the verification results in its description.
>
> If a check fails and the fix isn't obvious and in scope, stop and report. Don't merge.

## Goal

Byron Bay is in NSW (`Australia/Sydney`, AEST +10 / AEDT +11). Daylight saving starts on
**2026-10-04** and ends on 2027-04-04. Two things are wrong today:

- `sources/byron.yml:23` says `timezone: Australia/Brisbane`.
- `src/adapters/dates.ts:23` hard-codes `BRISBANE_UTC_OFFSET_HOURS = 10`, which it hands to chrono as a fixed offset.

The result is that every scraped Byron time during DST is published an hour off, which also affects
iCal, RSS and the `/ai` feed. This PR:

- makes time-zone handling per-city and DST-aware
- leaves the Queensland cities (no DST) byte-identical
- adds Byron to `weekly.yml`

## Preconditions

- `main` is green.
- No `digest` run is in progress.

## Files affected

**Config:** `sources/byron.yml`.

**New:** `src/tz.ts` (+ test). This is a small `Intl`-based helper. Sub-phase 1.5 later moves it to `@dothingslol/utils/tz`.

**Core parsing:** `src/adapters/dates.ts` (+ test).

**Every other hard-coded `+10` site.** Inventory them first:

```bash
grep -rnE "BRISBANE_UTC_OFFSET_HOURS|\+10:00|\"\+10\"|UTC\+10|OFFSET_MS|TIMEZONE =" src app --include=*.ts --include=*.tsx | grep -v test
```

There were 11 hits at planning time. The likely sites are:
- `normalise.ts` (`humanDatetime`, `withinWindow`, `isPast`)
- `candidate.ts`
- `enrichTimes.ts`
- `shared.ts` `isoWithOffset` callers
- `ical.ts` (`TZID`)
- `ai.ts` (offsets in the compact feed)
- `rss.ts`

**Plumbing:** whichever call sites need the city's `timezone` passed down. It comes from `loadCityConfig` (`CityConfig.timezone`).

**Workflow:** `.github/workflows/weekly.yml`.

**Docs:** `CLAUDE.md`, one line under "Source files".

## Steps

1. **Baseline.**
   - Create an `origin/main` worktree at `/tmp/main-wt` and install it.
   - In both trees, run the deterministic publish stages for all four cities:
     ```bash
     for c in brisbane goldcoast sunnycoast byron; do CITY=$c TZ=Australia/Brisbane pnpm geocode; CITY=$c pnpm ical; done
     TZ=Australia/Brisbane pnpm markdown; pnpm rss; pnpm pages; pnpm build-ai
     ```
   - Record `pnpm test` counts.
2. **`src/tz.ts`.** Add `zonedOffsetMinutes(timeZone: string, at: Date): number`, using `Intl.DateTimeFormat` with `timeZoneName: "longOffset"`, or by comparing formatted parts.
   - Tests:
     - Brisbane is +600 on any date.
     - Sydney is +600 on 2026-10-03 and +660 on 2026-10-05.
     - Sydney changes exactly at 2026-10-04 16:00Z and 2027-04-03 16:00Z.
3. **`dates.ts`.** Parsing takes a `timeZone` (IANA). The zone's standard offset seeds chrono's reference, and each parsed instant is then corrected with `zonedOffsetMinutes(timeZone, instant)`, so local wall-clock text maps to the right UTC instant.
   - **Skipped hour.** 2026-10-04 02:30 doesn't exist in Sydney. Return `null` rather than guess (CLAUDE.md "Prefer null over a guess"), and count it as a rejection with a named reason.
   - **Repeated hour.** 2027-04-04 02:30 happens twice. Take the first (daylight) occurrence, and document that in a comment.
   - Keep the existing comment explaining why chrono can't take IANA names, and extend it.
   - With `timeZone: "Australia/Brisbane"`, behaviour must be **byte-identical** to the fixed +10 path. Add a test that runs the existing date test suite under both.
4. **Every other `+10` site.** Pass `city.timezone` down and replace fixed offsets with `zonedOffsetMinutes`, or with `isoWithOffset(…, timeZone)` where one already exists.
   - The `.ics` files must declare the city's `TZID` with correct `VTIMEZONE` rules. Check whether `ical.ts` emits `VTIMEZONE` or relies on `TZID` alone, and say which in the PR.
   - Remove `BRISBANE_UTC_OFFSET_HOURS` once nothing uses it.
5. **Fix the config.** Set `sources/byron.yml` to `timezone: Australia/Sydney`. In **all four** `sources/*.yml`, write `currency: AUD` (and `locale` if `loadCityConfig` defaults it) explicitly, so the city config states what the code assumed. The values match today's defaults, so nothing changes. 1.11 makes `extract.ts` read `currency` instead of its hard-coded AUD (owner decision in `config-inventory.md`). Don't add a fixed `timezone_offset` field: the offset comes from `timezone` per date (PLAN §11).
5b. **Byron in the source-maintenance maps.** `CITY_NAMES` (`src/adapters/discover.ts:69`) and `CITY_TERMS` (`src/adapters/probe.ts:465`) have no `byron` entry, so discovery and probing fall back to the bare key `"byron"`. Add `byron: "Byron Bay"` and Byron's locality terms (for example Byron Bay, Byron Shire, Mullumbimby, Bangalow, Suffolk Park; check `sources/byron.yml` for the localities its sources actually use). These maps are used by `discover-sources`/`probe-sources` only, not the weekly digest, so this has no effect on published output.
6. **Add Byron to the weekly run.** In `weekly.yml`, add after `sunnycoast`:
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
   - Check that `sources/byron.yml` has a `centre` and sources in each tier.
   - `digest.yml` keeps `TZ=Australia/Brisbane`, so week boundaries for Byron are computed in Brisbane time. That's up to an hour off at midnight during DST, which is harmless for weekly windows. PLAN §12 lists it as a follow-up.
7. **Docs.** In `CLAUDE.md` "Source files", add: `timezone` must be the city's real IANA zone, because parsing and all output offsets use it, and DST applies.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0. Test count equals the baseline plus the new tz and date tests |
| V2 | Queensland unchanged | Rerun step 1's stages on the branch and `diff -r` against `/tmp/main-wt` for `data/{brisbane,goldcoast,sunnycoast}.json`, `public/{brisbane,goldcoast,sunnycoast}.ics`, `public/{brisbane,gold-coast,sunshine-coast}/**`, `public/ai/{brisbane,gold-coast,sunshine-coast}/**` and the three `.md` files | identical |
| V3 | Byron changes are exactly the DST shift | Same diff for Byron | Only events dated on or after 2026-10-04 differ, each by exactly one hour in offset or `TZID`. Paste a before/after sample of 3 events in the PR |
| V4 | Date edge cases | the new tests | the skipped hour gives `null` plus a named rejection; the repeated hour gives the first occurrence |
| V5 | Scrape a real Byron page | `CITY=byron pnpm test-adapter <a byron scraper listing URL from sources/byron.yml>` (needs network, and `GOOGLE_API_KEY` only if it falls back to the LLM) | printed times match the source page's local times for post-4-Oct events |
| V6 | Workflow syntax | `actionlint .github/workflows/*.yml` | clean |
| V7 | Site builds | `TZ=Australia/Brisbane pnpm build` | exit 0 |

**After merge** (inside PLAN §4.4's window):

1. `Deploy to GitHub Pages` is green.
2. Dispatch `digest.yml` for `byron` with `force=true`. Byron's data is stale, so this does a full, paid collection; PLAN D5 approves it. The run must be green.
3. Spot-check three Byron events after 4 Oct on `/byron/` against their source pages. The web still shows the city-local string until PR 2's device-time change, so they should read in AEDT.
4. The following Saturday at 20:00 UTC, `weekly.yml` runs four jobs, and all four must be green.

## Rollback

Revert the squash commit. Byron's data then goes back to +10 on the next run, and Byron's weekly
job disappears with the revert.
