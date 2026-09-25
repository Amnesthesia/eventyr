# Sub-phase 2.9 — Release configuration, merging PR 2, post-merge runbook

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 2.9 (native release and merge) of PR 2, the eventyr React Native app.
>
> - Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-2.09-native-release-and-merge.md`, and no other phase files.
> - Work on branch `native/app`, even if your environment suggests another. If you can't push to it, stop and ask.
> - Sync first, as PLAN §4.3 describes.
> - Follow the steps in order and run the pre-merge suite. Post the results as a comment on the PR 2 draft, tick 2.9, and mark the PR ready.
> - Anything needing store accounts, signing credentials or secrets goes on a pending-human list. Never create, request or paste credentials yourself.
> - **You don't merge.** A human merges. After they say it's merged, run the post-merge runbook and report.
> - If a check fails and the fix isn't obvious and in scope, stop and report.

## Goal

Make `apps/native` shippable on iOS and Android together (D4) under `lol.dothings.app`. That
covers:

- identity and assets
- EAS profiles
- over-the-air updates
- universal/app links, so that `https://www.dothings.lol/{slug}/e/{eventSlug}/` and `#cal=` links open the app
- store metadata with no analytics and no donation link (D8)
- a release workflow

Then merge PR 2 and verify the web changes and the feed in production.

## Preconditions

- 2.1 to 2.8 are ticked, and their device checks are done.
- A human has an Apple Developer Program membership, a Google Play Console account and an Expo account.

## Files affected

- **App config:** `apps/native/app.json` → `apps/native/app.config.ts`. Do this with `git mv`, then convert it.
- **Build config:** `apps/native/eas.json` (new).
- **Icons and splash:** `apps/native/assets/{icon,adaptive-icon,splash}.png`, generated from `apps/web/public/icons/` via `apps/web/scripts/generate-icons.mjs` or a sibling script. Don't draw them by hand.
- **Link verification files (new):** `apps/web/public/.well-known/apple-app-site-association` (no extension) and `apps/web/public/.well-known/assetlinks.json`.
- **Release workflow (new):** `.github/workflows/native-release.yml`.
- **Store listing (new):** `apps/native/store/`, holding listing text, privacy answers and a screenshot checklist.
- **Docs:** `CLAUDE.md` gets a native release subsection.

## Steps

1. **`app.config.ts`**
   - `name`/`slug`: `dothings`
   - `scheme`: `dothings`
   - `ios.bundleIdentifier` and `android.package`: `lol.dothings.app`
   - `ios.associatedDomains`: `["applinks:www.dothings.lol"]`
   - `android.intentFilters` for `https://www.dothings.lol`, with `autoVerify: true`. Generate the per-city path prefixes from `KEY_TO_SLUG` in core so that adding a city never needs a native release. Also add `/` (Brisbane).
   - `version` from `package.json`
   - `runtimeVersion: { policy: "fingerprint" }`
   - `updates.url`
   - `userInterfaceStyle: "automatic"`
2. **Route mapping.**
   - These must all open the matching screen: `/`, `/{slug}/`, `/{slug}/e/{eventSlug}/`, `/{slug}/{category|today|tomorrow|this-weekend}/`, `/{slug}/#cal=…`, and `/settings/`, which maps to the Settings screen.
   - `/ai/`, `/llms.txt` and the feeds are **not** claimed. Leave them out of both the Android filters and the AASA components.
3. **`.well-known` files.**
   - AASA uses the `applinks.details[].components` format. It lists the same prefixes and excludes `/ai/*`. It needs the Apple Team ID, which a human fills in.
   - `assetlinks.json` needs the **Play App Signing** SHA-256, which a human fills in after the first upload.
   - Commit both with clearly marked placeholders.
4. **`eas.json`**
   - Profiles: `development` (dev client, internal), `preview` (internal), and `production` (store, `autoIncrement`).
   - Set `cli.appVersionSource: "remote"`.
   - Check the current status of expo/eas-cli#3247, the lockfile detection issue in pnpm workspaces. If it still applies, apply the documented workaround and cite it in a comment.
5. **OTA updates.**
   - Use `expo-updates` with the fingerprint policy.
   - JS-only changes ship with `eas update --branch production`.
   - A new native module, a config-plugin change or an SDK bump each need a store build. Document this in `CLAUDE.md`.
6. **`native-release.yml`**
   - Triggers: `workflow_dispatch` (inputs `profile` and `platform`, where `platform` defaults to `all` since D4 launches both platforms together) and tags `native-v*`.
   - Steps:
     1. `expo/expo-github-action` with `EXPO_TOKEN`
     2. `pnpm install --frozen-lockfile`
     3. `pnpm check`
     4. `eas build --non-interactive --profile $profile --platform $platform`
     5. `eas submit`, on tags only
   - It must not run on ordinary pushes.
7. **Store metadata (`apps/native/store/`)**
   - Descriptions, adapted from the site's intro copy.
   - Privacy answers: **"Data not collected"**. That's accurate: there are no analytics, notifications are local, taste stays on the device, and the feed fetch is anonymous.
   - The review note says the app shows third-party listings and links out to ticket sites.
   - No Buy Me a Coffee link.
8. **Pending-human list.** Put this in the PR description:
   - Apple Team ID into AASA
   - Play signing SHA-256 into `assetlinks.json`
   - `eas init`, then commit `extra.eas.projectId`
   - `eas credentials`
   - `EXPO_TOKEN` GitHub secret
   - Create the App Store Connect and Play Console apps

## Pre-merge suite

| # | Check | Command | Pass condition |
|---|---|---|---|
| P1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| P2 | Config resolves | `pnpm --filter @dothingslol/native exec expo config --type public` | bundle IDs, scheme, associated domains and intent filters are present |
| P3 | Native CI | the five `native` commands from 2.4 | exit 0 |
| P4 | Web changes are only the intended ones | Build `origin/main` and the branch, then compare fingerprints | Differences appear only in these places: `/data/v1/*`, `/settings/`, the two `.well-known` files, the header's settings link, time-zone labels on the time display, and island markers from React 19. List each changed path. |
| P5 | Web behaviour | `filter-parity.mjs` against both builds, with `TZ=Australia/Brisbane` | identical counts |
| P6 | Workflow syntax | `actionlint .github/workflows/*.yml` | clean |
| P7 | Preview build (needs human setup) | Dispatch `native-release.yml` with `profile=preview` and `platform=all` on the branch | builds for both platforms, and they install |

Mark the PR ready. Remind whoever merges to use **"Create a merge commit"** and to stay outside
the Saturday 18:00–23:00 UTC window.

## Post-merge runbook

1. **Deploy and feed.** The deploy is green, including its feed smoke step.
   ```bash
   curl -sI https://www.dothings.lol/data/v1/brisbane.json | grep -iE '^(HTTP|content-type|etag|cache-control|last-modified)'
   ETAG=$(curl -sI https://www.dothings.lol/data/v1/brisbane.json | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
   curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $ETAG" https://www.dothings.lol/data/v1/brisbane.json   # 304
   curl -s -o /dev/null -w '%{http_code}\n' https://www.dothings.lol/settings/                                          # 200
   ```
2. **Existing web users.** On a browser profile that already has v1 data, load `/brisbane/`. Picks order is unchanged, and `/settings/` shows the migrated entries (PLAN R11).
3. **Link files.**
   ```bash
   curl -sI https://www.dothings.lol/.well-known/apple-app-site-association | grep -iE 'HTTP|content-type'
   curl -sI https://www.dothings.lol/.well-known/assetlinks.json | grep -iE 'HTTP|content-type'
   curl -s https://app-site-association.cdn-apple.com/a/v1/www.dothings.lol | head -c 300
   ```
   - Both files must return 200, and `assetlinks.json` must be served as `application/json`.
   - Apple's CDN shows what iOS actually sees.
   - If Pages serves AASA with a type Apple rejects (PLAN R12), record it. The fallback is the custom scheme, with the website as the landing page. Don't add infrastructure without asking.
4. **Production builds.** Build production with the app's feed base URL unset (the default is `SITE_URL`). Submit both platforms to TestFlight and Play internal testing.
5. **On-device checks against production.**
   - Tapping `https://www.dothings.lol/brisbane/e/<slug>/` in Messages opens the app.
   - `/ai/` opens the browser.
   - `eas update --branch preview` with a trivial text change is picked up on the next launch.

## Rollback

- **Web or feed, after merge:** `git revert -m 1 <merge-sha>`.
  - Web users fall back to their untouched v1 taste keys.
  - The `/data/v1/` URLs disappear. Any installed app shows its cached feed with an error state and doesn't crash.
- **App releases:** these can't be recalled. Fix forward with `eas update` for JS-only changes, or with a new build.
- **Links:** removing the `.well-known` files stops links opening the app. They then fall back to the website.
