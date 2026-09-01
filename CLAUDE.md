# eventyr

Astro site + data pipeline that finds this week's local events (Brisbane, Gold Coast, Sunshine
Coast), ranks them by fit against a fixed interest profile, and publishes a static site + iCal
feeds at dothings.lol.

## Pipeline (mirrors `.github/workflows/digest.yml`, runs weekly via `weekly.yml`)

1. **`src/add_city.ts`** (one-off per city, `pnpm add-city`) — LLM-discovers event source
   websites for a new city, sorted into `aggregators` / `institutions` / `independents` tiers,
   writes `sources/{city}.yml` (every new source starts as `method: llm`), registers the city
   in `digest.yml`'s dispatch options.
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
   week (including the per-source scrape files), dedupes via `src/dedupe.ts`, writes
   `data/{city}.json`.
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
`open`-only) and implements `searchEvents()` + `findSources()`.

`BaseProvider.collect()` runs one search per tier. There used to be a second "music" pass per
tier, because a single mixed-category search spread one event budget across all six `CATEGORIES`
and `Concert / Music` lost out; music-heavy venues are now scraped directly, so that workaround
was removed rather than paying double the search calls for it.

**Only `method: llm` sources reach the search prompts** — `llmSourceStrings()` (`src/common.ts`)
filters them, so a source promoted to `method: scraper` disappears from the AI search by being
absent from the list, with no runtime exclusion logic anywhere.

## Source files

`sources/{city}.yml` is the single source of truth per city: three tiers
(aggregators/institutions/independents), each a list of entries carrying `name`, `method`
(`llm` | `scraper`), `domains`, and — for scraper sources — `listingUrls`, `strategy`,
`homepage`, `venue`, `note`. Those extra fields are kept on `llm` entries too, so promoting a
source is a one-field change. There is no separate adapters file.

## Key files

- `src/common.ts` — `CATEGORIES`, `INTERESTS` (the fixed interest profile every prompt is built
  from), `loadCityConfig()`, `llmSourceStrings()`, `scraperSources()`, `KEY_TO_SLUG`, path
  helpers (`rawPath`, `curatedPath`).
- `src/adapters/` — the scrape path: `probe.ts` (find/verify listing URLs), `fetch.ts`
  (robots.txt, rate limits, conditional GET), `extract.ts` (JSON-LD), `embeddedJson.ts`
  (Next.js/hydration state), `llmExtract.ts` (LLM over page text), `dates.ts` (all date
  parsing — never an LLM), `normalise.ts`, `annotate.ts`, `collect.ts`.
- `src/dedupe.ts` — cross-source dedupe: date blocking, deterministic matching, LLM only for
  the ambiguous minority. Strategy documented in the file header.
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

# Check what one page would contribute, without touching the pipeline:
pnpm test-adapter <url> [--raw] [--all]
```
