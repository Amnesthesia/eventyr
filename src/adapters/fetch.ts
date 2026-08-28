import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adapterCachePath, adapterRawDir } from "../common.ts";
import { fetchRobotsPolicy, type RobotsPolicy } from "./robots.ts";
import type { ExtractionStrategy, RawListing } from "./types.ts";

export const USER_AGENT = "EventyrBot/1.0 (+https://dothings.lol)";

const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_CONCURRENCY_PER_HOST = 2;
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

interface CacheEntry {
	etag: string | null;
	lastModified: string | null;
	bodyPath: string;
	fetchedAt: string;
}

type Cache = Record<string, CacheEntry>;

function loadCache(sourceId: string): Cache {
	const path = adapterCachePath(sourceId);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Cache;
	} catch {
		return {};
	}
}

function saveCache(sourceId: string, cache: Cache): void {
	const path = adapterCachePath(sourceId);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
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

function jitter(ms: number): number {
	return ms + Math.floor(Math.random() * ms * 0.3);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared fetch layer for all source adapters: honours robots.txt, applies a
 * per-host rate limit and concurrency cap, retries 429/5xx with jittered
 * exponential backoff, does conditional GET against a persistent per-source
 * cache, and persists every successful response body to disk (keyed by
 * source + URL + timestamp) as both a debugging artifact and a fixture
 * source for adapter tests.
 *
 * One instance is meant to be shared across a whole run so the per-host
 * rate limiting actually applies across sources that share a host.
 */
export class SourceFetcher {
	private readonly userAgent: string;
	private readonly minIntervalMs: number;
	private readonly maxConcurrencyPerHost: number;
	private readonly maxRetries: number;
	private readonly robotsCache = new Map<string, Promise<RobotsPolicy>>();
	private readonly hostLastRequestAt = new Map<string, number>();
	private readonly hostActive = new Map<string, number>();
	private readonly hostWaiters = new Map<string, Array<() => void>>();
	private readonly fetchImpl: typeof fetch;

	constructor(opts?: {
		userAgent?: string;
		minIntervalMs?: number;
		maxConcurrencyPerHost?: number;
		maxRetries?: number;
		fetchImpl?: typeof fetch;
	}) {
		this.userAgent = opts?.userAgent ?? USER_AGENT;
		this.minIntervalMs = opts?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
		this.maxConcurrencyPerHost =
			opts?.maxConcurrencyPerHost ?? DEFAULT_MAX_CONCURRENCY_PER_HOST;
		this.maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.fetchImpl = opts?.fetchImpl ?? fetch;
	}

	async fetch(
		sourceId: string,
		url: string,
		strategy: ExtractionStrategy,
	): Promise<RawListing> {
		const host = new URL(url).host;
		await this.acquireHostSlot(host);
		try {
			return await this.fetchWithPolicy(sourceId, url, strategy, host);
		} finally {
			this.releaseHostSlot(host);
		}
	}

	// Caps concurrent in-flight requests per host at maxConcurrencyPerHost.
	// The min-interval throttle (waitForRateLimit) then additionally spaces
	// out when each request *starts*, independent of how long a slot is held.
	private acquireHostSlot(host: string): Promise<void> {
		const active = this.hostActive.get(host) ?? 0;
		if (active < this.maxConcurrencyPerHost) {
			this.hostActive.set(host, active + 1);
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const waiters = this.hostWaiters.get(host) ?? [];
			waiters.push(resolve);
			this.hostWaiters.set(host, waiters);
		});
	}

	private releaseHostSlot(host: string): void {
		const waiters = this.hostWaiters.get(host) ?? [];
		const next = waiters.shift();
		if (next) {
			this.hostWaiters.set(host, waiters);
			next();
			return;
		}
		const active = this.hostActive.get(host) ?? 1;
		this.hostActive.set(host, Math.max(0, active - 1));
	}

	private async fetchWithPolicy(
		sourceId: string,
		url: string,
		strategy: ExtractionStrategy,
		host: string,
	): Promise<RawListing> {
		const origin = new URL(url).origin;
		if (!this.robotsCache.has(origin)) {
			this.robotsCache.set(
				origin,
				fetchRobotsPolicy(origin, this.userAgent, this.fetchImpl),
			);
		}
		const robots = await (this.robotsCache.get(
			origin,
		) as Promise<RobotsPolicy>);
		const path = new URL(url).pathname;
		if (!robots.isAllowed(path)) {
			throw new Error(
				`robots.txt disallows fetching ${url} for ${this.userAgent}`,
			);
		}

		await this.waitForRateLimit(host);

		const cache = loadCache(sourceId);
		const cached = cache[url];
		const headers: Record<string, string> = { "User-Agent": this.userAgent };
		if (cached?.etag) headers["If-None-Match"] = cached.etag;
		if (cached?.lastModified)
			headers["If-Modified-Since"] = cached.lastModified;

		let lastErr: unknown;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const res = await this.fetchImpl(url, { headers });
				this.hostLastRequestAt.set(host, Date.now());

				if (res.status === 429 || res.status >= 500) {
					if (attempt === this.maxRetries) {
						throw new Error(
							`${res.status} from ${url} after ${attempt + 1} attempts`,
						);
					}
					await sleep(jitter(BASE_BACKOFF_MS * 2 ** attempt));
					continue;
				}

				const fetchedAt = new Date().toISOString();

				if (res.status === 304 && cached) {
					return {
						url,
						fetchedAt,
						status: 304,
						notModified: true,
						contentType: null,
						bodyPath: cached.bodyPath,
						strategy,
					};
				}

				const contentType = res.headers.get("content-type");
				const body = await res.text();
				const bodyPath = this.persistBody(
					sourceId,
					url,
					contentType,
					body,
					fetchedAt,
				);

				cache[url] = {
					etag: res.headers.get("etag"),
					lastModified: res.headers.get("last-modified"),
					bodyPath,
					fetchedAt,
				};
				saveCache(sourceId, cache);

				return {
					url,
					fetchedAt,
					status: res.status,
					notModified: false,
					contentType,
					bodyPath,
					strategy,
				};
			} catch (err) {
				lastErr = err;
				if (attempt === this.maxRetries) break;
				await sleep(jitter(BASE_BACKOFF_MS * 2 ** attempt));
			}
		}
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
	}

	private async waitForRateLimit(host: string): Promise<void> {
		const last = this.hostLastRequestAt.get(host);
		if (last === undefined) return;
		const elapsed = Date.now() - last;
		if (elapsed < this.minIntervalMs) {
			await sleep(this.minIntervalMs - elapsed);
		}
	}

	private persistBody(
		sourceId: string,
		url: string,
		contentType: string | null,
		body: string,
		fetchedAt: string,
	): string {
		const dir = adapterRawDir(sourceId);
		mkdirSync(dir, { recursive: true });
		const ext = extensionForContentType(contentType);
		const timestamp = fetchedAt.replace(/[:.]/g, "-");
		const filename = `${timestamp}__${slugForUrl(url)}.${ext}`;
		const path = join(dir, filename);
		writeFileSync(path, body, "utf-8");
		return path;
	}
}
