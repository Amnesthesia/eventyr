# Sub-phase 2.4: Native scaffold and data fetching

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 2.4 (native scaffold) of PR 2, the eventyr React Native app. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-2.04-native-scaffold.md`, and no other phase
> files. Work on branch `native/app`, even if your environment suggests another. If you can't push
> to it, stop and ask. Sync first, as described in PLAN §4.3. Follow the ordered steps and run
> every verification. Post the results as a comment on the PR 2 draft and tick 2.4.
>
> The "device check" needs a human with phones. List it as pending in your comment rather than
> claiming it passed. If a check fails and the fix isn't obvious and in scope, stop and report.
> Push, but don't merge, and don't start 2.5.

## Goal

Add `apps/native` (`@dothingslol/native`). It is an Expo app built with expo-router that:

- imports `@dothingslol/core` from source
- fetches the 2.2 feed and validates it
- caches the feed for offline use
- shows a city picker and a plain event list

This sub-phase also proves the monorepo mechanics every later sub-phase relies on:

- Metro can resolve workspace TypeScript.
- There is a single React.
- Hermes runs core's date, Intl and URL code correctly.

## Preconditions

- 2.3 is committed on the branch.
- The Expo SDK and React versions are recorded in the PR description (from 2.1).
- A cloud session can install, typecheck, test and `expo export`. It can't run a simulator.
- **The feed isn't public until PR 2 merges** (PLAN R10). During development:
  1. Run `pnpm build && pnpm --filter @dothingslol/web preview --host`.
  2. Point the app at it with `EXPO_PUBLIC_FEED_BASE_URL=http://<lan-ip>:4321`.

## Files affected

- New: `apps/native/**`.
- `pnpm-workspace.yaml`: `allowBuilds` entries (with reasons) for any new install scripts.
- `.github/workflows/ci.yml`: new `native` job.
- `CLAUDE.md`: "Native app" section.

## Steps

1. **Scaffold the app.**
   ```bash
   cd apps && pnpm dlx create-expo-app@latest native --template default --no-install && cd ..
   ```
   - Delete the template's example tabs and components.
   - In `package.json`, set `name: "@dothingslol/native"` and `private: true`, and add `"@dothingslol/core": "workspace:*"`.
   - Run `pnpm install`, then `pnpm --filter @dothingslol/native exec expo install --fix`.
   - `expo install` owns `react`, `react-native` and every `expo-*` version. The resolved `react` must equal the catalog pin from 2.1. If they differ, fix the catalog, not the app.
   - It's unverified whether `expo install --check` understands `catalog:` specifiers, so the native package keeps literal versions.
2. **Metro.**
   - Don't add a `metro.config.js` unless something needs it. Expo auto-configures monorepos (SDK 52+) and `autolinkingModuleResolution` (SDK 55+).
   - If a config is needed, start from `getDefaultConfig(__dirname)`. Never hand-set `watchFolders`, `nodeModulesPaths` or `disableHierarchicalLookup`.
   - Keep the `isolated` linker. Switch to `nodeLinker: hoisted` only after reproducing a concrete failure, and record it in the PR, because the change affects every package.
3. **Core spike (the first commit that does anything).**
   - Add `src/dev/coreSelfTest.ts`. It imports **every** core subpath the web uses and asserts known answers:
     - `eventHash` for the pinned fixture
     - `eventSlug`
     - `costLabel` for AUD/en-AU
     - `isoWithOffset` for Australia/Brisbane
     - `formatWhen` with explicit `timeZone` for Brisbane and for Sydney
     - `search` with a typo query
     - `todayIso`
     - `savedLink` round-trip
     - `calendarLinks` Google URL
     - `rankByTaste` on a v2 profile
   - Also exercise each `URL`, `URLSearchParams`, `btoa` and `TextEncoder` use listed in 1.3's PR comment.
   - Render the results on `app/_dev.tsx`, hidden in production.
   - Then run `pnpm --filter @dothingslol/native exec expo export --platform ios --platform android --output-dir /tmp/native-export`. A clean export proves Metro resolves core's `.ts` exports.
   - **If Metro rejects the `.ts`-extension imports inside core,** check `resolver.sourceExts` first. If that doesn't fix it, report back. Don't rewrite core's imports, because web and pipeline depend on them.
4. **Feed client (`src/data/feedClient.ts`).** No UI in this file.
   - The base URL is `process.env.EXPO_PUBLIC_FEED_BASE_URL ?? SITE_URL` from core, with paths `/data/v1/index.json` and `/data/v1/{slug}.json`.
   - Use conditional GET with `If-None-Match` and a stored ETag. A 304 returns the cached payload.
   - Cache the raw JSON plus `{etag, fetchedAt}` in the document directory using `expo-file-system`'s current API for this SDK. Don't use AsyncStorage: the Brisbane payload is about 1.7 MB raw.
   - Validate with core zod (`safeParse`):
     - Invalid events are dropped and counted.
     - An invalid payload keeps the previous cache and surfaces an error.
     - A payload whose `schema_version` is higher than this build supports keeps the cache and shows "Update the app".
   - The result type distinguishes "nothing there" from "failed to look":
     ```ts
     type FeedResult<T> =
       | { status: "fresh"; data: T; fetchedAt: string }
       | { status: "cached"; data: T; fetchedAt: string; error: FeedError }
       | { status: "unavailable"; error: FeedError };
     ```
   - Put the pure parts (response-to-result mapping, version gating) in `feedLogic.ts` and test them with `tsx --test`. Add the scripts `test`, `typecheck` (`tsc --noEmit`) and `lint`, and add `apps/native/{app,src}/**` to `biome.json`.
5. **Key-value store (`src/state/kv.ts`).**
   - A small synchronous key-value wrapper over `expo-sqlite`'s kv store (`expo-sqlite/kv-store`). Verify the SDK exports it. If the SDK has a `localStorage` polyfill in `expo-sqlite`, prefer that, since later sub-phases mirror the web stores most directly with it.
   - Key names come from `@dothingslol/core/storageKeys`.
   - The only key this sub-phase uses is the last city.
6. **Screens.**
   - `app/index.tsx`: the city picker. It remembers the last city and redirects to it on launch.
   - `app/[city]/index.tsx`:
     - header with the city name and "Updated {relative generated_at}"
     - pull to refresh
     - a `FlatList` of titles, with times from `formatWhen` (device zone)
     - an empty, error or offline state for each `FeedResult` status
   - Turn on typed routes and set scheme `dothings` in `app.json`. 2.9 converts this to `app.config.ts`.
7. **CI.** Add a `native` job to `ci.yml`:
   ```bash
   pnpm --filter @dothingslol/native exec expo install --check
   pnpm --filter @dothingslol/native exec expo-doctor
   pnpm --filter @dothingslol/native typecheck
   pnpm --filter @dothingslol/native test
   pnpm --filter @dothingslol/native exec expo export --platform ios --platform android --output-dir "$RUNNER_TEMP/native"
   ```
   `expo-doctor` has monorepo false positives for duplicate dependencies (expo/expo#41984). If it flags a duplicate that `pnpm why` shows isn't real, disable only that check in `package.json` `expo.doctor`, with a comment linking the issue.
8. **`CLAUDE.md`.** Add a "Native app (`apps/native`)" section covering:
   - the feed URL and `EXPO_PUBLIC_FEED_BASE_URL`
   - the cache location
   - `FeedResult` semantics
   - "never set RN/React versions by hand — `expo install --fix`"

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| V2 | SDK alignment | `pnpm --filter @dothingslol/native exec expo install --check` | exit 0 |
| V3 | One React and one RN | `pnpm why react --depth=10; pnpm why react-native --depth=10` | one version of each |
| V4 | Metro resolves core | the `expo export` command | bundles for both platforms |
| V5 | Doctor | `expo-doctor` | passes, or any disabled check is justified |
| V6 | Feed logic | `pnpm --filter @dothingslol/native test` | 304 → cached; 200 → fresh; invalid event dropped and counted; higher `schema_version` refused; network error with a cache → `cached`, without one → `unavailable` |
| V7 | Web untouched | build plus a fingerprint diff against the 2.3 result | no diff |
| V8 | PR CI | `CI` (both jobs) | green |

**Device check (human, iOS and Android, Expo Go, feed from the LAN preview):**
1. On `/_dev`, every self-test is green on **both** platforms. This is the Hermes Intl/URL check (PLAN R5, R7). Screenshot it for the PR.
2. Brisbane: the list loads, "Updated …" is correct, and pull to refresh works.
3. With the device time zone set to Sydney, times shift during DST.
4. Turn on airplane mode and relaunch. The cached list shows with an offline notice.
5. Relaunch while online. The app returns to the last city.

## Rollback

Revert this sub-phase's commits on the branch.
