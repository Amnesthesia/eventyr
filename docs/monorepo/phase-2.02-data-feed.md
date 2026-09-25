# Sub-phase 2.2: Public data feed for the native app

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 2.2 (data feed) of PR 2, the eventyr React Native app. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-2.02-data-feed.md`, and no other phase files.
> Work on branch `native/app`, even if your environment suggests another; if you can't push to it,
> stop and ask. Sync first by merging `origin/main` in (PLAN §4.3). Follow the ordered steps, run
> every verification, post the results as a comment on the PR 2 draft, and tick 2.2. If a check
> fails and the fix isn't obvious and in scope, stop and report. Push. Don't merge, and don't
> start 2.3.

## Goal

Add a stable, versioned, validated public URL that carries every field needed for parity.
Today the site bakes its data into the HTML, and `/ai/*` drops tags, score, vibes, `venue_name`
and image. This sub-phase adds:

- `https://www.dothings.lol/data/v1/index.json`
- `https://www.dothings.lol/data/v1/{slug}.json`

Both are Astro **static endpoints**, generated from `data/*.json` at build time. Nothing new is
committed, and the deploy workflow doesn't change. The URLs go live only when PR 2 merges (PLAN
R10). Until then, native development reads a local preview of the site.

## Preconditions

- 2.1 is committed on `native/app`.

## Files affected

- **New:** `packages/core/src/feed.ts`, `packages/core/src/feed.test.ts`, `apps/web/src/pages/data/v1/index.json.ts`, `apps/web/src/pages/data/v1/[city].json.ts`, `scripts/feed-report.mjs`.
- **Edited:**
  - `packages/core/src/schema.ts`: add zod schemas.
  - `packages/core/package.json`: add `zod: catalog:`.
  - `.github/workflows/deploy.yml`: add a post-deploy smoke step.
  - `.github/workflows/ci.yml`: add a feed report step.
  - `CLAUDE.md`: add a "Native data feed" subsection.

## Contract

```ts
// packages/core/src/feed.ts
export const FEED_SCHEMA_VERSION = 1;          // bump only on breaking change; additive fields don't bump

export interface FeedIndex {
  schema_version: 1; generated_at: string;
  cities: { key: string; slug: string; name: string; timezone: string; locale: string; currency: string;
            week_start: string; week_end: string; data_as_of: string; url: string /* absolute */ }[];
}
export interface FeedCity {
  schema_version: 1; key: string; slug: string; name: string; timezone: string; locale: string; currency: string;
  week_start: string; week_end: string; generated_at: string; ranked_at: string | null;
  dropped: number;                              // events that failed validation (see policy below)
  events: FeedEvent[];
}
export interface FeedEvent {
  id: string;            // eventHash: frozen; iCal UID / RSS guid / #cal= links / native storage key (PLAN D6)
  slug: string;          // eventSlug → /{citySlug}/e/{slug}/, same as the web
  title: string; datetime: string; datetime_iso: string | null; datetime_end_iso: string | null;
  location: string | null; location_url: string | null; venue_name: string | null;
  link: string | null; category: string; cost: string | null; source: string | null;
  description: string | null; tags: string[]; image: string | null; score: number | null;
  social: boolean; intellectual: boolean; hands_on: boolean; creative: boolean;
}
export function toFeedEvent(e: Event, citySlug: string): FeedEvent | null;   // null when invalid
export function toFeedCity(payload: CityPayload, slug: string): FeedCity;
export function toFeedIndex(index: CityIndex, cities: CityPayload[], siteUrl: string, now: Date): FeedIndex;
```

Before freezing the field list, check it against PLAN §5. Every field the checklist uses must be
present. Fields it doesn't use, such as the `venue` tier and `_provider`, are omitted. Normalise
`""` to `null`; for example, `datetime_end_iso` can be `""` today. `datetime` (the city-local
string) is still included because it's the fallback when no ISO timestamp can be parsed (PLAN §8).

## Validation policy

`digest.yml` runs `pnpm build` **before** it commits. A failed build throws that week's data away
with the runner. So:

- An event that fails `FeedEventSchema` is dropped **from the feed only**. It stays on the website and is counted in `dropped`. The endpoint logs one line per dropped event with the title and the failing path.
- The build fails only when the index is invalid, or when a city loses more than 20% of its events.

## Steps

1. **zod schemas in `core/schema.ts`** for `Event` and `CityPayload`.
   - Match what the pipeline actually emits (PLAN §1.3).
   - Confirm every real `data/*.json` parses. Fix the schema, not the data.
   - Tree-shaking keeps zod out of the web client bundle, because the web imports only types on the client. Verify this in V4.
2. **`feed.ts` with tests.** Use fixtures that include `datetime_end_iso: ""` and an event with no title.
   - `id` must equal the pinned `eventHash` from `shared.test.ts`.
   - `slug` must equal `eventSlug`.
3. **Endpoints.** `[city].json.ts`:
   - `getStaticPaths` builds one path per city, from `data/index.json` via `src/lib/paths.ts`.
   - `GET` returns `new Response(JSON.stringify(toFeedCity(...)), { headers: { "content-type": "application/json" } })`.

   Write the index endpoint the same way. Then confirm the output is `apps/web/dist/data/v1/brisbane.json`, not `…/brisbane.json/index.html`, since `trailingSlash: "always"` is set.
4. **`scripts/feed-report.mjs`** prints, per city: event count, `dropped`, raw size, and gzip size.
   - It emits a `::warning::` above 400 KB gzip.
   - It never exits non-zero because of size.
   - Add it to `ci.yml` after `pnpm build`.
5. **Post-deploy smoke.** Add a final step to the `deploy.yml` deploy job:
   ```bash
   curl -sf https://www.dothings.lol/data/v1/index.json | node -e 'const j=JSON.parse(require("fs").readFileSync(0));if(j.schema_version!==1||!j.cities.length)process.exit(1);console.log(j.cities.map(c=>c.slug).join(" "))'
   ```
6. **Don't advertise the feed.** Leave `llms.txt`, `openapi.yaml` and `.well-known/api-catalog` unchanged. This is an app contract, not a public AI API.
7. **`CLAUDE.md`.** Add 5–8 lines covering:
   - the URL
   - the versioning rule: additive changes don't bump; renames and removals mean `/data/v2/`
   - the validation policy

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0, including the new tests |
| V2 | Files emitted | `TZ=Australia/Brisbane pnpm build && ls apps/web/dist/data/v1/` | `index.json` plus four city files |
| V3 | Real data validates | `node scripts/feed-report.mjs apps/web/dist/data/v1` | `dropped` is 0, or a few with named reasons. Record the gzip sizes |
| V4 | No zod in the client bundle | `grep -rl "ZodError\|zod" apps/web/dist/_astro \|\| echo clean` | `clean` |
| V5 | The rest of the site is unchanged | fingerprint diff excluding `/data/v1/` lines | no other diff |
| V6 | A bad event doesn't fail the build | Temporarily blank one title in `data/brisbane.json`, build, then `git checkout data/brisbane.json` | build passes, `dropped: 1`, and the event is named in the log |
| V7 | PR CI | `CI` | green, with the feed report printed |

The live checks (content type, ETag, a 304 on `If-None-Match`, the deploy smoke step) are in the 2.9 runbook.

## Rollback

Revert this sub-phase's commits on the branch.
