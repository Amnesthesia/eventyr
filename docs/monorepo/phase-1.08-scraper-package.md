# Sub-phase 1.8 — `@dothingslol/scraper`: `scrape()`, parsers, render; LLM rung injected

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.8 (scraper package) of PR 1, the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` (especially §2.5 and §9) and `docs/monorepo/phase-1.08-scraper-package.md`,
> and no other phase files. Work on branch `monorepo/refactor`, even if your environment suggests
> another branch. If you can't push to it, stop and ask. Sync first per PLAN §4.3.
>
> Step 1 captures golden outputs from the unmoved code. Each numbered step is one commit. If
> context gets tight, stop after a completed step, push, and report.
>
> Run every verification. Post the results as a comment on the PR 1 draft and tick 1.8. If output
> parity fails, stop and report. Push, but don't merge, and don't start 1.9.

## Goal

Move deterministic scraping into `packages/scraper`: fetching with rate limits, conditional GET and
the HTTP cache, the site-feed parsers, iCal, JSON-LD, hydration JSON, readable text, date parsing,
candidates, the extraction ladder, detail-page enrichment, and Playwright rendering.

- **Public API:** `scrape(url, opts)` is the entry point. `@dothingslol/scraper/parsers` exposes the pure parsers.
- **No LLM code.** The LLM rung (`llmExtract`) becomes the `fallback` callback, which the pipeline supplies.
- **No knowledge of `data/`, cities or `sources/*.yml`.** Everything comes in through options.
- **Output is identical** on recorded pages.

## Preconditions

- 1.7 is committed on the branch.

## What moves (`git mv` where a whole file moves)

| From `src/adapters/` | To `packages/scraper/src/` | Notes |
|---|---|---|
| `fetch.ts` (+ test) | `fetch.ts` | `got-scraping`. The conditional-GET cache store is **injected** (`HttpCacheStore`). The pipeline supplies a file store at `data/_cache` and `data/_raw`, at the same paths, keys and format, so the Actions cache stays valid. robots.txt behaviour is unchanged; see the file header. |
| `feeds.ts` (+ test) | `parsers/feeds.ts` | Exports `parseFeed`, `parseIcal`, `apiRequestFor`, `feedUrlsFromHtml`, `wpJsonRoutesToFeedUrls`. It also exports named wrappers `parseTrumbaJson`/`parseTrumbaAtom` over the existing internal functions, with no behaviour change. |
| `extract.ts` (+ test) | `parsers/jsonLd.ts` | Adds `parseJsonLd(html)`, which composes the existing `extractJsonLdBlocks` → `findEventNodes` → `jsonLdNodeToRawFields`. |
| `embeddedJson.ts` (+ test) | `parsers/embeddedJson.ts` | Adds `parseEmbeddedJson` over the existing functions. |
| `readableText.ts` (+ test) | `parsers/text.ts` | Exports `htmlToText` = `stripToReadableText`, plus `densestWindow`. |
| `dates.ts` (+ test) | `parsers/dates.ts` | Gains an **optional** `timeZone` parameter that defaults to today's fixed +10 (`BRISBANE_UTC_OFFSET_HOURS`). No DST logic yet; 1.10 adds it (D12). |
| `candidate.ts`, the scrape-related types from `types.ts` | `candidate.ts`, `types.ts` | `RawCandidateFields`, `CandidateEvent`, provenance. `SourceDefinition` stays in the pipeline. |
| `pageAdapter.ts`, `runner.ts` (+ tests) | `ladder.ts`, `runner.ts` | `scrape()` is built on the existing `createPageAdapter(deps)`. |
| `enrichTimes.ts` (+ test) | `enrich.ts` | Its fetcher is already injected. `mapWithConcurrency` comes from utils. |
| `render.ts`, browser half (`renderFetch`, `closeRenderBrowser`, `looksEventish`, `countRenderedDateHits`, the Playwright launch) | `render.ts` (subpath `/render`) | Playwright becomes an optional peer dependency, loaded lazily. With no browser, it warns and degrades, as today. The **source-promotion half** (`renderTargets`, `applyCandidates`, the YAML edits, the `data/_probe` writes) stays in the pipeline. |

**Staying in the pipeline** (these files remain in `src/adapters/` until 1.11):
- `collect.ts`
- `llmExtract.ts` (becomes the `fallback`)
- `annotate.ts`
- `normalise.ts` (maps `CandidateEvent` → `Event`, a domain concern)
- `registry.ts`
- `probe.ts`
- `discover.ts`
- `triage.ts`
- `testUrl.ts`
- the promotion half of `render.ts`

## Steps

1. **Golden outputs.**
   - Pick about 20 page fixtures covering: every `FeedFormat` (events-calendar, modern-events-calendar, squarespace, trumba-json, trumba-atom, opendatasoft, fivestar, reading-cinemas, palace, ical), JSON-LD, hydration JSON, a page that falls through to the LLM rung, a 304, and a blocked response.
   - Take them from `data/_raw` (local, or restored from the Actions cache), or fetch each once. Trim each to the minimum that still exercises its parser (PLAN R18).
   - Store them under `packages/scraper/test/fixtures/` with a `manifest.json` of `{url, status, headers, bodyFile}`.
   - Write `scripts/scrape-parity.mjs`. It runs the **old** `createPageAdapter` with a fake fetcher that serves the fixtures and a stub LLM fallback that returns a fixed marker candidate. It writes `test/golden/scrape/<fixture>.json` containing candidates, rejections, provenance and diagnostics.
   - Commit the fixtures, script and goldens on their own.
2. **Scaffold `packages/scraper`.**
   - `name` is `@dothingslol/scraper`. `exports`: `"."`, `"./parsers"`, `"./render"`.
   - Dependencies: `got-scraping`, `chrono-node`, `fast-xml-parser`, `ical.js` if a parser uses it (check with grep), `@dothingslol/utils`.
   - Peer dependency: `playwright`, optional.
   - Add its row to `check-boundaries.mjs`: it may depend on `utils` only.
3. **Moves.** One rename-only commit for the whole-file moves, then a commit that splits `render.ts` and adjusts imports.
4. **`scrape()`.** Implement it per PLAN §2.5 as a thin composition of the moved code. The `fetcher` defaults to a shared instance, so rate limits are process-wide, the same as today. `status` separates `not-modified`, `blocked` and `failed` from `ok`.
5. **Rewire the pipeline side.**
   - `adapters/collect.ts` calls `scrape(url, { strategy, fetcher, fallback: llmExtractFallback, timeZone: undefined })`. Leaving `timeZone` undefined keeps today's +10 until 1.10.
   - `probe.ts`, `triage.ts`, `testUrl.ts` and the promotion half of `render.ts` import from `@dothingslol/scraper` and `@dothingslol/scraper/parsers`.
   - The pipeline's `src/io/httpCache.ts` implements `HttpCacheStore` over `data/_cache` and `data/_raw`.
6. **Parity.**
   - Point `scripts/scrape-parity.mjs` at the new `scrape()`, with the same fake fetcher and stub fallback, then `git diff --exit-code test/golden/scrape`.
   - Also run `pnpm test-adapter <fixture-url>` in replay mode. That means a fixture-serving fetcher selected by `EVENTYR_SCRAPE_FIXTURES=<dir>`, a seam added in this step. Compare its printed summary with `origin/main`'s output for the same fixture.
7. **`CLAUDE.md`.** Update "Key files → `src/adapters/`" to describe the new split: scraping lives in `@dothingslol/scraper`, and the pipeline keeps the domain mapping and source maintenance. Update the pipeline step 1c text to say that collect-adapters calls `scrape()`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0. Adapter test count is unchanged (tests moved with their files) |
| V2 | **Output parity** | `node scripts/scrape-parity.mjs && git diff --exit-code test/golden/scrape` | no diff |
| V3 | LLM-free | `grep -rn "@dothingslol/llm\|@google/genai" packages/scraper` | nothing |
| V4 | Path-free | `grep -rnE "DATA_ROOT\|PROJECT_ROOT\|process\.env\.CITY\|sources/" packages/scraper/src` | nothing |
| V5 | Cache compatibility | test: a `data/_cache` entry written by the old `fetch.ts` produces a conditional GET (`If-None-Match`) through the new fetcher and store | passes |
| V6 | No browser degrades | `CHROME_PATH=/nonexistent pnpm collect-adapters --only=<a render-strategy fixture>` against the fixture data root | warning, and continues, the same as `origin/main` |
| V7 | Boundaries | `node scripts/check-boundaries.mjs` | exit 0 |
| V8 | PR CI | `CI` | green |

## Rollback

Revert this sub-phase's commits on the branch.
