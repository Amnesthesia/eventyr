# eventyr

Astro site + data pipeline that finds this week's local events (Brisbane, Gold Coast, Sunshine
Coast), ranks them by fit against a fixed interest profile, and publishes a static site + iCal
feeds at dothings.lol.

## Pipeline (mirrors `.github/workflows/digest.yml`, runs weekly via `weekly.yml`)

1. **`src/add_city.ts`** (one-off per city, `pnpm add-city`) — writes an empty
   `sources/{city}.yml` skeleton and registers the city in `digest.yml`'s dispatch options.
   It does NOT discover sources: that used to fan out to Anthropic, Perplexity and Google and
   merge the prose, which `discover.ts` later measured as worthless (see its header). Run
   `pnpm discover-sources` next, then `pnpm probe-sources`.
1a. **`src/adapters/discover.ts`** (`pnpm discover-sources [--city=X] [--apply]`) — asks Gemini
   for venues the city's list is missing, one grounded call per niche, all as `method: llm`.
1b. **`src/adapters/probe.ts`** (`pnpm probe-sources [--city=X] [--apply]`) — asks Gemini
   (Google-Search-grounded) where each source lists its events, fetches every suggested URL
   plus two canonical paths, and keeps only those that actually yield dated events. With
   `--apply`, promotes those sources to `method: scraper` in `sources/{city}.yml` with their
   verified `listingUrls`. Dry-run by default; prints every page tried and what came of it.
1c. **`src/adapters/collect.ts`** (`pnpm collect-adapters`) — runs before `collect`. Scrapes
   every `method: scraper` source (JSON-LD → embedded hydration JSON → LLM over page text),
   week-filters, maps to the pipeline event shape, annotates category/tags/vibes with one
   small Gemini call per source, writes one file per source to
   `data/{city}/adapters/curated/{id}.json`.
2. **`src/collection.ts`** (`pnpm collect [provider]`) — for each configured provider
   (anthropic/google/openai/perplexity), searches events per source tier and writes raw curated
   JSON to `data/{city}/{provider}/curated/{tier}[-music].json`. See "Provider architecture" below.
3. **`src/curate.ts`** (`pnpm curate`) — merges every provider/tier curated file for the current
   week (including the per-source scrape files), applies the publishing window, geocodes
   aggregator-tier locations to throw out other cities' events (`src/locality.ts`), dedupes via
   `src/dedupe.ts`, writes `data/{city}.json`.
4. **`src/rank.ts`** (`pnpm rank`) — Gemini scores each event 1–10 against `INTERESTS`
   (`src/common.ts`), writes scores back into `data/{city}.json`. `TOP_PICK_THRESHOLD` (7) decides
   what surfaces as a top pick.
5. **`src/geocode.ts`** (`pnpm geocode`) — dedupes event `location` strings, writes a Google Maps
   search `location_url` back onto each event in `data/{city}.json` (empty string if no location).
   No API key needed — it's a plain `maps.google.com/search` query URL, resolved live by Maps.
6. **`src/markdown.ts`**, **`src/ical.ts`**, **`src/rss.ts`**, **`src/pages.ts`** — generate
   `{CITY}.md`, `public/{city}.ics`, `public/{slug}/feed.xml`, and `data/index.json` /
   `public/sitemap.xml` respectively.
7. **`astro build`** — builds the site from `data/*.json` (via `app/` React components + Astro
   pages in `src/pages/`).

Each script reads `CITY` (city key matching a `sources/{city}.yml` file) from the environment.
`FORCE=true` bypasses the "already collected/curated this week" cache check.

## Provider architecture

`src/providers/base.ts` defines the abstract `BaseProvider`. Each concrete provider
(`anthropic.ts`, `google.ts`, `openai.ts`, `perplexity.ts`) declares a `tiers` list
(`aggregators`/`institutions`/`independents`, plus `open` for google/openai; perplexity is
`open`-only) and implements `searchEvents()`.

`BaseProvider.collect()` runs one search per tier. There used to be a second "music" pass per
tier, because a single mixed-category search spread one event budget across all six `CATEGORIES`
and `Concert / Music` lost out; music-heavy venues are now scraped directly, so that workaround
was removed rather than paying double the search calls for it.

A `method: scraper` source that returns nothing is recorded in
`data/{city}/adapters/barren.json` and handed back to the AI search for that run, so a rotted
listing URL degrades to search coverage rather than no coverage. A missing/stale barren report
is treated as "every scraper source is uncovered" — failing the other way would drop a source
from both paths at once.

**Only `method: llm` sources reach the search prompts** — `llmSourceStrings()` (`src/common.ts`)
filters them, so a source promoted to `method: scraper` disappears from the AI search by being
absent from the list, with no runtime exclusion logic anywhere.

## Source files

`sources/{city}.yml` is the single source of truth per city: three tiers
(aggregators/institutions/independents), each a list of entries carrying `name`, `method`
(`llm` | `scraper`), `domains`, and — for scraper sources — `listingUrls`, `strategy`,
`homepage`, `venue`, `note`. Those extra fields are kept on `llm` entries too, so promoting a
source is a one-field change. There is no separate adapters file.

Each file also carries a `centre` (`lat`, `lng`, `radiusKm`) — the locality check in `curate.ts`.
Adding a city means two coordinates and a radius, deliberately not a list of suburb names: a name
list has to be edited again every time another city is added, and the one that existed had already
needed a correction.

## Key files

- `src/shared.ts` — constants shared with the browser bundle (`CATEGORIES`, `CATEGORY_EMOJI`,
  `TOP_PICK_THRESHOLD`, `KEY_TO_SLUG`, `SITE_URL`). **Must stay free of `node:` imports** —
  `app/` code imports it directly, and pulling in `common.ts` (which reads the filesystem)
  breaks the Vite build.
- `src/common.ts` — `INTERESTS` (the fixed interest profile every prompt is built from),
  `loadCityConfig()`, `llmSourceStrings()`, `scraperSources()`, `curatedPath()`; re-exports
  everything from `shared.ts` so pipeline modules have one import site.
- `src/adapters/` — the scrape path: `probe.ts` (find/verify listing URLs), `fetch.ts`
  (`robots-parser` for robots.txt, rate limits, conditional GET), `extract.ts` (JSON-LD),
  `embeddedJson.ts`
  (Next.js/hydration state), `llmExtract.ts` (LLM over page text), `dates.ts` (all date
  parsing — never an LLM), `normalise.ts`, `annotate.ts`, `collect.ts`.
- `src/dedupe.ts` — cross-source dedupe: date blocking, deterministic matching, LLM only for
  the ambiguous minority. Strategy documented in the file header.
- `src/locality.ts` — geocodes locations (Google Geocoding API) so `curate.ts` can drop events a
  national source listed under this city. Aggregator/open tier only; once per distinct location
  ever, cached in `data/{city}/locations.json`; keeps the event whenever it cannot get an answer.
  Distinct from `src/geocode.ts`, which only builds the clickable Maps link and needs no key.
- `src/shared.ts` also owns event identity: `eventHash` (the basis for the iCal UID, the RSS guid
  and the share URL — **output is frozen**, pinned by `src/shared.test.ts`) plus `eventSlug` /
  `eventPath` for the per-event pages at `/{city}/e/{slug}`.
- `src/pages/[city]/e/[event].astro` — one pre-rendered page per event, so a shared link unfurls as
  that event. No React island; the unfurl crawlers run no JavaScript, which is the whole reason
  these are static rather than resolved client-side.
- `data/{city}/{provider}/curated/{tier}.json` — one file per provider × tier;
  `data/{city}/adapters/curated/{sourceId}.json` — one file per scraped source.
- `data/{city}.json` — final merged, deduped, ranked event list consumed by the site.

## Running locally

```bash
export CITY=brisbane   # or goldcoast, sunnycoast
# at least one search provider key:
export ANTHROPIC_API_KEY=...
export PERPLEXITY_API_KEY=...
export OPENAI_API_KEY=...
export GOOGLE_API_KEY=...   # required — also used for curation + ranking
export GOOGLE_MAPS_API_KEY=...   # optional — Geocoding API, for curate's locality check

pnpm probe-sources --city=$CITY      # find/verify listing URLs (add --apply to promote)
pnpm collect-adapters                # scrape method: scraper sources first
pnpm collect          # or: pnpm collect anthropic (single provider)
pnpm curate
pnpm rank
pnpm geocode
pnpm markdown
pnpm ical
pnpm rss
pnpm pages
pnpm build            # astro build
pnpm check            # both typechecks + biome + tests (what CI runs)

# Check what one page would contribute, without touching the pipeline:
pnpm test-adapter <url> [--raw] [--all]
```

## Implementation guidelines

Apply these to new code in this repo. They exist because each one has already cost a bug here.

### Calling models

- **Route every model call through the shared wrapper** (`src/providers/gemini.ts`). It is the only
  place that can bound concurrency across the process, back off on 429, enforce a budget, and say
  where the spend went. A per-module cap bounds nothing, because caps that cannot see each other
  add up.
- **Cache expensive results by content, not by URL.** The same page reached by two paths, two
  stages, or two runs must be paid for once (`src/adapters/extractionCache.ts`). Key on the input
  text plus a prompt version, so editing the prompt invalidates the cache.
- **Ask the cheap oracle first.** A site's own sitemap answers "where are the events listed?" for
  free and cannot invent a URL; only ask a grounded model about hosts it could not solve.
- **Match the effort to the question.** A yes/no gate needs the top of a page, not all of it, and a
  negative answer does not deserve a retry when negatives are the common case.

- **Batch, then run the batches concurrently, with a ceiling.** Use `mapWithConcurrency`
  (`src/providers/base.ts`). Never a serial loop over independent work; never a bare `Promise.all`
  over an unbounded list. Pick the ceiling from the provider's tolerance, not from the work size.
- **Prefer several small concurrent batches over one large batch.** Per-item accuracy drops as a
  batch grows, and concurrency recovers the wall-clock. When a batched answer proves unreliable for
  an item, fall back to a single focused call *for that item only* — fast path for the bulk,
  accurate path for the remainder.
- **Keep prompts cacheable.** Stable text (system instructions, interest profile, output format)
  comes from module constants and goes *first*; only the variable payload changes per call. Don't
  interpolate anything per-call into a prefix you want cached.
- **Spend the cheapest tier that can answer.** Deterministic parsing before any model call; a small
  model before a large one; a cheap gate before an expensive extraction. Skip work rather than
  optimise it — a signal check that costs nothing should decide whether a call happens at all.
- **Cap fan-out per unit of work.** One hostile input (a 400 KB page) must not be able to open
  arbitrarily many calls.
- **An empty result from a model is not an answer.** If the input plainly had content, treat empty
  as a failure and retry once. Silent empties are indistinguishable from real absence and poison
  every downstream decision.
- **Degrade, don't die, when an optional model is unavailable.** Missing key or failed call should
  fall back to the deterministic path with a warning.

### Trusting output

- **A model proposes; code decides.** Anything a model suggests (a URL, a match, a category) must be
  verified against reality, or constrained to a validated enum, before it is persisted.
- **Never let a model compute what we can compute.** Dates, arithmetic, IDs, and URL resolution are
  code's job. Extract the raw text with the model if you must, then parse it deterministically.
- **Prefer null over a guess.** A field we cannot establish is null. Never default, infer from a
  sibling field, or approximate — a wrong date on the site is worse than a missing event.
- **Echo an index through structured responses.** Key results by a numeric index you sent, never by
  name or by array position — names repeat and order drifts.

### Data integrity

- **Fail safe, not silent.** When state that gates coverage is missing or stale, assume the
  *expensive* branch (do the work) rather than the cheap one (skip it). Losing coverage while
  reporting success is the worst outcome available.
- **Distinguish "nothing there" from "failed to look".** These need different reporting and
  different remedies; collapsing them into `0` hides broken plumbing behind a plausible number.
- **Validate at trust boundaries.** Third-party HTML and model output are untrusted: scheme-check
  every URL that reaches the DOM, bound every path derived from external text, and cap response
  sizes.
- **Gates need positive evidence, not absence of failure.** "Nothing errored" is not verification;
  require a minimum quantity of the thing you actually want.
- **Every automated promotion needs an automated demotion.** A rule that can only add will
  accumulate stale state that no later run can correct.

### Observability

- **Report ratios, not totals.** `found → kept` with the reasons for the gap. A total alone cannot
  distinguish a healthy source from a broken one.
- **Name the suspect.** When a heuristic flags something, print the identifier and the input that
  triggered it, so the next action needs no re-derivation.
- **Persist what was discarded and why.** Diagnosis must never require re-running paid calls.
- **Log what worked to stdout; keep failures in files.** Console output is for decisions, not dumps.

### Long-running work

- **Flush incrementally.** Never write results only at the end. A killed run should keep everything
  it proved.
- **Make expensive phases re-derivable offline.** Cache raw results to disk and provide a mode that
  recomputes conclusions from that cache with no network and no model calls (`--report-only`), so
  tuning a threshold is free.
- **One writer per file.** Serialise writes to shared state; never let concurrent workers rewrite the
  same file.
- **Share the client that enforces limits.** Rate limiting and caching live in one shared instance,
  not per-call, or the limits are fiction.

### Libraries and style

- **Use a proven library for parsing and transport.** Dates, HTML, robots, TLS fingerprinting — all
  have correct implementations. Hand-rolled regex is a bug queue.
- **Verify an edit landed.** After a scripted edit, grep for the result before building on it.
- **Comment the why, especially the non-obvious.** Note the failure a guard prevents and the measured
  reason for a threshold. Mark deliberate shortcuts `ponytail:` with their ceiling and upgrade path.
