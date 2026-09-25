// The pipeline's CacheStore for @dothingslol/llm — one JSON file per key
// under data/_cache/extractions — and the page-level extraction cache built
// on it (was adapters/extractionCache.ts; same keys, same entries, so nothing
// recorded before 1.6 is lost).

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CacheStore, cacheKey } from "@dothingslol/llm";
import type { PageExtractFn, RawCandidateFields } from "../adapters/types.ts";
import { DATA_ROOT } from "../common.ts";

export const EXTRACTION_CACHE_DIR = join(DATA_ROOT, "_cache", "extractions");

/**
 * Entries untouched for this long are deleted on the first write of a run. The
 * cache persists between CI runs (actions/cache), and a listing page's text
 * changes most weeks, so stale entries would otherwise accumulate without
 * bound.
 */
const MAX_AGE_DAYS = 60;

export function createFileCache(dir = EXTRACTION_CACHE_DIR): CacheStore {
	let pruned = false;
	function pruneOnce(): void {
		if (pruned) return;
		pruned = true;
		try {
			const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
			let removed = 0;
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).mtimeMs < cutoff) {
					unlinkSync(path);
					removed++;
				}
			}
			if (removed > 0) {
				console.log(
					`  → [extraction-cache] pruned ${removed} entr${removed === 1 ? "y" : "ies"} older than ${MAX_AGE_DAYS} days`,
				);
			}
		} catch {
			// no cache dir yet, or unreadable — nothing to prune
		}
	}
	// Keys are hex digests from llm; guard the path anyway, the store is the
	// trust boundary between a key and the filesystem.
	const pathFor = (key: string): string => {
		if (!/^[a-f0-9]{16,64}$/.test(key)) throw new Error(`bad cache key ${key}`);
		return join(dir, `${key}.json`);
	};
	return {
		async get(key) {
			const path = pathFor(key);
			if (!existsSync(path)) return null;
			try {
				return JSON.parse(readFileSync(path, "utf-8"));
			} catch {
				return null; // unreadable entry — a miss, re-ask
			}
		},
		async set(key, entry) {
			mkdirSync(dir, { recursive: true });
			pruneOnce();
			writeFileSync(pathFor(key), JSON.stringify(entry), "utf-8");
		},
	};
}

/**
 * Bump when the extraction prompt or the shape of RawCandidateFields changes,
 * so a prompt edit invalidates the cache instead of serving results the new
 * prompt would not have produced.
 */
const PROMPT_VERSION = "v3";

/** The entry shape adapters/extractionCache.ts wrote: the page's parsed
 * fields, not the raw answer. Kept, so old entries and new ones are one
 * format (llm reads it too, as JSON, through `ask({ cache })`). */
interface ExtractionEntry {
	promptVersion: string;
	sourceName: string;
	textLength: number;
	extractedAt: string;
	fields: RawCandidateFields[];
}

export interface CacheStats {
	hits: number;
	misses: number;
}

/**
 * Caches a PageExtractFn's result by page content, so the same page is never
 * extracted twice: probe evaluates a candidate page, collect-adapters scrapes
 * that same page minutes later, and a resumed probe pays a third time — the
 * fetched bodies were already cached on disk, only the expensive part was
 * thrown away. Keyed on the reduced page text rather than the URL, so a site
 * serving one listing at two paths (/events and /whats-on were byte-identical
 * on thetivoli.com.au) is extracted once.
 *
 * Page-level rather than per model call on purpose: a page's extraction is
 * several calls plus a retry, and "this page has no events" is the considered
 * answer worth caching, not any one call's.
 *
 * `force` skips reads but still writes, so a forced run re-extracts once and
 * everything downstream of it in the same run reuses that result.
 */
export function withExtractionCache(
	extract: PageExtractFn,
	opts: { force?: boolean; store?: CacheStore } = {},
): PageExtractFn & { stats: CacheStats } {
	const store = opts.store ?? createFileCache();
	const stats: CacheStats = { hits: 0, misses: 0 };

	const wrapped = async (
		pageText: string,
		sourceName: string,
	): Promise<RawCandidateFields[]> => {
		const key = cacheKey(PROMPT_VERSION, pageText);
		if (!opts.force) {
			const entry = (await store.get(key)) as Partial<ExtractionEntry> | null;
			// The key already contains the prompt version; this check catches a
			// hand-edited or truncated cache file.
			if (
				entry?.promptVersion === PROMPT_VERSION &&
				Array.isArray(entry.fields)
			) {
				stats.hits++;
				return entry.fields;
			}
		}

		stats.misses++;
		const fields = await extract(pageText, sourceName);
		// An empty result is cached too: "this page has no events" is a real
		// answer and re-asking costs the same as asking. The retry-on-empty in
		// llmExtract has already run by this point, so what lands here is the
		// considered answer, not a dropped call.
		try {
			const entry: ExtractionEntry = {
				promptVersion: PROMPT_VERSION,
				sourceName,
				textLength: pageText.length,
				extractedAt: new Date().toISOString(),
				fields,
			};
			await store.set(key, entry);
		} catch (err) {
			console.error(
				`  ⚠ [extraction-cache] could not write: ${(err as Error).message}`,
			);
		}
		return fields;
	};

	return Object.assign(wrapped, { stats });
}
