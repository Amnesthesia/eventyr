import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffDelay, sleep } from "@dothingslol/utils/time";
import { gotScraping } from "got-scraping";
import { apiRequestFor } from "./parsers/feeds.ts";
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
// robots.txt is deliberately NOT consulted as a permission check. It was, and
// it cost more coverage than it protected: the rules that actually fired were
// broad crawler-management directives aimed at search engines and AI trainers
// (query-string patterns, /search, year archives), not statements about the
// public what's-on pages this fetches. Whole event sources were being dropped
// on rules that were never about us.
//
// probe.ts still *reads* robots.txt, for the `Sitemap:` lines — that is
// discovery, not permission, and it is the cheapest way to find a site's own
// listing index.
//
// What remains, and is what actually matters for behaving well: one request
// per second per host, at most two concurrent, conditional GETs so an
// unchanged page is not re-downloaded, and no challenge-solving, CAPTCHA
// bypass or proxy rotation — none of which should be added.
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Failures that will not become successes by asking again: the name does not
 * resolve, nothing is listening, or TLS cannot be negotiated. A timeout or a
 * connection reset is NOT here — those are genuinely transient and are exactly
 * what the retry ladder is for.
 */
export function isPermanentFailure(err: unknown): boolean {
	const code = (err as { code?: unknown })?.code;
	const message = err instanceof Error ? err.message : String(err);
	const text = `${typeof code === "string" ? code : ""} ${message}`;
	return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN/i.test(
		text,
	);
}

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

export const DEFAULT_MIN_INTERVAL_MS = 1000;
export const DEFAULT_MAX_CONCURRENCY_PER_HOST = 2;
export const DEFAULT_MAX_RETRIES = 3;
export const BASE_BACKOFF_MS = 1000;

export interface HttpCacheEntry {
	etag: string | null;
	lastModified: string | null;
	bodyPath: string;
	fetchedAt: string;
}

/**
 * Where conditional-GET validators and response bodies live. Injected so the
 * scraper knows nothing about data/: the pipeline's store (src/io/httpCache.ts)
 * keeps the same data/_cache/{sourceId}.json and data/_raw/{sourceId}/ layout
 * as before, so the Actions cache stays valid across the move.
 */
export interface HttpCacheStore {
	/** The validators recorded for this URL, if any. */
	get(sourceId: string, url: string): HttpCacheEntry | undefined;
	set(sourceId: string, url: string, entry: HttpCacheEntry): void;
	/** Persists a response body and returns the path the ladder reads it from. */
	persistBody(
		sourceId: string,
		url: string,
		contentType: string | null,
		body: string,
		fetchedAt: string,
	): string;
}

/**
 * The default when no store is given: bodies go to a temp directory for the
 * ladder to read, and nothing is remembered between runs, so every fetch is
 * unconditional. Fine for a one-off scrape; the pipeline injects its own.
 */
export function createTempStore(): HttpCacheStore {
	let dir: string | undefined;
	let n = 0;
	return {
		get: () => undefined,
		set: () => {},
		persistBody(_sourceId, _url, _contentType, body) {
			dir ??= mkdtempSync(join(tmpdir(), "dothingslol-scraper-"));
			const path = join(dir, `${++n}.body`);
			writeFileSync(path, body, "utf-8");
			return path;
		},
	};
}

/** PLAN §2.5's name for it; `new SourceFetcher(opts)` is the same thing. */
export function createFetcher(
	opts?: ConstructorParameters<typeof SourceFetcher>[0],
): SourceFetcher {
	return new SourceFetcher(opts);
}

export class SourceFetcher {
	private readonly userAgent: string;
	private readonly minIntervalMs: number;
	private readonly maxConcurrencyPerHost: number;
	private readonly maxRetries: number;
	// ponytail: rate limiting and concurrency caps are per-process maps, so two
	// concurrent runs (a retried workflow, a manual run alongside CI) hit a
	// host at 2x the stated limit. Needs a shared store if that becomes real.
	private readonly hostLastRequestAt = new Map<string, number>();
	private readonly hostActive = new Map<string, number>();
	private readonly hostWaiters = new Map<string, Array<() => void>>();
	private readonly fetchImpl: typeof fetch;
	private readonly store: HttpCacheStore;

	constructor(opts?: {
		userAgent?: string;
		minIntervalMs?: number;
		maxConcurrencyPerHost?: number;
		maxRetries?: number;
		fetchImpl?: typeof fetch;
		store?: HttpCacheStore;
	}) {
		this.store = opts?.store ?? createTempStore();
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
		await this.waitForRateLimit(host);

		const cached = this.store.get(sourceId, url);
		// Only the conditional-GET validators: got-scraping generates a
		// coherent browser header set itself, and hand-written headers that
		// disagree with its fingerprint are worse than none.
		const headers: Record<string, string> = {};
		if (cached?.etag) headers["If-None-Match"] = cached.etag;
		if (cached?.lastModified)
			headers["If-Modified-Since"] = cached.lastModified;

		// A few event APIs pick their content by cookie or token rather than
		// URL (feeds.ts). The listing URL stays the cache key and provenance;
		// only the wire request changes.
		const api = await apiRequestFor(url, this.fetchImpl);

		let lastErr: unknown;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const res = await this.fetchImpl(api?.url ?? url, {
					headers: { ...headers, ...api?.headers },
				});
				this.hostLastRequestAt.set(host, Date.now());

				if (res.status === 429 || res.status >= 500) {
					if (attempt === this.maxRetries) {
						throw new Error(
							`${res.status} from ${url} after ${attempt + 1} attempts`,
						);
					}
					await sleep(backoffDelay(attempt, BASE_BACKOFF_MS));
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
				const bodyPath = this.store.persistBody(
					sourceId,
					url,
					contentType,
					body,
					fetchedAt,
				);

				this.store.set(sourceId, url, {
					etag: res.headers.get("etag"),
					lastModified: res.headers.get("last-modified"),
					bodyPath,
					fetchedAt,
				});

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
				// Retrying a permanent failure buys nothing and costs the whole
				// backoff ladder. One brisbane probe hit 152 dead domains, each
				// paying three DNS lookups and ~7s of sleeping to be told
				// NXDOMAIN three times — roughly 18 minutes of a two-hour run
				// spent waiting to re-learn the same answer.
				if (isPermanentFailure(err)) break;
				if (attempt === this.maxRetries) break;
				await sleep(backoffDelay(attempt, BASE_BACKOFF_MS));
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
}

/**
 * Why a response cannot be extracted from, or null if it can.
 *
 * This exists because a blocked fetch and a quiet week were indistinguishable
 * downstream. `raw.status` was read by nobody outside probe, so a 403
 * challenge page counted as a *successful* listing fetch, extracted zero
 * events, and landed in barren.json as a bare source name — the same output a
 * venue with nothing on produces. Losing coverage while reporting success is
 * the worst outcome available, so this is raised as an error instead.
 *
 * The wall that motivated the body check: ~15 byron hosts answer every URL —
 * `/robots.txt` included — with the same ~12 KB shell whose entire content is
 * a spinner and `setTimeout(() => window.location.reload(), 5000)`. It is a
 * 200, so nothing flagged it, and probe filed those hosts as `spa-empty`,
 * i.e. "client-rendered, nothing we can do". They are reachable; they just
 * refuse this fetcher.
 */
export function blockedReason(
	status: number,
	body: string,
	readableLength: number,
): string | null {
	// 304 carries the cached body and is a normal, extractable response.
	if (status !== 304 && status >= 400) return `HTTP ${status}`;

	// Named challenge interstitials, at any length.
	if (
		/cf-browser-verification|Checking your browser before|Just a moment\.\.\.|Attention Required!|Enable JavaScript and cookies to continue|__cf_chl_|DDoS protection by/i.test(
			body,
		)
	) {
		return "bot challenge interstitial";
	}

	// A page whose only instruction is "come back in a moment" and which has
	// essentially no text. Both halves are required: plenty of real pages
	// contain a reload call, and plenty of thin pages are simply thin.
	const reloads =
		/location\.reload\(\)|window\.location\s*=\s*window\.location|<meta[^>]+http-equiv=["']refresh["']/i.test(
			body,
		);
	if (reloads && readableLength < BLOCKED_TEXT_LENGTH) {
		return "JS-reload shell (no content served to this fetcher)";
	}
	return null;
}

/**
 * Below this many characters of readable text, a page carrying a reload
 * directive is a holding page rather than a listing. The measured shells sit
 * at 76 characters; the smallest real listing page seen is an order of
 * magnitude above this.
 */
const BLOCKED_TEXT_LENGTH = 512;
