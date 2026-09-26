// The pipeline's HttpCacheStore for @dothingslol/scraper: conditional-GET
// validators in data/_cache/{sourceId}.json (one JSON object keyed by URL)
// and response bodies in data/_raw/{sourceId}/. Same paths, keys and file
// names as the fetcher wrote before the move, so the Actions cache stays
// valid and nothing recorded before 1.8 is lost.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpCacheEntry, HttpCacheStore } from "@dothingslol/scraper";
import { adapterCachePath, adapterRawDir } from "../common.ts";

type Cache = Record<string, HttpCacheEntry>;

function loadCache(sourceId: string): Cache {
	const path = adapterCachePath(sourceId);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Cache;
	} catch {
		return {};
	}
}

function slugForUrl(url: string): string {
	return url
		.replace(/^https?:\/\//, "")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.slice(0, 120);
}

function extensionForContentType(contentType: string | null): string {
	if (!contentType) return "bin";
	if (contentType.includes("json")) return "json";
	if (contentType.includes("xml") || contentType.includes("rss")) return "xml";
	if (contentType.includes("calendar")) return "ics";
	return "html";
}

export function createHttpCacheStore(): HttpCacheStore {
	// Maintain the cache in memory exactly like the pre-1.8 SourceFetcher did
	// (it loaded once per fetch and mutated the object), to preserve the exact
	// same first-fetch behaviour where concurrent saves overwrite each other.
	const active = new Map<string, Cache>();

	const getCache = (sourceId: string) => {
		let cache = active.get(sourceId);
		if (!cache) {
			cache = loadCache(sourceId);
			active.set(sourceId, cache);
		}
		return cache;
	};

	return {
		get(sourceId, url) {
			return getCache(sourceId)[url];
		},
		set(sourceId, url, entry) {
			const cache = getCache(sourceId);
			cache[url] = entry;
			const path = adapterCachePath(sourceId);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
		},
		// ponytail: writes one file per URL per run with no pruning — data/_raw
		// is gitignored and grows unboundedly (6 GB locally). Add a retention
		// sweep (or stop persisting on success) when it starts to hurt.
		persistBody(sourceId, url, contentType, body, fetchedAt) {
			const dir = adapterRawDir(sourceId);
			mkdirSync(dir, { recursive: true });
			const ext = extensionForContentType(contentType);
			const timestamp = fetchedAt.replace(/[:.]/g, "-");
			const path = join(dir, `${timestamp}__${slugForUrl(url)}.${ext}`);
			writeFileSync(path, body, "utf-8");
			return path;
		},
	};
}
