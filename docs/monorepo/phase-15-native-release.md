# Phase 15: native release configuration

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 15 (native release) of the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-15-native-release.md` only, and no other phase
> files. Branch `monorepo/phase-15-native-release` from the latest `main`. Follow the ordered steps,
> run every verification command, and paste the results into the PR description. Steps that need
> store accounts, signing credentials or secrets must be done by a human. List them as pending with
> exact instructions. Never create, request or paste credentials yourself. If a check fails and the
> fix isn't obvious and in scope, stop and report. Open a PR. Do not merge it.

## Goal

Make `apps/native` shippable. That covers:

- app identity and assets
- EAS build profiles
- over-the-air updates
- universal and app links, so `https://www.dothings.lol/{slug}/e/{eventSlug}/` and `#cal=` links open the app
- store metadata
- a release workflow

This phase touches the website only to add two `.well-known` files.

## Preconditions

- Phase 14 is merged.
- PLAN Q4 is answered. That means the Apple Developer Program membership, Google Play Console account and Expo account exist, and the bundle ID is chosen (suggested: `lol.dothings.app`).
- PLAN Q8 is answered (analytics and donation link in the app).

## Files affected

- `apps/native/app.json` → `apps/native/app.config.ts` (`git mv`, then convert). This gives dynamic config for the environment and version.
- `apps/native/eas.json` (new).
- `apps/native/assets/{icon,adaptive-icon,splash}.png`, generated from `apps/web/public/icons/` via `apps/web/scripts/generate-icons.mjs` or a sibling script. Don't hand-draw them.
- `apps/web/public/.well-known/apple-app-site-association` (new, no file extension).
- `apps/web/public/.well-known/assetlinks.json` (new).
- `.github/workflows/native-release.yml` (new).
- `apps/native/store/` (new): store listing text, privacy answers and screenshots checklist.
- `CLAUDE.md`: a short native release subsection.

## Steps

1. **`app.config.ts`:**
   - `name: "dothings"` and `slug: "dothings"`.
   - `scheme: "dothings"`.
   - `ios.bundleIdentifier` and `android.package`, set from Q4.
   - `ios.associatedDomains: ["applinks:www.dothings.lol"]`.
   - `android.intentFilters` for `https://www.dothings.lol` with `autoVerify: true`, covering path prefixes `/brisbane/`, `/gold-coast/`, `/sunshine-coast/` and `/byron/`. Generate that list from `KEY_TO_SLUG` in core rather than hard-coding it, because a new city must not need a native release.
   - `version` from `package.json`.
   - `runtimeVersion: { policy: "fingerprint" }`.
   - `updates.url` from the EAS project.
   - `userInterfaceStyle: "automatic"`.
2. **Router mapping for web URLs.**
   - Confirm that `/{slug}/`, `/{slug}/e/{eventSlug}/`, `/{slug}/{category-or-timeframe}/`, `/` (Brisbane) and `/{slug}/#cal=…` all route correctly. `+native-intent.tsx` from phase 13 already handles `#cal=`.
   - Web-only paths (`/ai/`, `/llms.txt`, feeds) must **not** be claimed. Leave them out of the Android filters and the AASA `components`.
3. **`.well-known` files.**
   - `apple-app-site-association` uses the `applinks.details[].components` format, listing the same city prefixes and excluding `/ai/*`. It needs the Apple Team ID, which a human adds.
   - `assetlinks.json` needs the SHA-256 fingerprint of the **Play App Signing** certificate, not the upload key. A human copies it from Play Console after the first upload.
   - Commit both files with clearly marked placeholders. The pending-human list covers filling them in.
4. **Hidden-file and content-type check (PLAN R11).** After a deploy that includes these files, run:
   ```bash
   curl -sI https://www.dothings.lol/.well-known/apple-app-site-association | grep -iE 'HTTP|content-type'
   curl -sI https://www.dothings.lol/.well-known/assetlinks.json | grep -iE 'HTTP|content-type'
   ```
   - Both must return 200. `assetlinks.json` must be `application/json`.
   - For AASA, iOS fetches through Apple's CDN (`https://app-site-association.cdn-apple.com/a/v1/www.dothings.lol`). Verify with that URL, because it shows what iOS actually sees.
   - If GitHub Pages serves AASA with a content type Apple rejects, record it. The fallback is custom-scheme links on iOS, with the website as the landing page. Don't add infrastructure for this without asking.
5. **`eas.json` profiles:**
   - `development`: dev client, internal distribution.
   - `preview`: internal distribution, production API.
   - `production`: store, `autoIncrement: true`.
   - Set `cli.appVersionSource: "remote"`.
   - Point `eas build` at the monorepo properly. EAS uploads the whole repo and runs from `apps/native`. There is a known pnpm-workspace lockfile-detection issue (expo/eas-cli#3247). Read its current status. If it still applies, apply the documented workaround and cite it in a comment.
6. **OTA updates.**
   - `expo-updates` with the fingerprint runtime policy. JS-only changes ship with `eas update --branch production`, and a native change forces a new build.
   - Document in `CLAUDE.md` which changes need a store build: new native module, config plugin change, SDK bump.
7. **`native-release.yml`:**
   - Trigger on `workflow_dispatch` (inputs: profile, platform) and on tags `native-v*`.
   - Steps: `expo/expo-github-action` with the `EXPO_TOKEN` secret, `pnpm install --frozen-lockfile`, `pnpm check`, then `eas build --non-interactive --profile $profile --platform $platform`. Add `eas submit` only for tags.
   - It must not run on ordinary pushes.
   - Add the `EXPO_TOKEN` secret to the pending-human list.
8. **Store metadata (`apps/native/store/`):**
   - Descriptions, based on the site's intro copy.
   - Privacy answers. With no analytics and local-only notifications, "Data not collected" is accurate. If Q8 adds analytics, update this.
   - A screenshot checklist.
   - Apple review note: the app shows third-party event listings and links out to ticket sites.
   - Drop the Buy Me a Coffee link in-app, unless Q8 says otherwise. External donation links are an App Review risk.
9. **Human-only list.** Put this in the PR description:
   - Apple Team ID into AASA.
   - Play signing SHA-256 into `assetlinks.json`.
   - Run `eas init` to link the project, then commit `extra.eas.projectId`.
   - `eas credentials`.
   - Add the `EXPO_TOKEN` GitHub secret.
   - Create the App Store Connect app and the Play Console app.
   - Run the first `production` build and submit it to TestFlight and internal testing.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0 |
| V2 | Config resolves | `pnpm --filter @dothingslol/native exec expo config --type public` | bundle IDs, scheme, associated domains and intent filters present |
| V3 | Native CI | the five `native` commands from phase 10 | exit 0 |
| V4 | Web deploy unaffected apart from `.well-known` | build plus the site fingerprint diff | only the two new `.well-known` files differ |
| V5 | Workflow syntax | `actionlint .github/workflows/native-release.yml` | clean |
| V6 | PR CI | `CI` | green |

**After merge and human setup:**
1. Run the step 4 curl checks and record the results.
2. Run a `preview` build via `native-release.yml` dispatch. It installs on both platforms.
3. Tap `https://www.dothings.lol/brisbane/e/<slug>/` in Messages or Notes. It opens the app on the detail screen, on both platforms.
4. Open an `/ai/` link. It opens the browser, not the app.
5. `eas update --branch preview` with a trivial text change. The preview build picks it up on the next launch.
6. The `production` build is accepted by TestFlight and Play internal testing.

## Rollback

- **Before any store release:** revert the PR. If link claims cause problems, remove the two `.well-known` files in a web PR. That's harmless, because nothing points at them yet.
- **After a store release:** releases can't be recalled. Ship fixes by `eas update` for JS-only changes, or as a new build. Removing the `.well-known` files stops links opening the app, and they fall back to the website.
