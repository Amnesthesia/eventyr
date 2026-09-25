# Sub-phase 2.2: Public data feed and collection metadata for the native app

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

Both are Astro **static endpoints**, generated from `data/*.json` at build time.

It also adds **collection metadata** (D16, PLAN §8a): the pipeline writes a per-city run record,
`data/{city}/run.json`. **`data/index.json` is renamed to `data/manifest.json`** and gains the aggregated collection metadata (PLAN §8a). The public feed index exposes a `collection` block per city (last collected,
next scheduled run, status, event count) that app Settings shows. This is the only part of 2.2
that touches the pipeline and a workflow. The URLs go live only when PR 2 merges (PLAN
R10). Until then, native development reads a local preview of the site.

## Preconditions

- 2.1 is committed on `native/app`.

## Files affected

- **New:**
  - `packages/core/src/feed.ts` and `packages/core/src/feed.test.ts`
  - `packages/core/src/runRecord.ts` (the `RunRecord` zod schema and type), plus its test
  - `apps/pipeline/src/io/runRecord.ts` (the run-record writer)
  - `packages/core/src/manifest.ts` (the `Manifest` zod schema and type, and `isCityPayloadFile()`)
  - `apps/web/src/pages/data/v1/index.json.ts` and `apps/web/src/pages/data/v1/[city].json.ts`
  - `scripts/feed-report.mjs`
- **Edited:**
  - `packages/core/src/schema.ts`: the zod schemas exist from 1.2 (tests only). This sub-phase starts using them at runtime in the feed endpoints.
  - The pipeline CLIs for `collect-adapters`, `collect`, `curate`, `venues`, `rank`, `geocode` and `build-ai`: each updates its stage entry in the run record.
  - `apps/pipeline/config/pipeline.yml`: `schedule.weekly`.
  - **Rename** `data/index.json` → `data/manifest.json` (`git mv`), then update:
    - `apps/pipeline/src/publish/pages.ts`, the manifest's only writer
    - the city-discovery filters in `publish/pages.ts`, `publish/markdown.ts` and `publish/ai.ts` (they were `pages.ts:82`, `markdown.ts:115` and `ai.ts:633`), plus any other `readdirSync(DATA_ROOT)` filter found with `grep -rn '"index.json"' apps packages`
    - `apps/web/src/lib/paths.ts` and the web pages that read it
    - `digest.yml`'s `git add`
    - `CLAUDE.md`
  - `.github/workflows/digest.yml`: a final "Finalise run record" step (`if: always()`, before the commit step).
  - `.github/workflows/deploy.yml`: a post-deploy smoke step.
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
export function toFeedEvent(e: EventData, citySlug: string): FeedEvent | null;   // null when invalid
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

1. **Schemas.** `EventDataSchema` and `CityPayloadSchema` already exist in core (1.2) and are proven against real data by `schema.data.test.ts`. Reuse them. Don't redefine them.
   - Tree-shaking keeps zod out of the web client bundle, because the web imports only types on the client. Verify this in V4.
2. **`feed.ts` with tests.** Use fixtures that include `datetime_end_iso: ""` and an event with no title.
   - `id` must equal the pinned `eventHash` from `shared.test.ts`.
   - `slug` must equal `eventSlug`.
3. **Endpoints.** `[city].json.ts`:
   - `getStaticPaths` builds one path per city, from `data/manifest.json` via `src/lib/paths.ts`.
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
5b. **Run record (D16).**
   - **Schema.** `core/runRecord.ts` holds the `RunRecord` zod schema, the per-city record that becomes a manifest `collection` block (PLAN §8a).
   - **Writer.** `apps/pipeline/src/io/runRecord.ts` owns `data/{city}/run.json`. It's the only writer, and each CLI calls it at the end of its stage.
     - The first stage of a run (`collect-adapters`) sets `started_at`, `trigger` (from `GITHUB_EVENT_NAME`), `git_sha` (from `GITHUB_SHA`), `week_*` and `status: "partial"`, and clears `completed_at`.
     - Each stage then updates its `stages.<name>` entry: `ok`, `durationMs`, and counts taken from its typed result (`ScrapeResult` / `SearchCollectResult` / `StageReport`).
     - The LLM totals come from `usageTotals()`.
     - Every write is flushed immediately, so a killed run leaves a truthful record.
   - **Finalise.** A new `pnpm finalise-run` CLI runs as a `digest.yml` step with `if: always()`, placed before "Commit data files".
     - It sets `completed_at`, and sets `status` to `complete` if every stage entry is `ok`, otherwise `failed` or `partial`.
     - `data/${CITY}/` is already in the commit step's `git add` list. Confirm that `run.json` is included and not gitignored.
   - **Schedule.** Add `schedule.weekly: "0 20 * * 6"` to `pipeline.yml`, plus a test that reads `.github/workflows/weekly.yml` and asserts the cron matches.
   - **Manifest (PLAN §8a).**
     - `git mv data/index.json data/manifest.json`.
     - `publish/pages` writes every existing field **unchanged**, plus `schema_version`, `generated_at_iso`, `schedule` and each city's `collection`, copied from `data/{city}/run.json`. A missing record gives `null`, meaning "not recorded yet", which is distinct from `status: "failed"`.
     - Put the city-discovery rule in one helper, `isCityPayloadFile(name)` in core. Use it in pages, markdown and ai.
     - Test that `manifest.json`, `index.json` and `*_raw.json` are never parsed as cities.
   - **Feed index endpoint.** Read `data/manifest.json` and emit per city:
     ```jsonc
     "collection": {
       "last_collected_at": "…",           // manifest collection.last_collected_at
       "status": "complete",
       "events_published": 718,
       "next_collection_at": "…",          // recomputed at build time from schedule.cron with a small cron-next helper in core (5-field, UTC; test Saturday-evening edges)
       "data_as_of": "…"
     }
     ```
   - **Stays internal.** Token counts, cost, git SHA, trigger and per-stage detail stay in `run.json` and `manifest.json`, which are never served. They are **not** copied into the public feed.
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
| V6b | Run record | In a temporary `EVENTYR_DATA_ROOT`, run `collect-adapters` and `curate` in replay mode (1.6 harness), kill the next stage mid-way, then run `finalise-run` | `run.json` validates against `RunRecordSchema`, `status` is `partial` or `failed`, and the completed stages are recorded |
| V6c | Collection block | build, then `jq '.cities[].collection' apps/web/dist/data/v1/index.json` | `next_collection_at` is the next Saturday 20:00 UTC after build time, and there are no token or cost fields |
| V6d | Schedule drift guard | change the cron in `weekly.yml` locally, then run tests | the test fails; revert |
| V6e | Manifest compatibility | `jq 'del(.schema_version,.generated_at_iso,.schedule) \| .cities \|= map(del(.collection))' data/manifest.json` compared with `git show origin/main:data/index.json` after rerunning `pnpm pages` on the same data | identical, so existing fields are unchanged |
| V6f | Not parsed as a city | `pnpm markdown && pnpm rss && pnpm build-ai`, then `git status` | no `MANIFEST.md` and no `manifest` city in any output |
| V6g | Web still reads it | build + fingerprint diff (ignoring `/data/v1/*`) | no diff |
| V7 | PR CI | `CI` | green, with the feed report printed |

The live checks (content type, ETag, a 304 on `If-None-Match`, the deploy smoke step) are in the 2.9 runbook.

## Rollback

Revert this sub-phase's commits on the branch.
