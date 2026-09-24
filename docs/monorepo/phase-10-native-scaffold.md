# Phase 10 — Native scaffold and data fetching

> **Handoff — paste into a fresh Claude Code session**
>
> Execute phase 10 (native scaffold) of the eventyr monorepo refactor. Read `docs/monorepo/PLAN.md`
> and `docs/monorepo/phase-10-native-scaffold.md`, and no other phase files. Create branch
> `monorepo/phase-10-native-scaffold` from the latest `main`. Follow the steps in order, run every
> verification command, and paste the results into the PR description. The "device check" section
> needs a human with a phone. List it in the PR as a pending item rather than claiming it passed. If
> a check fails and the fix is not obvious and in scope, stop and report. Open a PR. Do not merge it,
> and do not start phase 11.

## Goal

Add `apps/native` (`@dothingslol/native`), an Expo app built with expo-router. It imports
`@dothingslol/core` from source, fetches and validates the phase 08 feed, caches it for offline
use, and shows a city picker and a plain event list. It also proves the monorepo mechanics that
every later native phase relies on: Metro resolving workspace TypeScript, a single React, and
Hermes running core's date and Intl code. CI starts checking the app.

## Preconditions

- Phases 08 (feed live at `https://www.dothings.lol/data/v1/`) and 09 (web on the Expo SDK's React) are merged.
- The Expo SDK is the one recorded in phase 09's PR.
- A cloud Claude session can't run an iOS simulator. It can install, typecheck, test and `expo export`. On-device checks are for a human using Expo Go or a development build.

## Files affected

- New: `apps/native/**`.
- `pnpm-workspace.yaml`: catalog entries only if needed, plus `allowBuilds` entries for any new install scripts, each with a reason.
- `.github/workflows/ci.yml`: new `native` job.
- `scripts/check-boundaries.mjs`: no change expected. The app depends only on core.
- `CLAUDE.md`: a short "Native app" section.

## Steps

1. **Scaffold.**
   ```bash
   cd apps && pnpm dlx create-expo-app@latest native --template default --no-install && cd ..
   ```
   - Delete the template's example tabs and components.
   - Set `name: "@dothingslol/native"` and `private: true` in `package.json`.
   - Add `"@dothingslol/core": "workspace:*"`.
   - Run `pnpm install`, then `pnpm --filter @dothingslol/native exec expo install --fix`.
   - Let `expo install` own `react`, `react-native` and every `expo-*` version. Then check that `react` equals the catalog version from phase 09. If they differ, fix the catalog and not the app. It is unverified whether `expo install --check` understands `catalog:` specifiers, so the native package keeps literal versions.
2. **Metro.**
   - Don't add a `metro.config.js` unless something needs it. Expo configures monorepos automatically (SDK 52+) and enables `autolinkingModuleResolution` (SDK 55+).
   - If a config is needed, start from `getDefaultConfig(__dirname)`. Never set `watchFolders`, `nodeModulesPaths` or `disableHierarchicalLookup` by hand.
   - The linker is pnpm's default `isolated`. Switch to `nodeLinker: hoisted` in `pnpm-workspace.yaml` only after you have reproduced a concrete failure. Record it in the PR, because it affects every package.
3. **Core spike, first commit that does anything.**
   - Add `apps/native/src/dev/coreSelfTest.ts`. It imports **every** core subpath used by web and runs assertions with known answers:
     - `eventHash` on the pinned fixture from `shared.test.ts`
     - `eventSlug`
     - `costLabel` for `AUD` / `en-AU`
     - `isoWithOffset` for `Australia/Brisbane`
     - `search` with a typo query
     - `displayDatetime` "On now"
     - `todayIso`
     - `savedLink` round-trip
     - `calendarLinks` Google URL
   - It also exercises each `URL`, `URLSearchParams`, `btoa` and `TextEncoder` use listed in phase 02's PR. React Native's `URL` implementation is incomplete.
   - Render the results on a dev-only route, `app/_dev.tsx`, hidden in production builds.
   - Run `pnpm --filter @dothingslol/native exec expo export --platform ios --platform android --output-dir /tmp/native-export`. A clean export proves Metro resolved core's `.ts` exports.
   - **If Metro rejects `.ts`-extension imports inside core:** first try `resolver.sourceExts`, which should already include `ts`. If that fails, report back. Don't rewrite core's imports without asking, because web and pipeline depend on them.
4. **Feed client: `apps/native/src/data/feedClient.ts`.** No UI in this file.
   - `fetchIndex()` and `fetchCity(slug)` read `https://www.dothings.lol/data/v1/…`. The base URL is `SITE_URL` from core.
   - Conditional GET with `If-None-Match`, using the ETag stored with the cache entry. A 304 returns the cached payload.
   - Cache the raw JSON text plus metadata (`etag`, `fetchedAt`) in the app's document directory, using `expo-file-system`'s current API for this SDK. Don't use AsyncStorage: the Brisbane payload is about 1.7 MB raw, and AsyncStorage on Android has small per-entry limits.
   - Validate with core's zod schemas (`safeParse`). An invalid event is dropped and counted. An invalid city payload keeps the previous cache and surfaces an error.
   - Refuse a payload whose `schema_version` is higher than the version this build understands. Keep the cache and show "update the app".
   - The return type separates the cases the UI must render differently, per "Distinguish 'nothing there' from 'failed to look'":
     ```ts
     type FeedResult<T> =
       | { status: "fresh"; data: T; fetchedAt: string }
       | { status: "cached"; data: T; fetchedAt: string; error: FeedError }   // network/validation failed, showing cache
       | { status: "unavailable"; error: FeedError };                         // no cache and fetch failed
     ```
   - Put pure pieces (response-to-result mapping, version gating) in `feedLogic.ts` and unit-test them with `tsx --test`, the same way as the rest of the repo. Add scripts `test`, `typecheck` (`tsc --noEmit`) and `lint`. Biome already covers `apps/**` once `biome.json` includes `apps/native/src/**` and `apps/native/app/**`.
5. **Screens.**
   - `app/index.tsx`: city picker from the index. Remembers the last city (step 6) and redirects to it on launch.
   - `app/[city]/index.tsx`: header showing city name and "Updated {relative generated_at}". Pull-to-refresh. A `FlatList` of titles and dates. An empty, error or offline state for each `FeedResult` status.
   - Typed routes on, and URL scheme `dothings` in `app.json` for now. Phase 15 moves config to `app.config.ts`.
6. **Key-value store: `apps/native/src/state/kv.ts`.**
   - A small synchronous key-value wrapper over `expo-sqlite`'s key-value store (`expo-sqlite/kv-store`). Check that the installed SDK exports it. If the SDK provides a `localStorage` polyfill from `expo-sqlite`, prefer that, because it lets later phases mirror web storage code most directly.
   - Key names come from `@dothingslol/core/storageKeys`. The only key used in this phase is the last city.
7. **CI.** Add a `native` job to `ci.yml` after install:
   ```bash
   pnpm --filter @dothingslol/native exec expo install --check
   pnpm --filter @dothingslol/native exec expo-doctor
   pnpm --filter @dothingslol/native typecheck
   pnpm --filter @dothingslol/native test
   pnpm --filter @dothingslol/native exec expo export --platform ios --platform android --output-dir "$RUNNER_TEMP/native"
   ```
   - `expo-doctor` has known monorepo false positives on duplicate dependencies (expo/expo#41984). If it flags a duplicate that `pnpm why` shows is not a real second copy, disable only that check, in `package.json` `expo.doctor`, with a comment linking the issue.
   - Also add the native `typecheck` and `test` to the `pnpm -r` coverage in `check`.
8. **Docs.** Add a `CLAUDE.md` section "Native app (`apps/native`)" covering the feed URL, cache location, `FeedResult` semantics, and "never set RN/React versions by hand — `expo install --fix`".

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| V2 | SDK alignment | `pnpm --filter @dothingslol/native exec expo install --check` | exit 0 |
| V3 | One React / one RN | `pnpm why react --depth=10; pnpm why react-native --depth=10` | one version each |
| V4 | Metro resolves core | the `expo export` command above | exit 0, bundle emitted for both platforms |
| V5 | Doctor | `expo-doctor` | passes, or passes with each disabled check justified |
| V6 | Feed logic | `pnpm --filter @dothingslol/native test` | 304→cached, 200→fresh, invalid event dropped and counted, higher `schema_version` refused, network error with cache→`cached`, without cache→`unavailable` |
| V7 | Web untouched | `TZ=Australia/Brisbane pnpm build` + fingerprint diff against `main` | no diff |
| V8 | PR CI | `CI` (both jobs) | green |

**Device check (human, before merge):**
1. `pnpm --filter @dothingslol/native start` → Expo Go on an iPhone and an Android phone.
2. `/_dev`: every self-test is green on **both** platforms. This is the Hermes Intl and URL check from PLAN R5/R7. Screenshot it for the PR.
3. Pick Brisbane: events list, "Updated …" is correct, pull to refresh.
4. Airplane mode, relaunch: cached list shows with an offline notice.
5. Relaunch online: it returns to the last city.

## Rollback

Revert the squash-merge. Web, pipeline and deploy don't depend on `apps/native`. The lockfile
revert removes its dependencies.
