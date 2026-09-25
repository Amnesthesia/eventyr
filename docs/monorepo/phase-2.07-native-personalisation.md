# Sub-phase 2.7: Native personalisation, swipe mode and saved calendar

> **Handoff: paste into a fresh Claude Code session**
>
> Execute sub-phase 2.7 (native personalisation) of PR 2, the eventyr React Native app.
>
> - Read `docs/monorepo/PLAN.md` (especially §7) and `docs/monorepo/phase-2.07-native-personalisation.md`. Don't read any other phase files.
> - Work on branch `native/app`, even if your environment suggests a different one. If you can't push to it, stop and ask.
> - Sync first, as described in PLAN §4.3.
> - Each numbered step is one commit. If context gets tight, stop after a completed step, push, and report.
> - Run every verification. Post the results as a comment on the PR 2 draft, then tick 2.7.
> - List the device-check items as pending for a human. Don't claim them.
> - If a check fails and the fix isn't obvious and in scope, stop and report.
> - Push. Don't merge, and don't start 2.8.

## Goal

This sub-phase does two things:

1. Make likes, dislikes, shares and calendar adds feed **taste model v2** (PLAN §7.2) through core's `tasteProfile`, the same way the web does after 2.3.
2. Deliver the rest of "Personalisation and saved" in PLAN §5:
   - Not interested, and "Unhide N hidden"
   - the long-press action sheet
   - swipe mode
   - the saved week calendar
   - `#cal=` links and QR
   - ICS export

The Settings UI for taste is in 2.8.

## Preconditions

- 2.6 is committed on the branch.

## Files affected

- Store: `apps/native/src/state/tasteProfile.ts`. It wraps core `tasteProfile` over `kv.ts` under `STORAGE_KEYS.tasteProfile`. Native starts on v2 directly and needs no migration.
- New screens and components:
  - `apps/native/app/[city]/swipe.tsx`
  - `apps/native/app/[city]/saved.tsx`
  - `apps/native/app/+native-intent.tsx`
  - `apps/native/src/components/{CardActionSheet,SwipeDeck,WeekGrid,SavedQr,UnhideRow}.tsx`
- Dependencies, installed with `expo install`:
  - `react-native-gesture-handler` and `react-native-reanimated`, if the template doesn't already include them
  - `qrcode-generator`, which is pure JS and already used by the web (add it to the catalog)

## Steps

1. **Taste signals.** Connect the 2.5 call sites and add the new ones:

   | Action | Core call |
   |---|---|
   | like | `like` |
   | unlike | `unlike` |
   | share | `noteShare` |
   | calendar add | `noteCalendar` |
   | not interested | `dislike` (also hides; unlikes first if the event was liked) |
   | unhide | `undislike` |

   `autoLearn` is honoured inside core, so native adds no checks of its own. Picks and the rest order by core `rankByTaste`, and grouping applies the v2 tier (±3 overrides) through core `prefTier`.
2. **Not interested and the action sheet.**
   - Add a "−" button on the card.
   - Long press (500 ms, with `expo-haptics`) opens `CardActionSheet` with: Save/Remove from saved, Not interested, the calendar options, Share, Cancel. On iOS use `ActionSheetIOS`; on Android use a bottom sheet or modal.
   - Label the action "Save", not the web's mislabelled "Pin to Top Picks" (PLAN §11).
   - Put "Unhide N hidden" at the bottom of the Filters modal.
3. **Swipe mode (`app/[city]/swipe.tsx`).**
   - The deck is `applyFilters(...)` minus liked events, ordered by `rankByTaste`.
   - A swipe past 90 px decides: right likes, left dislikes.
   - Include skip, undo and like buttons, a progress indicator, the date line (device time), category and vibe chips, and an end screen with counts.
   - Keep the thresholds identical to `apps/web/app/components/SwipeMode.tsx`.
4. **Saved week calendar (`app/[city]/saved.tsx`).**
   - A Mon–Sun grid with previous and next week, laid out by core `weekLayout` using absolute-positioned `View`s.
   - All-day and multi-day events render as bars. Timed events are placed by hour, in device time.
   - Tapping an item opens its detail screen.
5. **Share saved (`#cal=`).**
   - Build the link with core `savedLink`: `https://www.dothings.lol/{slug}/#cal=<hash>.<hash>…`. The website opens it today.
   - Render the QR from the `qrcode-generator` matrix as `react-native-svg` rects. Keep the web's limit of 60 events or fewer.
   - `+native-intent.tsx` rewrites incoming `https://www.dothings.lol/{slug}/#cal=…` and `dothings://{slug}#cal=…` to `/{slug}/saved?shared=<hashes>`. The saved screen then offers "Save all (N)".
   - **Verify fragment handling.** It is unconfirmed whether expo-router passes URL fragments through to `+native-intent`. If it doesn't, record what arrives, and fall back to accepting a `?cal=` query form on the app side.
6. **ICS export.** Use core `buildIcs`, write the result to a cache file, then share it with `expo-sharing` as `saved-{cityKey}.ics`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Native CI | the five `native` commands from 2.4 | exit 0 |
| V3 | Taste parity with web | A test replays one signal sequence (3 likes, 1 unlike, 1 share, 1 dislike, 1 unhide) through the native store and through web's `tasteProfileStore` with a fake `localStorage` | resulting profiles are deep-equal |
| V4 | Auto-learn off | The same sequence with `autoLearn: false` | `learned` is unchanged; likes and hides are still recorded |
| V5 | Saved-link interop | Native encode → core decode, plus a web-generated link → native decode | round-trips |
| V6 | No duplicated maths | `grep -rnE "function (rankByTaste\|like\|dislike\|tasteBoost\|layoutWeek\|encodeSaved\|buildIcs)" apps/native/src` | no output |
| V7 | PR CI | `CI` | green |

**Device check (human):**
1. Like 3 events that share a tag. Picks reorder the same way as on the web after the same actions.
2. Mark an event not interested. It disappears and "Unhide 1" appears. Unhiding restores both the event and the ranking.
3. In swipe mode, right likes, left hides, undo restores, and the end screen counts are correct.
4. On the saved calendar, a multi-day event spans days and a timed event sits at the right hour.
5. The QR, scanned with another phone, opens those events on the website. A web-generated `#cal=` link opens the app's saved screen with "Save all", or is recorded as a fragment limitation per step 5.
6. The exported .ics imports correctly.
7. Long press gives haptic feedback and the action sheet works.

## Rollback

Revert this sub-phase's commits on the branch.
