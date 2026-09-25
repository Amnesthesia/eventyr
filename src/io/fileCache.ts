// The pipeline's CacheStore for @dothingslol/llm: one JSON file per key under
// data/_cache/extractions, the directory adapters/extractionCache.ts wrote, so
// entries recorded before 1.6 stay valid (llm reads their `fields` form).

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
import type { CacheStore } from "@dothingslol/llm";
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
