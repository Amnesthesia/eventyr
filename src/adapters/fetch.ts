import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gotScraping } from "got-scraping";
import { adapterCachePath, adapterRawDir } from "../common.ts";
import { fetchRobotsPolicy, type RobotsPolicy } from "./robots.ts";
import type { RawListing, SourceStrategy } from "./types.ts";

// Transport note — why this doesn't use Node's fetch:
//
// A large share of these venue sites sit behind Cloudflare, which fingerprints
// the TLS ClientHello (JA3) rather than reading headers. Measured against
// qagoma.qld.gov.au: curl with nothing but a UA gets 200, while Node's fetch
// (undici) with a full browser header set gets 403 — same headers, different
// TLS handshake. No amount of header work fixes that.
//
// got-scraping (the transport inside Crawlee's CheerioCrawler) mimics a
// browser's TLS and HTTP/2 fingerprint and generates matching headers, which
// takes those same URLs to 200.
//
// What has NOT changed: robots.txt is still fetched and obeyed for every
// request, and the per-host rate limit is unchanged. QAGOMA's robots.txt, for
// instance, allows /whats-on/events/ — the 403 was an over-broad WAF default,
// not a stated crawling policy. No challenge-solving, CAPTCHA bypass or proxy
// rotation is done here, and none should be added: if a site actually
// disallows us in robots.txt, we don't fetch it.
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Minimal fetch-shaped wrapper over got-scraping, so SourceFetcher's own
 * logic (and its fetchImpl injection point for tests) is untouched. */
const browserFetch: typeof fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input.toString();
	const response = await gotScraping({
		url,
		headers: (init?.headers as Record<string, string>) ?? {},
		// We handle retries, and a non-2xx is information, not an exception.
		throwHttpErrors: false,
		retry: { limit: 0 },
		followRedirect: true,
		timeout: { request: 30_000 },
		// Let got-scraping generate the browser-consistent header set; only
		// our conditional-GET validators are passed through above.
		useHeaderGenerator: true,
	});
	// got's header bag carries symbol keys and array values; Response only
	// accepts string pairs, and passing the raw object throws.
	const headers = new Headers();
	for (const [key, value] of Object.entries(response.headers)) {
		// HTTP/2 pseudo-headers (":status", ":method") are not valid header
		// names in the Headers API.
		if (typeof key !== "string" || key.startsWith(":") || value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, String(v));
		} else {
			headers.set(key, String(value));
		}
	}
	// 204/205/304 are null-body statuses; the Response constructor throws if
	// given a body with them, and a 304 is exactly what conditional GET wants
	// to return.
	const nullBody = [204, 205, 304].includes(response.statusCode);
	return new Response(nullBody ? null : response.body, {
		status: response.statusCode,
		headers,
	});
};

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

export class SourceFetcher {
	private readonly userAgent: string;
	private readonly minIntervalMs: number;
	private readonly maxConcurrencyPerHost: number;
	private readonly maxRetries: number;
	// ponytail: rate limiting and concurrency caps are per-process maps, so two
	// concurrent runs (a retried workflow, a manual run alongside CI) hit a
	// host at 2x the stated limit. Needs a shared store if that becomes real.
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
		this.fetchImpl = opts?.fetchImpl ?? browserFetch;
	}

	async fetch(
		sourceId: string,
		url: string,
		strategy: SourceStrategy,
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
		strategy: SourceStrategy,
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
		// Only the conditional-GET validators: got-scraping generates a
		// coherent browser header set itself, and hand-written headers that
		// disagree with its fingerprint are worse than none.
		const headers: Record<string, string> = {};
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

	// ponytail: writes one file per URL per run with no pruning — data/_raw is
	// gitignored and grows unboundedly (146 MB locally). Add a retention sweep
	// (or stop persisting on success) when it starts to hurt.
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
