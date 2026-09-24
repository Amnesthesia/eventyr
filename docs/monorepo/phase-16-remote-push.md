# Phase 16: Remote push (optional)

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 16 (remote push) of the eventyr monorepo refactor. **Only do this if PLAN.md
> open question 3 was answered "yes".** Read `docs/monorepo/PLAN.md` and
> `docs/monorepo/phase-16-remote-push.md`, and no other phase files. Branch
> `monorepo/phase-16-remote-push` from the latest `main`. Follow the ordered steps, run every
> verification command, and paste the results into the PR description. Anything that needs
> accounts, secrets, or a Cloudflare deploy goes on a pending-human list. Never create or paste
> credentials. If a check fails and the fix is not obvious and in scope, stop and report. Open a
> PR, but don't merge it.

## Goal

Add server-initiated notifications, such as "This week's picks for Gold Coast are up", that
reach app users who haven't opened the app. This is option B in PLAN §6:

- Expo Push Service for delivery.
- A minimal token store as a Cloudflare Worker with D1 (`apps/push`).
- A pipeline step that sends once the deploy has succeeded, and a receipt step that deletes dead tokens.

Personalisation stays on the device. The server stores only a token, a platform, and the
subscribed cities.

## Preconditions

- Phase 15 is merged and a development or production build is on devices. Remote push doesn't work in Expo Go, and hasn't since SDK 53.
- The human setup is done:
  - FCM v1 service-account key uploaded through `eas credentials`
  - APNs key registered
  - A Cloudflare D1 database created
  - GitHub secrets `EXPO_ACCESS_TOKEN` (if push security is enabled on the Expo project, which is recommended) and `PUSH_ADMIN_TOKEN` added
  - A Worker secret `PUSH_ADMIN_TOKEN` set
- The privacy policy and the store privacy answers from phase 15 have been updated to say the app stores a device push token.

## Files affected

- New `apps/push/`, named `@dothingslol/push`. It contains `package.json`, `wrangler.toml` (with the D1 binding and a custom domain such as `push.dothings.lol`), `src/index.ts`, `src/schema.sql` and tests. It depends only on `@dothingslol/core` for city keys and validation.
- New `apps/pipeline/src/notify/push.ts` (or `src/push.ts` if phase 07 hasn't run), with the scripts `notify-push` and `notify-push-receipts` plus root proxies. Uses `expo-server-sdk`.
- `.github/workflows/push.yml` (new).
- Native side: `apps/native/src/notifications/remote.ts`, settings screen toggles, and `app.config.ts` notification config.
- `ci.yml`: typecheck, tests and `wrangler deploy --dry-run` for `apps/push`.

## Steps

1. **Schema (`schema.sql`).**
   ```sql
   create table tokens (token text primary key, platform text not null check (platform in ('ios','android')),
     cities text not null /* JSON array of city keys */, created_at text not null, last_seen_at text not null);
   create table sends (id text primary key /* ticket id */, token text not null, sent_at text not null);
   ```
2. **Worker (`apps/push/src/index.ts`).**
   - `POST /v1/register` with body `{token, platform, cities}`:
     - Validate with zod.
     - `token` must match the `ExponentPushToken[...]` shape.
     - `cities` must be a subset of `KEY_TO_SLUG` keys from core.
     - Upsert the row and set `last_seen_at`.
   - `POST /v1/unregister` with body `{token}`.
   - Rate-limit per IP using Cloudflare's rate-limiting binding. Cap request bodies at 2 KB.
   - `GET /v1/targets?city=` and `POST /v1/prune`: both require `Authorization: Bearer PUSH_ADMIN_TOKEN`. Only the pipeline calls them.
   - The free tier is 100k D1 row writes per day and 100k Worker requests per day. Write this ceiling in a comment, following the repo's `ponytail:` convention for deliberate shortcuts.
3. **Sending (`notify/push.ts`).** Run it for one city.
   - Fetch the targets, then send in chunks with `expo-server-sdk` (100 per request; the SDK handles throttling and backoff).
   - The body is generic: `"This week's picks for {City} are up"`, with `data.url = "/{slug}/"`.
   - Persist the ticket ids to `sends` through an admin endpoint, or to `data/{city}/push/tickets-{date}.json`. Choose one and say which in the PR. File persistence keeps "diagnosis never needs a re-run" without adding Worker endpoints.
   - Report `targets → accepted → errored`, with the reasons.
4. **Receipts and demotion (`notify-push-receipts`).**
   - Run at least 15 minutes after sending. Receipts are cleared after 24 hours.
   - Fetch receipts, and prune tokens whose receipt reports `DeviceNotRegistered`.
   - Also prune tokens not seen for 60 days. The app re-registers on every launch.
   - This is the automated demotion that the CLAUDE.md rule "every automated promotion needs an automated demotion" requires.
5. **Workflow (`push.yml`).**
   - Trigger on `workflow_run` of "Deploy to GitHub Pages", `completed`, gated on `conclusion == 'success'`, plus `workflow_dispatch`.
   - Send only when the deploy followed a weekly digest. Check `github.event.workflow_run.event == 'workflow_run'`, or compare `data/index.json` week dates against the last send, which is stored with the tickets. Otherwise the daily 18:18 UTC rebuild would push every day.
   - Job 1 sends per city. Job 2 waits 15 minutes (`sleep` in a job is acceptable here) and processes receipts.
   - `concurrency: push`.
6. **Native side.**
   - Opt-in lives in settings, and is off by default unless Q3 said otherwise.
   - On opt-in, request permission, call `getExpoPushTokenAsync({ projectId })`, then POST `/v1/register` with the cities the user has picked.
   - Re-register on launch so `last_seen_at` stays fresh. On opt-out, unregister.
   - Tapping a received push reuses the phase 14 handler, since it has the same `data.url` shape.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Worker unit tests | `pnpm --filter @dothingslol/push test`, using Miniflare/workerd local D1 via `wrangler dev --local` or `@cloudflare/vitest-pool-workers` (pick one and justify it) | register validates, rejects bad tokens and cities, is idempotent, admin endpoints need auth |
| V3 | Dry deploy | `pnpm --filter @dothingslol/push exec wrangler deploy --dry-run --outdir /tmp/push` | exit 0 |
| V4 | Receipt pruning logic | unit test with canned receipts | `DeviceNotRegistered` deletes the token, other errors are logged and kept |
| V5 | Workflow | `actionlint .github/workflows/push.yml` | clean. The daily-rebuild guard is present |
| V6 | PR CI | `CI` | green |

**After merge and human setup:**
1. Run `wrangler d1 execute --file src/schema.sql`, then `pnpm --filter @dothingslol/push deploy`.
2. Opt in on a test device and confirm the row exists (`wrangler d1 execute --command "select platform,cities from tokens"`).
3. `workflow_dispatch` `push.yml` for one city. The device receives the notification, and tapping it opens that city.
4. Uninstall the app on a test device, then dispatch again. After the receipt job, that token is gone.
5. Watch one real Sunday. The push arrives after the deploy, not before it, and only once.

## Rollback

- Disable `push.yml`.
- Revert the PR.
- Tokens in D1 are harmless when nothing sends to them. Delete the database if the feature is dropped, and update the privacy policy.
- Builds that still register won't break when the endpoint is gone. Registration failures must be non-fatal in the app; step 6 must make it so.
