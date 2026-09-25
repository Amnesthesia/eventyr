# Sub-phase 2.5 — Native display: list, cards, detail, like, share, calendar, theme

> **Handoff — paste into a fresh Claude Code session**
>
> Execute sub-phase 2.5 (native display) of PR 2, the eventyr React Native app.
>
> - Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-2.5-native-display.md`, and no other phase files.
> - Work on branch `native/app`, even if your environment suggests another. If you can't push to it, stop and ask.
> - Sync first per PLAN §4.3.
> - Follow the ordered steps and run every verification.
> - Post the results as a comment on the PR 2 draft and tick 2.5.
> - List the device-check items as pending for a human. Don't claim them.
> - If a check fails and the fix isn't obvious and in scope, stop and report.
> - Push. Don't merge, and don't start 2.6.

## Goal

Build the browsing experience of the website, without filters:

- sections and grouping
- the full event card
- an event detail screen at the same URL shape as the web
- like (saved), persisted and keyed by `eventHash` (D6)
- share, maps, add to calendar
- theme that follows the system (the explicit setting lands in 2.8)

Tick the §5 checklist items in the PR comment.

## Preconditions

- 2.4 is committed on the branch, and its device check has passed.

## Files affected

New or edited:
- `apps/native/app/[city]/index.tsx`
- `apps/native/app/[city]/e/[event].tsx` (new)
- `apps/native/app/_layout.tsx`
- `apps/native/src/components/{EventCard,SectionHeader,CategoryIcon,CostLabel,ScoreBadge,VibeChips,TagChips,AddToCalendarButton,ShareButton}.tsx`
- `apps/native/src/state/{liked.ts,theme.ts}`
- `apps/native/src/theme/tokens.ts`
- `apps/native/src/platform/{calendar.ts,share.ts}`

Dependencies, installed with `expo install`:
- `@shopify/flash-list`
- `expo-image`
- `expo-calendar`
- `expo-sharing`
- `expo-haptics`
- `react-native-svg`
- `lucide-react-native`

## Steps

1. **Theme.**
   - Port the colour tokens from `apps/web/app/styles.css` (the CSS variables and the `data-cat`/`data-vibe` colours) into light and dark sets in `tokens.ts`.
   - `state/theme.ts` reads `system | light | dark` from the web's `theme` key name through `kv.ts`. It resolves with `useColorScheme()`.
   - Only the stored value is read here. The setting UI comes in 2.8.
2. **Liked store: `state/liked.ts`.**
   - A set of `eventHash` values stored under `STORAGE_KEYS.starred`. Native starts fresh, so the key name matches the web but the values are hashes.
   - Expose it through a `useSyncExternalStore` hook.
   - Keep the pure set operations in a tested `.ts` module.
   - Taste signals are wired in 2.7. For now, leave one clearly named call site (`onLiked`/`onUnliked`) where 2.7 connects them.
3. **Sections and grouping.**
   - Use `splitSections` with `keyOf: eventHash`. The sections are Saved, Picks (at most 9), then All.
   - Use core grouping for Date / Category / None. Date is the default, and a segmented control switches between them.
   - Render with `FlashList` and sticky headers.
   - Use labels from core, not restated strings.
4. **`EventCard`.** Match `apps/web/app/components/EventCard.tsx` field by field:
   - category chip and icon (map the lucide names from `CategoryIcon.tsx` to `lucide-react-native`)
   - `costLabel`, with free highlighted
   - title linking to the event
   - `formatWhen` in the device zone, including "On now — until …"
   - `venue_name` and address
   - maps link (`Linking.openURL(location_url)`)
   - description that expands past 240 characters
   - score badge
   - vibe chips
   - up to 5 tag chips, tinted by effective taste weight
   - past styling
   - ✦ on top picks (`isTopPick`)

   Actions: like (+), share, add to calendar. Not interested arrives in 2.7. Taps on venue, vibe and tag get a visible affordance with no behaviour until 2.6. Don't fake it.
5. **Detail screen `app/[city]/e/[event].tsx`.**
   - Params: city **slug** and `eventSlug`, the same as the web's `/{slug}/e/{eventSlug}/`.
   - Resolve the event from the cached feed via `FeedEvent.slug`.
   - An unknown event shows "This event is no longer listed" and links to the web page. Never show a blank screen.
   - Contents:
     - title, with breadcrumbs as the back title
     - `expo-image`, hidden on error
     - When (device time) / Where (maps) / Cost / Source
     - description
     - vibes
     - "Event website"
     - add to calendar
     - share
6. **Share (`platform/share.ts`).** `Share.share({ url })` using core's absolute event URL.
7. **Calendar (`platform/calendar.ts`).**
   - Primary: insert into the device calendar via `expo-calendar`, asking permission on first use.
   - Secondary menu:
     - the Google Calendar link
     - "Open in Apple Calendar" via the absolute `.ics` URL (prepend `SITE_URL` in core if the Apple link is still relative)
     - "Share .ics": core `buildEventIcs` written to a cache file, then `expo-sharing`
   - Duration rules come from core. Don't reimplement them.
8. **Deep links.** `dothings://brisbane/e/<eventSlug>` opens the detail screen.
9. **Accessibility.** Give icon buttons `accessibilityLabel`s that match the web's `aria-label`s, and give toggles `accessibilityState={{ selected }}`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Native CI | the five `native` job commands from 2.4 | exit 0 |
| V3 | No duplicated logic | `grep -rnE "function (formatWhen\|displayDatetime\|costLabel\|eventHash\|eventSlug\|isTopPick\|groupEvents\|rankByTaste)" apps/native/src` | nothing |
| V4 | Liked store tests | `pnpm --filter @dothingslol/native test` | add, remove, persist and reload all work |
| V5 | PR CI | `CI` | green |

**Device check (human, iOS and Android). Compare with the web on the same day:**
1. The Brisbane list sections and each grouping mode match the web.
2. Every field on one card matches the web.
3. Like an event, kill the app and relaunch. It's still liked and shows under Saved.
4. On the detail screen, share opens the sheet and the URL opens the web page.
5. Add to calendar produces the correct time. A date-only event becomes all-day.
6. `dothings://brisbane/e/<slug>` opens the detail screen.
7. Changing the system theme flips the app.
8. With VoiceOver or TalkBack on, the actions are announced.

## Rollback

Revert this sub-phase's commits on the branch.
