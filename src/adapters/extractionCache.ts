// Caches LLM extraction results by page content, so the same page is never
// extracted twice.
//
// Three separate things were paying for the same work: probe evaluates a
// candidate page, collect-adapters then scrapes that same page minutes later
// from the same persisted body, and a resumed or re-run probe pays a third
// time. The fetched bodies were already cached on disk with ETags; only the
// expensive part — the extraction — was thrown away.
//
// Keyed on the reduced page text rather than the URL, so a site serving one
// listing at two paths (/events and /whats-on were byte-identical on
// thetivoli.com.au) is extracted once.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "../common.ts";
import type { PageExtractFn, RawCandidateFields } from "./types.ts";

/**
 * Bump when the extraction prompt or the shape of RawCandidateFields changes,
 * so a prompt edit invalidates the cache instead of serving results the new
 * prompt would not have produced.
 */
const PROMPT_VERSION = "v1";

const CACHE_DIR = join(DATA_ROOT, "_cache", "extractions");

interface CacheEntry {
	promptVersion: string;
	sourceName: string;
	textLength: number;
	extractedAt: string;
	fields: RawCandidateFields[];
}

function keyFor(pageText: string): string {
	return createHash("sha1")
		.update(`${PROMPT_VERSION}\n${pageText}`)
		.digest("hex");
}

function pathFor(pageText: string): string {
	return join(CACHE_DIR, `${keyFor(pageText)}.json`);
}

export interface CacheStats {
	hits: number;
	misses: number;
}

/**
 * Wraps a PageExtractFn with the on-disk cache.
 *
 * `force` skips reads but still writes, so a forced run re-extracts once and
 * everything downstream of it in the same run reuses that result.
 */
export function withExtractionCache(
	extract: PageExtractFn,
	opts: { force?: boolean } = {},
): PageExtractFn & { stats: CacheStats } {
	const stats: CacheStats = { hits: 0, misses: 0 };

	const wrapped = async (
		pageText: string,
		sourceName: string,
	): Promise<RawCandidateFields[]> => {
		const path = pathFor(pageText);

		if (!opts.force && existsSync(path)) {
			try {
				const entry = JSON.parse(readFileSync(path, "utf-8")) as CacheEntry;
				// The key already contains the prompt version; this check catches a
				// hand-edited or truncated cache file.
				if (
					entry.promptVersion === PROMPT_VERSION &&
					Array.isArray(entry.fields)
				) {
					stats.hits++;
					return entry.fields;
				}
			} catch {
				// unreadable entry — fall through and re-extract
			}
		}

		stats.misses++;
		const fields = await extract(pageText, sourceName);
		// An empty result is cached too: "this page has no events" is a real
		// answer and re-asking costs the same as asking. The retry-on-empty in
		// llmExtract has already run by this point, so what lands here is the
		// considered answer, not a dropped call.
		try {
			mkdirSync(CACHE_DIR, { recursive: true });
			const entry: CacheEntry = {
				promptVersion: PROMPT_VERSION,
				sourceName,
				textLength: pageText.length,
				extractedAt: new Date().toISOString(),
				fields,
			};
			writeFileSync(path, JSON.stringify(entry), "utf-8");
		} catch (err) {
			console.error(
				`  ⚠ [extraction-cache] could not write: ${(err as Error).message}`,
			);
		}
		return fields;
	};

	return Object.assign(wrapped, { stats });
}
