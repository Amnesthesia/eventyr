# Phase 11 — Native display: list, cards, detail, save, share, calendar, theme

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 11 (native display) of the eventyr monorepo refactor. Read `docs/monorepo/PLAN.md`
> and `docs/monorepo/phase-11-native-display.md`, and no other phase files. Branch
> `monorepo/phase-11-native-display` from the latest `main`. Follow the ordered steps, run every
> verification command, and paste the results into the PR description. List the device-check
> items as pending for a human. Don't claim them. If a check fails and the fix is not obvious and
> in scope, stop and report. Open a PR, don't merge it, and don't start phase 12.

## Goal

Build the browsing experience of the website, without filters:

- sections and grouping
- the full event card
- an event detail screen at the same URL shape as the web
- save (persisted)
- share, maps, and add to calendar
- light and dark theme

Everything here is in the "List, sections and grouping", "Calendar and sharing" and
"Presentation" parts of the checklist in PLAN §5, plus save persistence and the event detail
page. Tick those items in the PR description.

## Preconditions

- Phase 10 is merged, and its device check passed.
- PLAN Q6 (event identity for storage) is answered. The default is `eventHash`.

## Files affected

- `apps/native/app/[city]/index.tsx`
- `apps/native/app/[city]/e/[event].tsx` (new)
- `apps/native/app/_layout.tsx`
- `apps/native/src/components/**`:
  - `EventCard`
  - `SectionHeader`
  - `CategoryIcon`
  - `CostLabel`
  - `ScoreBadge`
  - `VibeChips`
  - `TagChips`
  - `AddToCalendarButton`
  - `ShareButton`
- `apps/native/src/state/{saved.ts,theme.ts}`
- `apps/native/src/theme/tokens.ts`
- `apps/native/src/platform/{calendar.ts,share.ts}`

New dependencies. Install each through `expo install` so the versions match the SDK:

- `@shopify/flash-list`
- `expo-image`
- `expo-calendar`
- `expo-sharing`
- `expo-haptics`
- `react-native-svg`
- `lucide-react-native`

## Steps

1. **Theme.**
   - Port the colour tokens from `apps/web/app/styles.css` (CSS variables, and the `data-cat` / `data-vibe` colours) into `tokens.ts` as light and dark sets.
   - Theme preference is `system | light | dark`. It is persisted under the web's `theme` key name via `kv.ts`, and read through `useColorScheme()`.
2. **Saved store: `state/saved.ts`.**
   - Store a set of event keys under `STORAGE_KEYS.starred`, using the identity chosen in Q6.
   - Expose it through a tiny `useSyncExternalStore` hook, so any screen re-renders on change.
   - Put the pure set operations in core or a local `.ts` file with tests. The hook is a thin layer.
3. **Sections and grouping on the city screen.**
   - Split the data with `splitSections` from `@dothingslol/core/filters`, using `DEFAULT_FILTERS` until phase 12. The sections are Saved, then Picks (at most 9), then All.
   - Group with `@dothingslol/core/grouping`: Date / Category / None. The default is Date, and there is a segmented control for the other options.
   - Render with `FlashList` and sticky headers. Use the section and group labels core produces; don't restate them.
4. **`EventCard`.** Follow `apps/web/app/components/EventCard.tsx` field by field:
   - category chip and icon (map `CategoryIcon.tsx`'s lucide names to `lucide-react-native`)
   - cost label with free highlighted (`costLabel` from core)
   - title that opens `link`
   - `displayDatetime`, including "On now — until …"
   - `venue_name` plus address detail
   - maps link (`Linking.openURL(location_url)`)
   - description that expands past 240 characters
   - score badge
   - vibe chips
   - up to 5 tag chips
   - past-event styling
   - ✦ on top picks (`isTopPick`)

   Actions: save (+), share, and add to calendar. "Not interested" arrives in phase 13.

   Filter-toggling taps on the venue, vibe and tag are **no-ops** until phase 12. Leave a visible affordance but no behaviour, and don't fake it.
5. **Detail screen `app/[city]/e/[event].tsx`.**
   - The route params are the city **slug** and the `eventSlug`, the same as the web's `/{slug}/e/{eventSlug}/`. Resolve the event from the cached city feed via `FeedEvent.slug`.
   - If the event isn't in the current feed (an old link), show "This event is no longer listed", with a link to the web page. Never show a blank screen.
   - Content matches the web page: breadcrumbs (as the header back title), image via `expo-image` (hide it on error), When / Where (maps) / Cost / Source, description, vibe chips, "Event website", add to calendar, and share.
6. **Share: `platform/share.ts`.** Call `Share.share({ url: eventUrl(...) })`, using core's URL builder, which is absolute (`SITE_URL/{slug}/e/{eventSlug}/`). Before the phase 13 taste store exists, record the share signal as a no-op hook point, but don't drop the call site.
7. **Calendar: `platform/calendar.ts`.**
   - The primary action is "Add to calendar", which inserts into the device calendar via `expo-calendar`. It asks for permission at first use, and on denial falls back to the menu below.
   - The secondary menu has three options:
     - Google Calendar link (`calendarLinks`)
     - "Open in Apple Calendar" via the absolute `.ics` URL. Core's Apple link is relative; prepend `SITE_URL` in core if phase 02 didn't already.
     - "Share .ics", which writes the output of `core/ics` `buildEventIcs` to a cache file and passes it to `expo-sharing`
   - Keep the same duration rules as the web (a 2-hour default, all-day handling). The core functions already encode them. Don't reimplement them.
8. **Deep links (custom scheme).** Confirm that `dothings://brisbane/e/<eventSlug>` opens the detail screen. Universal links come in phase 15.
9. **Accessibility.** Every icon-only button gets an `accessibilityLabel` that matches the web's `aria-label` text. Toggles expose `accessibilityState={{ selected }}`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Native CI steps | the five `native` job commands from phase 10 | exit 0 |
| V3 | No duplicated logic | `grep -rnE "function (displayDatetime\|costLabel\|eventHash\|eventSlug\|isTopPick\|groupEvents\|rankByTaste)" apps/native/src` | no output: native imports these from core |
| V4 | Save store tests | `pnpm --filter @dothingslol/native test` | covers add, remove, persist and reload (with kv mocked in a pure module) |
| V5 | PR CI | `CI` | green |

**Device check (human, iOS and Android):**
1. Brisbane list: the sections appear. Switch grouping between Date, Category and None. Headers match the web for the same day, so compare side by side with `https://www.dothings.lol/brisbane/`.
2. Pick one card and compare every field to the same card on the web.
3. Save an event, kill the app, relaunch. It is still saved, and appears under Saved.
4. Open detail. Share opens the sheet with the correct URL, and the URL opens the web page.
5. Add to calendar inserts into the device calendar with the correct time. Also add a date-only event and check it becomes all-day.
6. `dothings://brisbane/e/<slug>` from Notes or Messages opens the detail screen.
7. Switch the system theme and toggle the in-app override.
8. Turn on VoiceOver or TalkBack and check that the card actions are announced with labels.

## Rollback

Revert the squash-merge. Only `apps/native` changes.
