// @dothingslol/scraper/testing — a Fetcher that serves recorded pages.
//
// The fixture directory holds a manifest.json (an array of {name, url,
// status, headers, bodyFile, error?}) and bodies/. Used by
// scripts/scrape-parity.mjs and by `pnpm test-adapter` in replay mode
// (EVENTYR_SCRAPE_FIXTURES=<dir>); nothing in the pipeline proper imports it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "@dothingslol/utils/time";
import type { Fetcher, RawListing } from "./types.ts";

export interface FixtureEntry {
	name: string;
	url: string;
	/** Null with `error` set: the fetch throws, as SourceFetcher does after
	 * its retries. 304: the body file is the cached body. */
	status: number | null;
	headers?: Record<string, string>;
	bodyFile: string | null;
	error?: string;
	strategy?: string;
}

export interface FixtureFetcher extends Fetcher {
	/** Concurrency profile, for the D19 check. */
	readonly stats: { fetches: number; inFlight: number; peakInFlight: number };
}

export function createFixtureFetcher(
	dir: string,
	opts: { latencyMs?: number; fetchedAt?: string } = {},
): FixtureFetcher {
	const manifest = JSON.parse(
		readFileSync(join(dir, "manifest.json"), "utf-8"),
	) as FixtureEntry[];
	const byUrl = new Map(manifest.map((f) => [f.url, f]));
	const stats = { fetches: 0, inFlight: 0, peakInFlight: 0 };
	const fetchedAt = opts.fetchedAt ?? "2026-09-23T00:00:00.000Z";
	return {
		stats,
		async fetch(_sourceId, url, strategy): Promise<RawListing> {
			const f = byUrl.get(url);
			if (!f) throw new Error(`no fixture for ${url}`);
			stats.fetches++;
			stats.inFlight++;
			stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
			try {
				if (opts.latencyMs) await sleep(opts.latencyMs);
				if (f.error) throw new Error(f.error);
				return {
					url,
					fetchedAt,
					status: f.status ?? 0,
					notModified: f.status === 304,
					contentType:
						f.status === 304 ? null : (f.headers?.["content-type"] ?? null),
					bodyPath: f.bodyFile ? join(dir, "bodies", f.bodyFile) : null,
					strategy,
				};
			} finally {
				stats.inFlight--;
			}
		},
	};
}
