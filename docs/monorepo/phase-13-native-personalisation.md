# Phase 13 — Native personalisation, swipe mode, saved calendar

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 13 (native personalisation) of the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-13-native-personalisation.md`, and no other
> phase files. Create branch `monorepo/phase-13-native-personalisation` from the latest `main`.
> Follow the ordered steps, run every verification command, and paste the results into the PR
> description. List the device-check items as pending for a human; don't claim them. This phase
> is large. Each numbered step is one commit, and if context gets tight, stop after a completed
> step, push, and report where you stopped. If a check fails and the fix isn't obvious and in
> scope, stop and report. Open a PR. Don't merge it, and don't start phase 14.

## Goal

Deliver everything in PLAN §5 under "Personalisation and saved" that phases 11 and 12 didn't
already cover:

- the inferred taste profile, including dislikes
- the stated tag preferences pane
- "not interested" and "Unhide N hidden"
- the long-press action sheet
- swipe mode
- the saved-events week calendar
- `#cal=` share links and QR
- ICS export of saved events

The ranking maths all comes from core (`taste`, `tagPrefs`, `tagSpecificity`, `weekLayout`,
`savedLink`, `ics`). This phase is persistence, gestures and UI.

## Preconditions

- Phase 12 is merged.

## Files affected

**Stores**
- `apps/native/src/state/{taste.ts,tagPrefs.ts}`. These mirror `apps/web/app/utils/{tasteStore,tagPrefsStore}.ts` and use the same key names from `STORAGE_KEYS`.

**Screens and components**
- `apps/native/app/[city]/swipe.tsx`
- `apps/native/app/[city]/saved.tsx`
- `apps/native/app/preferences.tsx`
- `apps/native/src/components/{CardActionSheet,SwipeDeck,WeekGrid,SavedQr,UnhideRow}.tsx`

**New dependencies (via `expo install`)**
- `react-native-gesture-handler` and `react-native-reanimated`, if the template doesn't already include them
- `qrcode-generator`, which is pure JS and already used by the web. Add it to the catalog.

## Steps

1. **Taste store.** Signals follow the web exactly. Read `apps/web/app/utils/tasteStore.ts` and core's `taste.ts`.
   - Save: +1.
   - Unsave: −1.
   - Share or calendar add: +1, once per event per signal. Dedupe on `STORAGE_KEYS.tasteNoted` using `share:{hash}` / `calendar:{hash}`.
   - Dislike: `bumpDislike`. It weights tags by IDF from `tagSpecificity` and unsaves the event first if it was saved.
   - Unhide: reverses exactly the weight that the dislike added.
   - `rankByTaste` orders Picks and the rest.
   - Now wire phase 11's share and calendar call sites to these signals.
2. **Tag preferences pane (`app/preferences.tsx`).**
   - Show the top 150 tags. Tapping one cycles none → more → less.
   - Include a "Clear N preferences" action.
   - More/less tiers affect sorting through core's `prefTier`, and chips tint by preference, as on the web.
3. **Not interested + action sheet.**
   - Add a "−" button on the card.
   - Long press (500 ms, with `expo-haptics` feedback) opens `CardActionSheet` with: Pin/Remove pin, Not interested, calendar options, Share, Cancel. Use `ActionSheetIOS` on iOS and a bottom sheet or modal on Android.
   - The web labels the save action "Pin to Top Picks" in the sheet, but it actually stars the event. Use "Save" / "Remove from saved" in native, and note the web's label bug in the PR as a follow-up. Don't copy it.
   - Put "Unhide N hidden" at the bottom of the Filters modal.
4. **Swipe mode (`app/[city]/swipe.tsx`).**
   - The deck is `applyFilters(...)` minus saved events, ordered by `rankByTaste`.
   - Swiping past 90 px decides: right saves, left dislikes.
   - Buttons: skip, undo, save.
   - Show progress, a date line, category and vibe chips, and an end screen with counts.
   - Use gesture-handler with reanimated, and keep the decision thresholds identical to `apps/web/app/components/SwipeMode.tsx`.
   - The web's undo keys are web-only. The native equivalent is the undo button.
5. **Saved week calendar (`app/[city]/saved.tsx`).**
   - A Mon–Sun grid with previous/next week, laid out with core's `weekLayout`. Its percentage and slot outputs become absolute-positioned `View`s.
   - All-day and multi-day events render as bars. Timed events are placed by hour.
   - Tapping an item opens its detail screen.
6. **Share saved (`#cal=`).**
   - Build the link with core's `savedLink`: `https://www.dothings.lol/{slug}/#cal=<hash>.<hash>…`. The website opens it today.
   - For QR, feed `qrcode-generator`'s module matrix into `react-native-svg` rects. Keep the same limit of 60 events or fewer.
   - Receiving a link: add `app/+native-intent.tsx`. It rewrites `https://www.dothings.lol/{slug}/#cal=…` and `dothings://{slug}#cal=…` to `/{slug}/saved?shared=<hashes>`. **Verify fragment handling.** Whether expo-router passes URL fragments through deep links is unconfirmed, and `+native-intent` exists because incoming URLs don't always map onto routes. The saved screen then shows the shared events with "Save all (N)".
7. **Export saved events as ICS.** Build with core `buildIcs`, write the result to a cache file, and share it with `expo-sharing` as `saved-{cityKey}.ics`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Native CI | phase 10's five `native` commands | exit 0 |
| V3 | Taste parity | New test: replay one signal sequence (3 saves, 1 unsave, 1 share, 1 dislike, 1 unhide) through the native store and through the web `tasteStore` with a fake `localStorage`. The resulting `eventyr:taste` objects must be deep-equal. | passes |
| V4 | Saved link interop | A test encodes a link in native and decodes it with core `savedLink`, then the reverse, using a link generated by the website. | round-trips |
| V5 | No duplicated maths | `grep -rnE "function (rankByTaste\|bumpTaste\|bumpDislike\|tasteBoost\|layoutWeek\|encodeSaved\|buildIcs)" apps/native/src` | no output |
| V6 | PR CI | `CI` | green |

**Device check (human):**
1. Save three events that share a tag. Picks reorder. Compare with the web after doing the same there.
2. Mark one "not interested". It disappears and "Unhide 1" appears. Unhiding restores both the event and the ranking.
3. Swipe mode: right saves, left hides, undo restores, and the end screen counts are correct.
4. Saved calendar: a multi-day event spans days, and a timed event sits at the right hour.
5. Scan the saved QR with another phone's camera. The website opens with those events. Open a web-generated `#cal=` link on the phone: the app (or the site, before phase 15) shows "Save all".
6. Export .ics, import it into the device calendar, and check the events and times.
7. Long-press a card: you feel the haptic and the action sheet works.

## Rollback

Revert the squash merge. Taste data written under the web-compatible key names stays valid for
earlier builds, which ignore it.
