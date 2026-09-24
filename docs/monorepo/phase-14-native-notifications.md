# Phase 14 — Native local notifications

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 14 (native notifications) of the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-14-native-notifications.md`, and no other phase
> files. Branch `monorepo/phase-14-native-notifications` from the latest `main`. Follow the ordered
> steps, run every verification command, and paste the results into the PR description. List the
> device-check items as pending for a human; don't claim them. If a check fails and the fix is not
> obvious and in scope, stop and report. Open a PR, don't merge it, and don't start phase 15.

## Goal

Give native the same notifications as the website, using on-device scheduling only (option A in
PLAN §6). No server and no push tokens.

- A reminder 1 hour before each saved event. For date-only events, the reminder fires at 08:00.
- An 08:00 digest of today's saved events.
- A permission prompt on the first save, a "Get reminders" entry point, and "Send test notification".
- Tapping a notification opens the event, or the saved screen for the digest.
- Optional, off by default unless PLAN Q3 asks for it: a fixed "This week's picks are up" notification on Sunday mornings.

Timing and wording come from `@dothingslol/core/reminders`, so web and native agree.

## Preconditions

- Phase 13 is merged.
- PLAN Q3 is answered. This phase doesn't depend on the answer; phase 16 does.

## Files affected

- `packages/core/src/reminders.ts`: add `planSchedule`, with tests.
- `apps/native/src/notifications/{permissions.ts,reconcile.ts,handlers.ts,backgroundRefresh.ts}`.
- `apps/native/app/_layout.tsx`: register the handlers and reconcile on launch and foreground.
- `apps/native/app/settings.tsx` (new): reminders toggle, test notification, permission state.
- `apps/native/app.json`: plugin config for `expo-notifications`, plus `expo-background-task` if step 5 is done.
- New dependencies, installed with `expo install`: `expo-notifications`, and optionally `expo-background-task`. Don't use `expo-background-fetch`, which is deprecated.

## Steps

1. **`planSchedule` in core (pure, tested).**
   ```ts
   export interface PlannedNotification { id: string; fireAt: string /* ISO */; title: string; body: string; url: string /* app path */ }
   export function planSchedule(saved: readonly Event[], now: Date, opts: { cap: number; timeZone: string; digestHour: 8; days: 7 }): PlannedNotification[];
   ```
   - Reuse the existing `calculate1hReminderTime`, `filterEventsForMorningDigest`, `formatMorningDigest` and `formatEventTime`. Don't fork them.
   - Output is sorted by `fireAt` and truncated to `cap`. **iOS keeps only the 64 soonest pending notifications**, so native passes `cap: 60` and leaves headroom for the test notification. This limit is documented in Apple's developer forums, not in official docs.
   - Build ids deterministically (`reminder:{eventHash}`, `digest:{YYYY-MM-DD}`). Reconciliation diffs by id.
   - Plan one dated digest per day for the next 7 days, each carrying that day's actual content. Don't use a daily repeating trigger, because a repeating trigger's content is fixed when it's scheduled.
   - Skip anything whose `fireAt` is already in the past.
   - Tests cover: date-only events at 08:00 in the city time zone, the cap, a day with no saved events (no digest), an event starting within the hour (no reminder in the past), and determinism of ids.
2. **Permissions (`permissions.ts`).**
   - The first save triggers the OS prompt, which is the same moment the web prompts.
   - A denial is remembered, and the app doesn't re-prompt. The settings screen explains the denial and links to the OS settings.
   - Android 13+ needs the runtime `POST_NOTIFICATIONS` permission, which `expo-notifications` handles.
   - Use inexact scheduling. Don't request `SCHEDULE_EXACT_ALARM`: a reminder a few minutes late is acceptable, and the permission adds review friction. Check how the SDK's date trigger behaves on Android 12+ and record what you find in the PR.
3. **Reconcile (`reconcile.ts`).**
   - Runs on launch, on foreground, on every save or unsave, and when the feed refreshes (event times can change between weekly runs).
   - Sequence: `getAllScheduledNotificationsAsync()`, keep ours by id prefix, compute the plan, then cancel what's gone and schedule what's new or changed. Never touch a scheduled notification that isn't ours.
   - Log a one-line summary (`planned N, scheduled +a −b, capped c`), following the repo's "report ratios" rule.
4. **Handlers (`handlers.ts`).**
   - Foreground presentation shows a banner.
   - The response listener routes `data.url` through expo-router: the event detail for reminders, `/[city]/saved` for the digest.
   - A notification whose event is no longer in the feed shows the detail screen's "no longer listed" state from phase 11.
5. **Optional: background refresh (`backgroundRefresh.ts`).**
   - Register an `expo-background-task` task that fetches the current city feed through the phase 10 client (ETag, so it's usually a 304) and runs `reconcile`.
   - Treat this as best effort and say so in code comments. iOS decides when it runs, and not at all on simulators. Android's minimum interval is 15 minutes. All JS tasks share one worker.
   - The feature must be correct without it: it only improves freshness.
6. **Optional: Sunday "new week" notification.** Build this only if Q3's answer asks for it.
   - Schedule one dated notification for the next Sunday at 07:30 Australia/Brisbane. The weekly cron runs at 06:00 AEST, and the deploy follows it.
   - Re-plan it on each reconcile.
   - The body is generic ("This week's picks for {city} are up"). Personalised content would need the new data, which the device doesn't have yet.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0, with `planSchedule` tests included |
| V2 | Native CI | the five `native` commands from phase 10 | exit 0 |
| V3 | Web still agrees | `pnpm --filter @dothingslol/web test` | the web's notification tests still pass against core's shared formatters |
| V4 | Reconcile logic | a unit test with a fake notifications API | leaves foreign notifications alone, is idempotent (second run is a no-op), and respects the cap |
| V5 | PR CI | `CI` | green |

**Device check (human, iOS and Android, on a development build or Expo Go):**
1. First save: the permission prompt appears once. Deny it, and the settings screen explains how to enable.
2. Grant permission, then use "Send test notification": it arrives, and tapping it opens the app.
3. Save an event that starts within about 70 minutes. The reminder arrives about 1 hour before, and tapping it opens that event.
4. Save a date-only event for tomorrow. The reminder is scheduled for 08:00 (check the settings screen's debug list).
5. Save 70 events across the week. The scheduled count is at most 60 and holds the soonest ones.
6. Unsave: its reminder disappears from the scheduled list.
7. Kill the app, change the device clock to 07:59 tomorrow, and wait. The digest arrives with the right event list.

## Rollback

Revert the squash-merge. Notifications that were already scheduled on test devices stay until the
app is reinstalled or they fire. Reconcile in a later build cancels them by id prefix.
