# Phase 08: Public data feed for the native app

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 08 (data feed) of the eventyr monorepo refactor. Read `docs/monorepo/PLAN.md`
> and `docs/monorepo/phase-08-data-feed.md`, and no other phase files. Create branch
> `monorepo/phase-08-data-feed` from the latest `main`. Follow the ordered steps, run every
> verification command and paste the results into the PR description. If a check fails and the
> fix is not obvious and within this phase's scope, stop and report. Open a PR. Don't merge it,
> and don't start phase 09.

## Goal

The native app needs a stable, versioned, validated public URL with enough fields to reach full
parity. Today the site bakes data into HTML at build time, and `/ai/*` drops tags, score, vibes,
`venue_name` and image. This phase adds two feeds:

- `https://www.dothings.lol/data/v1/index.json`
- `https://www.dothings.lol/data/v1/{slug}.json`

Astro **static endpoints** generate both from `data/*.json` at build time. Nothing new is
committed, and the deploy workflow doesn't change.

## Preconditions

- Phase 04 is merged, so the web lives in `apps/web`. Phases 05 to 07 aren't required.
- PLAN Q6 (event identity) and Q7 (today time zone) are answered. The feed carries `id` = `eventHash` either way, so Q6 only changes what native keys storage by.

## Files affected

**New:**
- `packages/core/src/feed.ts`
- `packages/core/src/feed.test.ts`
- `apps/web/src/pages/data/v1/index.json.ts`
- `apps/web/src/pages/data/v1/[city].json.ts`
- `scripts/feed-report.mjs`

**Edited:**
- `packages/core/src/schema.ts` gains zod schemas.
- `packages/core/package.json` gains the dependency `zod: catalog:`.
- `.github/workflows/deploy.yml` gains a post-deploy smoke step.
- `.github/workflows/ci.yml` gains a feed report step.
- `CLAUDE.md` gains a short "Native data feed" subsection under "AI feed & MCP server".

## Contract

```ts
// packages/core/src/feed.ts
export const FEED_SCHEMA_VERSION = 1;          // bump only on breaking change; additive fields don't bump

export interface FeedIndex {
  schema_version: 1; generated_at: string;     // ISO, build time
  cities: { key: string; slug: string; name: string; timezone: string; locale: string; currency: string;
            week_start: string; week_end: string; data_as_of: string; url: string /* absolute */ }[];
}
export interface FeedCity {
  schema_version: 1; key: string; slug: string; name: string; timezone: string; locale: string; currency: string;
  week_start: string; week_end: string; generated_at: string; ranked_at: string | null;
  dropped: number;                              // events that failed validation (see "Validation policy")
  events: FeedEvent[];
}
export interface FeedEvent {
  id: string;            // eventHash: frozen, same as iCal UID / RSS guid / #cal= links
  slug: string;          // eventSlug, so native builds the same /{slug}/e/{eventSlug}/ URL as the web
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

Before freezing the field list, check each field against the parity checklist in PLAN §5. Every
field the checklist needs must be present, and anything no checklist item uses (the `venue`
tier, `_provider`) must be left out. Normalise `""` to `null`: `datetime_end_iso` can be `""` today.

## Validation policy (read before writing code)

`digest.yml` runs `pnpm build` **before** it commits. If the build fails, that week's collected
data is thrown away with the runner. So feed validation must never fail the build because of one
bad event:

- An event that fails `FeedEventSchema` is **dropped from the feed only**, still appears on the website, and is counted in `dropped`. The endpoint logs one line per dropped event, naming the title and the failing path. That follows "Name the suspect".
- The build fails only when the *index* is invalid, or when a city loses more than 20% of its events. At that point the payload is broken, not just one event.

## Steps

1. **Schemas.** Add zod schemas to `core/schema.ts` for `Event` and `CityPayload`. The `Event` schema must match what the pipeline actually emits, which PLAN §1.3 lists (vibes are always set, `score` is required after rank, and so on). Then run `node -e` over `data/*.json` to confirm the real files parse. Fix the schema, not the data.
2. **`feed.ts` + tests.**
   - Build a fixture that includes an event with `datetime_end_iso: ""` and an event missing its title, which should be dropped.
   - Assert that `id` equals the pinned `eventHash` for a known event, and reuse the pin from `shared.test.ts`.
   - Assert that `slug` matches `eventSlug`.
3. **Endpoints.**
   - Put the city endpoint at `apps/web/src/pages/data/v1/[city].json.ts`.
   - Implement `getStaticPaths` from `data/index.json` via `src/lib/paths.ts`. It returns one path per city slug.
   - Implement `GET`, which returns `new Response(JSON.stringify(toFeedCity(...)), { headers: { "content-type": "application/json" } })`.
   - The index endpoint follows the same pattern.
   - Confirm the output files are `apps/web/dist/data/v1/brisbane.json` and so on, not `…/brisbane.json/index.html`. `trailingSlash: "always"` should not apply to endpoints that have an extension, but verify this in `dist`.
4. **`scripts/feed-report.mjs`.** For each `dist/data/v1/*.json`, print the city, event count, dropped count, raw size and gzip size (`zlib.gzipSync`).
   - Emit a GitHub `::warning::` when the gzip size exceeds 400 KB.
   - Never exit non-zero on size, because growth isn't a defect.
   - Add it to `ci.yml` after `pnpm build`.
5. **Post-deploy smoke.** Add a final step to the `deploy.yml` `deploy` job:
   ```bash
   curl -sf https://www.dothings.lol/data/v1/index.json | node -e 'const j=JSON.parse(require("fs").readFileSync(0));if(j.schema_version!==1||!j.cities.length)process.exit(1);console.log(j.cities.map(c=>c.slug).join(" "))'
   ```
   The deploy job has no checkout, so this can't use the core schema. The build-time validation already covers it.
6. **Not advertised.** Leave `llms.txt`, `openapi.yaml` and `.well-known/api-catalog` unchanged. This feed is an app contract, not a public AI API. Revisit once it has proven stable.
7. **Docs.** In `CLAUDE.md`, describe the URL, the versioning rule (additive fields don't bump the version; renames and removals do and go under `/data/v2/`), and the validation policy, in 5 to 8 lines.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm check` | exit 0, with the new tests counted |
| V2 | Files emitted | `TZ=Australia/Brisbane pnpm build && ls apps/web/dist/data/v1/` | `index.json` plus one `.json` per city in `data/index.json` |
| V3 | Real data validates | `node scripts/feed-report.mjs apps/web/dist/data/v1` | every city has `dropped` = 0, or a handful with named reasons. Record the gzip sizes in the PR |
| V4 | Rest of the site unchanged | fingerprint diff, ignoring `./data/v1/*` lines (`grep -v '/data/v1/'` on both sides) | no other diff |
| V5 | Build survives a bad event | temporarily blank one event's `title` in `data/brisbane.json`, build, then `git checkout data/brisbane.json` | build passes, `dropped: 1`, and the log names the event |
| V6 | PR CI | `CI` | green, and the feed report is printed |

**After merge:**
```bash
curl -sI https://www.dothings.lol/data/v1/brisbane.json | grep -iE '^(HTTP|content-type|etag|cache-control|last-modified)'
curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}\n' https://www.dothings.lol/data/v1/brisbane.json
ETAG=$(curl -sI https://www.dothings.lol/data/v1/brisbane.json | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $ETAG" https://www.dothings.lol/data/v1/brisbane.json   # expect 304
```
Record the content type, ETag, cache-control and the 304. Phase 10's client relies on
conditional GET. The deploy smoke step must be green.

## Rollback

Revert the squash-merge. The URLs disappear on the next deploy. Nothing consumes them until phase 10.
