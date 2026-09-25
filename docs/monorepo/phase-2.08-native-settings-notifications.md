# Sub-phase 2.8: Native Settings screen and local notifications

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 2.8 (native settings and notifications) of PR 2, the eventyr React Native app.
> Read `docs/monorepo/PLAN.md` (especially §6 and §7) and
> `docs/monorepo/phase-2.08-native-settings-notifications.md`, and no other phase files.
> Work on branch `native/app`, even if your environment suggests another. If you can't push to it,
> stop and ask. Sync first per PLAN §4.3. Follow the steps in order and run every verification.
> Post the results as a comment on the PR 2 draft and tick 2.8. List the device-check items as
> pending for a human rather than claiming them. If a check fails and the fix isn't obvious and is
> in scope, stop and report. Push, don't merge, and don't start 2.9.

## Goal

1. **Settings screen.** Build the spec in PLAN §7.3: notifications on/off with an explanation, the taste profile with +/− per tag, vibe and category, the auto-learn opt-out with the privacy note, theme (System, Light or Dark), and About.
2. **Local notifications only (D3, PLAN §6).**
   - A reminder 1 hour before each liked event. Date-only events get theirs at 08:00 on the day.
   - An 08:00 summary of today's liked events.
   - A permission prompt on the first like, or from the toggle.
   - A "Send test notification" button.
   - Tapping a notification opens the event, or the saved screen for the summary.

   There is no server, no push token and no background task.

## Preconditions

- 2.7 is committed on the branch.

## Files affected

- **Core:** `packages/core/src/reminders.ts` gains `planSchedule` and tests. `STORAGE_KEYS.notifications` exists from 2.3.
- **Native, new files:**
  - `apps/native/app/settings.tsx`, linked from a header gear on every city screen
  - `apps/native/src/notifications/{permissions.ts,reconcile.ts,handlers.ts}`
- **Native, edits:**
  - `apps/native/app/_layout.tsx`: handlers, and reconciling on launch and foreground
  - `apps/native/app.json`: the `expo-notifications` plugin
- **Dependency:** `expo-notifications`, installed with `expo install`.

## Steps

1. **Add `planSchedule` to core** (pure, with tests):
   ```ts
   export interface PlannedNotification { id: string; fireAt: string; title: string; body: string; url: string }
   export function planSchedule(liked: readonly Event[], now: Date, opts: { cap: number; days: 7 }): PlannedNotification[];
   ```
   - Reuse `calculate1hReminderTime`, `filterEventsForMorningDigest`, `formatMorningDigest` and `formatEventTime` rather than forking them. Times come from `formatWhen`, in the device time zone.
   - "08:00" means device-local 08:00. The web does the same.
   - Sort by `fireAt` and truncate to `cap`. Native passes **60**, because iOS keeps only the 64 soonest pending notifications (per Apple's forums).
   - IDs are deterministic: `reminder:{eventHash}` and `digest:{YYYY-MM-DD}`.
   - The summary is one **dated** notification per day for the next 7 days, each carrying that day's content.
   - Skip anything whose fire time is already past.
   - Tests to write:
     - A date-only event fires at 08:00.
     - The cap is respected.
     - A day with no liked events gets no summary.
     - An event starting within the hour gets no reminder in the past.
     - IDs are deterministic.
2. **Permissions (`permissions.ts`).**
   - Prompt on the first like, but only while `STORAGE_KEYS.notifications` isn't `"off"`.
   - Remember a denial and don't re-prompt. The settings screen explains the denial and links to OS settings.
   - Android 13+ needs the runtime `POST_NOTIFICATIONS` permission, which the module handles.
   - Use inexact scheduling and don't request `SCHEDULE_EXACT_ALARM`. Check how the date trigger behaves on Android 12+ and record the result.
3. **Reconcile (`reconcile.ts`).**
   - Runs on launch, when the app returns to the foreground, on every like or unlike, when the toggle changes, and on feed refresh.
   - Steps:
     1. Call `getAllScheduledNotificationsAsync()`.
     2. Keep only ours, identified by ID prefix.
     3. Plan the schedule.
     4. Cancel what's gone, and schedule what's new or changed.
   - When the toggle is off, cancel all of ours and schedule nothing.
   - Never touch notifications that aren't ours.
   - Log a single line: `planned N, scheduled +a −b, capped c`.
4. **Handlers (`handlers.ts`).**
   - Show a banner when a notification arrives in the foreground.
   - On tap, route `data.url` through expo-router.
   - If the event is no longer in the feed, show the 2.5 "no longer listed" state.
5. **Settings screen (`app/settings.tsx`).** Use the copy in PLAN §7.3 **verbatim**.
   - **Notifications**
     - Toggle and explanation.
     - Permission state, with "Open settings" when denied.
     - "Send test notification".
     - In dev builds only, a debug list of scheduled notifications.
   - **Your taste**
     - The privacy note at the top.
     - The "Learn from likes and dislikes" toggle (`setAutoLearn`).
     - A Tags section with search: the top 150 tags by frequency, taken from the current feed.
     - Vibes and Categories sections.
     - Each row shows:
       - a weight bar from −3 to +3, with the value as text
       - a "learned" or "set by you" badge
       - − and + buttons that call `setOverride(effective ± 1)`
       - reset, which calls `clearOverride`
     - "Reset all learning" and "Clear all overrides", each behind a confirmation.
     - The internal `cat:__disliked__` is never shown.
   - **Appearance**
     - System, Light or Dark, written to the `theme` key. System removes the key.
     - Applies immediately.
   - **About**
     - App version.
     - Links to the website and `/ai`.
   - **Accessibility**
     - +/− buttons are labelled "Increase {tag}" and "Decrease {tag}".
     - Toggles expose their state.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0, with the `planSchedule` tests included |
| V2 | Native CI | the five `native` commands from 2.4 | exit 0 |
| V3 | Web still agrees | `pnpm --filter @dothingslol/web test` | the web's notification tests still pass on the shared formatters |
| V4 | Reconcile logic | unit test with a fake notifications API | leaves foreign notifications alone; a second run is a no-op; respects the cap; toggle off cancels all of ours |
| V5 | Settings logic | unit tests on the pure view-model: rows from a profile, +/− producing overrides, reset | passes |
| V6 | PR CI | `CI` | green |

**Device check (human, iOS and Android):**
1. The first like prompts for permission once. Denying it means Settings explains how to enable it.
2. Granting it, then "Send test notification", delivers a notification that opens the app when tapped.
3. Like an event that starts about 70 minutes from now. The reminder arrives around 1 hour before, and tapping it opens the event.
4. A date-only event for tomorrow is scheduled for 08:00 (check the dev debug list).
5. Like 70 events. At most 60 are scheduled, and they're the soonest ones.
6. Unliking an event removes its reminder. Turning notifications off empties the list, and turning them back on restores it.
7. Set the device clock to 07:59 tomorrow. The summary arrives with the right events.
8. **Taste.** Like 3 events: their tags appear as "learned". Press + on one: it shows "set by you", and Picks reorder. Reset: it's back to learned. Turn auto-learn off, then like another event: the weights don't change.
9. **Theme.** Each of System, Light and Dark applies immediately and persists across relaunch.

## Rollback

Revert this sub-phase's commits on the branch. Notifications already scheduled on test devices
stay until they fire or the app is reinstalled. A later reconcile cancels them by ID prefix.
