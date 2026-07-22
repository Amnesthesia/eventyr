# eventyr

Astro site + data pipeline that finds this week's local events (Brisbane, Gold Coast, Sunshine
Coast), ranks them by fit against a fixed interest profile, and publishes a static site + iCal
feeds at dothings.lol.

## Pipeline (mirrors `.github/workflows/digest.yml`, runs weekly via `weekly.yml`)

1. **`src/add_city.ts`** (one-off per city, `pnpm add-city`) — LLM-discovers event source
   websites for a new city, sorted into `aggregators` / `institutions` / `independents` tiers,
   writes `sources/{city}.yml`, registers the city in `digest.yml`'s dispatch options.
2. **`src/collection.ts`** (`pnpm collect [provider]`) — for each configured provider
   (anthropic/google/openai/perplexity), searches events per source tier and writes raw curated
   JSON to `data/{city}/{provider}/curated/{tier}[-music].json`. See "Provider architecture" below.
3. **`src/curate.ts`** (`pnpm curate`) — merges every provider/tier curated file for the current
   week, dedupes by fuzzy title+date match (Dice coefficient), writes `data/{city}.json`.
4. **`src/rank.ts`** (`pnpm rank`) — Gemini scores each event 1–10 against `INTERESTS`
   (`src/common.ts`), writes scores back into `data/{city}.json`. `TOP_PICK_THRESHOLD` (7) decides
   what surfaces as a top pick.
5. **`src/geocode.ts`** (`pnpm geocode`) — dedupes event `location` strings, writes a Google Maps
   search `location_url` back onto each event in `data/{city}.json` (empty string if no location).
   No API key needed — it's a plain `maps.google.com/search` query URL, resolved live by Maps.
6. **`src/markdown.ts`**, **`src/ical.ts`**, **`src/pages.ts`** — generate `{CITY}.md`,
   `public/{city}.ics`, and `data/index.json` / `public/sitemap.xml` respectively.
7. **`astro build`** — builds the site from `data/*.json` (via `app/` React components + Astro
   pages in `src/pages/`).

Each script reads `CITY` (city key matching a `sources/{city}.yml` file) from the environment.
`FORCE=true` bypasses the "already collected/curated this week" cache check.

## Provider architecture

`src/providers/base.ts` defines the abstract `BaseProvider`. Each concrete provider
(`anthropic.ts`, `google.ts`, `openai.ts`, `perplexity.ts`) declares a `tiers` list
(`aggregators`/`institutions`/`independents`, plus `open` for google/openai; perplexity is
`open`-only) and implements `searchEvents()` + `findSources()`.

**Music split:** `BaseProvider.collect()` runs each tier through *two* passes —
`focus: "general"` (excludes concerts/gigs/live music) and `focus: "music"` (searches only for
live music, no "prefer niche over mainstream" filtering). This exists because a single
mixed-category search shares one event-count budget and one web-search budget across all six
`CATEGORIES` (`src/common.ts`), so `Concert / Music` was consistently under-represented — splitting
gives each its own budget. The music pass writes to a separate output file
(`{tier}-music.json` via `curatedPath`), so it roughly doubles search-call volume/cost per
provider/tier. `curate.ts` strips the `-music` suffix before venue-tier lookup so merging still
works transparently.

## Key files

- `src/common.ts` — `CATEGORIES`, `INTERESTS` (the fixed interest profile every prompt is built
  from), `loadCityConfig()`, path helpers (`rawPath`, `curatedPath`).
- `sources/{city}.yml` — per-city source list, three tiers (aggregators/institutions/independents).
- `data/{city}/{provider}/curated/{tier}[-music].json` — one file per provider × tier × focus for
  the current week.
- `data/{city}.json` — final merged, deduped, ranked event list consumed by the site.

## Running locally

```bash
export CITY=brisbane   # or goldcoast, sunnycoast
# at least one search provider key:
export ANTHROPIC_API_KEY=...
export PERPLEXITY_API_KEY=...
export OPENAI_API_KEY=...
export GOOGLE_API_KEY=...   # required — also used for curation + ranking

pnpm collect          # or: pnpm collect anthropic (single provider)
pnpm curate
pnpm rank
pnpm geocode
pnpm markdown
pnpm ical
pnpm pages
pnpm build            # astro build
```
