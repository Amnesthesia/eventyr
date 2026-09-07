# eventyr

Finds this week's events in Brisbane, the Gold Coast and the Sunshine Coast, ranks them against a
fixed interest profile, and publishes a static site plus iCal and RSS feeds at
[dothings.lol](https://www.dothings.lol).

Runs weekly in GitHub Actions. Everything is committed as JSON, so the site is a plain Astro build
over checked-in data.

## How events are found

Two paths, in this order:

1. **Scrape** (`method: scraper` sources) — we fetch the venue's own listing page and extract
   events deterministically. Preferred: it is cheap, exact, and does not hallucinate.
2. **LLM web search** (`method: llm` sources) — for everything with no verified listing page.

A source belongs to exactly one path. Promotion to `scraper` happens only after `probe-sources`
has fetched a candidate listing page and got real dated events out of it. Because the search
prompts are built from `method: llm` entries only, a promoted source disappears from the search by
being absent from the list — there is no runtime exclusion filter to fall out of sync.

If a scraper source returns nothing on a run it is recorded in
`data/{city}/adapters/barren.json` and handed back to the search for that run, so a rotted listing
URL degrades to search coverage rather than no coverage.

## Pipeline

Each stage reads `CITY` from the environment (`brisbane`, `goldcoast`, `sunnycoast`) and writes into
`data/`. `FORCE=true` bypasses the "already done this week" checks.

```bash
pnpm collect-adapters   # 1. scrape every method: scraper source
pnpm collect            # 2. LLM web search for the rest  (or: pnpm collect google)
pnpm curate             # 3. merge both paths, window-filter, dedupe → data/{city}.json
pnpm rank               # 4. score 1–10 against INTERESTS
pnpm geocode            # 5. add a Google Maps search URL per event
pnpm markdown           # 6. {CITY}.md
pnpm ical               # 7. public/{city}.ics
pnpm rss                # 8. public/{slug}/feed.xml
pnpm pages              # 9. data/index.json + public/sitemap.xml
pnpm build              # 10. astro build
```

`markdown`, `rss` and `pages` cover every city in one pass and need no `CITY`.

### Sharing one event

Every event also gets its own pre-rendered page at `/{city}/e/{title-slug}-{hash}` — 643 of them
today, built by `src/pages/[city]/e/[event].astro` in about a second.

They exist because a share link is only as good as its unfurl, and WhatsApp, iMessage and Slack run
no JavaScript: a link that needed the React app to resolve which event was meant would preview as
the generic city page. So each page carries its own `og:title`, `og:description`, `og:image` (the
event's own, where the source gave one — 139 of 395 in Brisbane) and a single `Event` JSON-LD
object, and it renders in full with JavaScript disabled.

The share control on a card is an `<a href>` to that page, progressively enhanced: with JavaScript
it opens the native share sheet, or copies the URL where that does not exist; without it, it is
just a link. Same for Add to calendar, which builds a single-event `.ics` in the browser
(`app/utils/ics.ts`).

The slug's trailing hash is `eventHash` from `src/shared.ts`, which is also the iCal `UID` and the
RSS `guid` — one identity, so a share URL, a calendar entry and a feed item all name the same
event. **Its output is frozen** and pinned by `src/shared.test.ts`: changing the basis or the
algorithm rewrites every UID and guid at once, which makes calendar clients re-add every event and
feed readers re-notify on all of them.

Event pages are indexed and in the sitemap at priority 0.5. That is safe because a hard 404 is not
a ranking penalty — it is the correct way to retire content with no replacement, and GitHub Pages
serves `404.html` with a real 404 status when an event rolls off. The thing to avoid is a *soft*
404 (HTTP 200 with "not found" content), which this setup cannot produce.

### The publishing window

**Today through the end of next week.** Past events are never kept — a Wednesday run must not
resurrect Monday's finished gigs — and next week's are kept deliberately, so a quiet week still has
something on it. The rule lives in `withinWindow`/`isPast` (`src/adapters/normalise.ts`) and is
applied to **both** paths: the scrape pass filters its own output, and `curate.ts` applies the same
filter to everything it merges. Events with no parsable date are kept, since they cannot be shown
to be past.

The digest runs **Sunday morning for the week starting Monday** (`getWeekRange` puts Sunday in the
coming week). So that Sunday's own events don't vanish the morning they are being planned around,
`curate.ts` also carries forward every still-upcoming event from the previous `data/{city}.json`
and dedupes it against the fresh results. Undated events are not carried (they could never expire);
everything else drops out via `isPast` on the following run.

### Is it even in this city?

Some sources are national despite being listed under one city: `musick.com.au` is a country-wide
gig guide, and its verified listing page put 40 Sydney, Melbourne, Adelaide and Perth events into
one Brisbane week. So `curate.ts` geocodes the location of every **`aggregators`- and
`open`-tier** event and throws out anything further from the city centre than its configured
radius:

```yaml
centre:            # sources/{city}.yml
  lat: -27.4698
  lng: 153.0251
  radiusKm: 50     # reaches Ipswich and Caboolture, excludes the Gold Coast and Toowoomba
```

`institutions` and `independents` are a venue's own site listing its own events, so they are
trusted and never geocoded — that is ~2/3 of locations never sent to the API. The known cost is a
handful of events a week from a venue that tours: last measured at 2 of 395 (0.5%), both Opera
Queensland/QTIX shows in Toowoomba. Widening the gate is one line in `dropOtherCities`.

Three rules keep this from being expensive or destructive (`src/locality.ts`):

- **Once per distinct location, ever.** The geocoder interface takes a list, so a caller cannot
  make it one request per event, and every answer is cached in `data/{city}/locations.json` — which
  is committed, so CI starts warm and steady state is only genuinely new venues. A recent Brisbane
  week was 85 distinct locations for 629 events.
- **Fail open.** No `GOOGLE_MAPS_API_KEY`, no `centre`, a failed request, or a location the
  geocoder cannot place all mean the event is kept. Absence of evidence is not evidence of
  elsewhere.
- **Geocoding API, not Places, and not an LLM.** Geocoding is $5/1,000 with 10,000 free a month;
  Places Text Search is ~6× for details we do not use, and handles bare venue names no better in
  practice ("The Zoo" and "Ric's Bar" both resolve to Fortitude Valley). A model asked to recall
  which suburb is in which city cannot be checked; a geocoder's answer can.

Note that the location is sent **exactly as it appears**, with no city appended. Appending the
publishing city was tried and is actively wrong — it gives the geocoder a fallback it latches onto,
and Toowoomba, Surfers Paradise and Newtown NSW all came back as "Brisbane QLD" at 0 km.

## Source configuration

`sources/{city}.yml` is the single source of truth per city. Three tiers
(`aggregators`, `institutions`, `independents`), each a list of entries:

```yaml
- name: The Tivoli
  method: scraper          # llm | scraper
  domains: [thetivoli.com.au]
  homepage: https://thetivoli.com.au/
  listingUrls: [https://thetivoli.com.au/events]
  strategy: html           # jsonld | html — descriptive, re-decided per page at fetch time
  schedule: weekly
  note: Verified by probe-sources 2026-09-02 …
```

`listingUrls`, `strategy`, `venue` and `note` are kept on `llm` entries too, so promoting or
demoting a source is a one-field change. Extra domains on one entry (aliases, typo'd variants,
ticketing hosts) keep dedupe and suppression recognising the same venue.

### Adding a city

```bash
CITY_NAME="Newcastle" CITY_KEY=newcastle pnpm add-city
```

Writes an empty `sources/{key}.yml` and adds the key to `digest.yml`'s dispatch options. It does
not discover anything — that is `discover-sources` below, which does the job better. Then set the
city's `centre` by hand (see above) and run discover + probe.

### Finding and verifying sources

```bash
pnpm discover-sources [--city=brisbane] [--apply]   # ask Gemini for sources we're missing
pnpm probe-sources    [--city=brisbane] [--apply]   # find + verify listing URLs, promote/demote
pnpm probe-sources --report-only --apply            # re-derive from cache: no network, no LLM
pnpm test-adapter <url> [--raw] [--all]             # what one page would contribute
```

`discover-sources` adds suggestions as `method: llm`; nothing is trusted until probed.

`probe-sources` asks Gemini (grounded in Google Search) where each source lists its events, fetches
every suggestion plus two canonical paths and the homepage, and promotes a source only if a page
yields **3+ dated events with 1+ inside the window**, and is not archive-dominated. Anything that
fails is demoted back to `method: llm`. Results are appended to `data/_probe/results.jsonl` per
source and promotions are flushed to the YAML every 20 sources, so an interrupted run keeps what it
proved. `--report-only` re-applies a changed gate against that cache for free.

## Reading the scrape report

The per-source line is built to distinguish a broken source from a quiet one:

```
✓ [musick]      2 page(s), 127 found → 83 in window  (42 undated, 2 later)
⚠ [doo-bop]     1 page(s),  30 found →  0 in window  (30 PAST)
      ⚠ every event on this page has already happened — the listing URL is probably an archive
⚠ [somewhere]   1 page(s),   0 found →  0 in window
      ⚠ fetched 1 page(s) but extracted nothing — extraction problem rather than an empty listing
```

- **`found` vs `in window`** — a big gap is only fine if it is `later`. Finding 100 and keeping 1 is
  a bad sign.
- **`PAST`** is the red flag: a listing page for upcoming events should not yield finished ones.
  Non-zero means the URL is probably an archive — re-probe or demote it.
- **`later`** is normal; a theatre lists its whole season.
- **`undated`** means the date text could not be parsed. Every dropped candidate, with the raw date
  string that failed, is written to `data/{city}/adapters/rejected/{source}.json` so this is
  diagnosable without re-running the extraction.

## Extraction strategies

`src/adapters/pageAdapter.ts` tries these in order, cheapest first, per page:

1. **JSON-LD** (`extract.ts`) — schema.org `Event` nodes. Deterministic and free.
2. **Embedded hydration JSON** (`embeddedJson.ts`) — `__NEXT_DATA__`, Next.js app-router flight
   data, Nuxt/Remix/SvelteKit state, any `application/json` blob. Recovers client-rendered pages
   whose HTML looks empty. Also deterministic and free.
3. **LLM over reduced page text** (`llmExtract.ts`) — last resort, capped at 4 calls per page.

**Dates are never taken from a model.** Whatever produced the fields, the date text goes through
`dates.ts` (chrono-node, British locale so `6/10` is 6 October) and anything it cannot parse
confidently stays null. Recurring language (`every Tuesday`) is refused outright rather than
resolved to a concrete day.

### Fetching

`src/adapters/fetch.ts` honours `robots.txt` for every request (via `robots-parser`, so `*` and
`$` patterns and Allow/Disallow precedence are handled per RFC 9309), rate-limits per host, retries
429/5xx with jittered backoff, and does conditional GETs. It uses `got-scraping` rather than
`fetch`: many venue sites sit behind Cloudflare, which fingerprints the TLS handshake — measured
against one site, `curl` with only a UA got 200 while Node's `fetch` with a full browser header set
got 403. No challenge-solving or proxy rotation is done, and none should be added: if a site
disallows us in `robots.txt`, we do not fetch it.

## Deduplication

`src/dedupe.ts`, called by `curate.ts` over the merged set from both paths. Three stages, cheapest
first, so the LLM only ever sees the ambiguous minority:

1. **Blocking** — bucket by calendar date (±1 day). Comparisons scale with events-per-day, not
   corpus size.
2. **Deterministic** — exact/prefix/Dice title matching within a bucket, plus a venue check so
   "Trivia Night" at two different venues is not merged.
3. **LLM** — only grey-zone pairs (similarity in a documented band), batched ~30 per call.

Survivor is the most complete record, tie-broken by original order. Without `GOOGLE_API_KEY` it
degrades to deterministic-only rather than failing — merging is the destructive direction, so
"keep both" is the safe fallback.

## Cost controls

Every Gemini call goes through `src/providers/gemini.ts`, which provides one process-wide
concurrency limiter, 429-aware backoff (honouring `Retry-After`), a hard call budget, and
per-stage accounting. Each script prints what it spent — including on Ctrl-C:

```
Gemini usage
  stage                     calls         in      out   cached  search
  probe/extract                12     39,045   28,138    4,074       0
  TOTAL                        12     39,045   28,138    4,074       0
```

Knobs:

| Env var | Default | Effect |
|---|---|---|
| `GEMINI_CONCURRENCY` | 4 | Concurrent Gemini calls across the whole process |
| `GEMINI_MAX_CALLS` | unlimited | Stops the run cleanly at this many calls; every long script is resumable, so it is a pause |
| `EVENTYR_DATA_ROOT` | `./data` | Relocate the data dir and its caches (used by tests) |
| `PROVIDERS` | all with keys | Allowlist of search providers, e.g. `google,anthropic` |
| `DISABLE_PROVIDERS` | — | Denylist, e.g. `openai`. Keys can stay set for providers left out |

**OpenAI is off by default.** `gpt-5` is the only OpenAI model with web search, and it is not worth
its cost for this task. Enable it with `PROVIDERS=google,anthropic,perplexity,openai` if that
changes.

**Anthropic is the most expensive provider per event by a wide margin** — measured at ~$0.055 per
event against Gemini's ~$0.0014, because web search bills $10 per 1,000 searches on top of tokens
and every raw search result lands in context as cache-write tokens. It is capped at 4 searches per
tier for that reason. Do **not** switch it to the dynamic-filtering tool version
(`web_search_20260209`) to save more: it cuts cache writes by ~85% and returns `NO_EVENTS_FOUND` on
every tier, measured at both 4 and 8 searches.

Measured effects of the current settings, on the same six Brisbane hosts:

- **Sitemap before search.** All six were solved from their own sitemaps, so the grounded
  discovery pass never ran: **12 calls, 0 grounded**. Grounded calls on the larger model are the
  expensive kind.
- **Extraction cache.** A repeat probe of those hosts: **12 calls → 2**. A `collect-adapters` run
  after a probe: **88 calls → 23, 81% of pages cached**.
- **Probe-mode extraction.** One batch per page instead of two, `MAX_EVALUATIONS` 2 instead of 6,
  and no retry-on-empty (during probing most candidate pages genuinely have no events, so retrying
  doubles the cost of confirming a negative).



- **Batch, then run batches concurrently, with a ceiling.** Every LLM pass goes through
  `mapWithConcurrency` (`src/providers/base.ts`). Nothing is serial that does not have to be, and
  nothing fans out unbounded — an uncapped `Promise.all` over dedupe batches could open ~67
  simultaneous calls and collect 429s.
- **Deterministic first.** JSON-LD and embedded JSON cost nothing; the LLM is the fallback, capped
  per page.
- **Prompt caching.** System instructions are module constants and stable across calls, and the
  interest profile and format rules are placed *first* in every prompt so provider prefix caching
  hits. Anthropic sets `cache_control` explicitly; OpenAI sets `prompt_cache_key`.
- **One search pass per tier.** There used to be a second "music" pass; music-heavy venues are
  scraped directly now, so it was removed rather than paying double.
- **Smaller batches with concurrency** beats one huge batch: accuracy per item stays high and
  wall-clock stays low.

## Running locally

```bash
pnpm install
export CITY=brisbane
export TZ=Australia/Brisbane     # week boundaries and "today" come from local time; CI pins this too
export GOOGLE_API_KEY=...        # required: curation, ranking, annotation, dedupe, probing
export GOOGLE_MAPS_API_KEY=...   # optional: Geocoding API, for the locality check above
export ANTHROPIC_API_KEY=...     # optional search providers
export OPENAI_API_KEY=...
export PERPLEXITY_API_KEY=...
```

`.env` in the repo root is picked up automatically by every script.

```bash
pnpm check   # both typechecks + biome + tests — what CI runs
pnpm test
pnpm dev     # astro dev server
```

## CI

- `.github/workflows/digest.yml` — reusable per-city workflow: typecheck/test → scrape → search →
  curate → rank → geocode → markdown → ical → rss → pages → build → commit. The scrape step is
  `continue-on-error` so an adapter failure degrades to search-only.
- `.github/workflows/weekly.yml` — runs the three cities in sequence, Sundays 06:00 AEST, for the
  week starting the next day.
- `.github/workflows/deploy.yml` — GitHub Pages.

## Data layout

```
sources/{city}.yml                            source of truth per city
data/{city}/{provider}/curated/{tier}.json    one file per search provider × tier
data/{city}/adapters/curated/{source}.json    one file per scraped source
data/{city}/adapters/barren.json              scraper sources that yielded nothing this week
data/{city}/adapters/rejected/{source}.json   dropped candidates + why  (gitignored)
data/{city}/locations.json                    geocoded locations, committed so CI starts warm
data/{city}.json                              merged, deduped, ranked — what the site reads
data/index.json                               per-city summary for the landing page
data/_probe/results.jsonl                     probe results cache  (gitignored)
data/_raw/, data/_cache/                      fetched bodies + ETags  (gitignored)
```

`curate.ts` discovers provider directories by walking `data/{city}/`, so a new collection path needs
no registration — just write `{city_key, provider, tier, week_start, week_end, events}`.

## Key files

- `src/shared.ts` — constants shared with the browser bundle. **Must stay free of `node:` imports**;
  `app/` imports it directly and pulling in `common.ts` (which reads the filesystem) breaks the Vite
  build.
- `src/common.ts` — `INTERESTS`, `loadCityConfig()`, `llmSourceStrings()`, `scraperSources()`;
  re-exports everything from `shared.ts`.
- `src/adapters/` — the scrape path: `probe.ts`, `discover.ts`, `collect.ts`, `fetch.ts`,
  `extract.ts`, `embeddedJson.ts`, `llmExtract.ts`, `dates.ts`, `normalise.ts`, `annotate.ts`.
- `src/dedupe.ts` / `src/dedupeClassifier.ts` — cross-source dedupe.
- `app/` — React components; `src/pages/` — Astro pages.
