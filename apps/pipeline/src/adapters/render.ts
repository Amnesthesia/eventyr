import { loadPipelineConfig } from "../config/load.js";
// The browser rung: the last thing tried, and used to *discover* a static
// access path rather than to collect events week after week.
//
// Why discovery and not collection. beachhotel.com.au serves a 76-character
// JS-reload shell for every HTML URL — probe filed it "spa-empty", i.e.
// unscrapable. One render exposed a <link rel="alternate"> pointing at
// /wp-json/tribe/events/v1/events, and that URL answers plain HTTP with 384
// upcoming events. Had rendering been a collection rung we would be paying
// ~6s a week forever to re-read a page whose API was sitting there the whole
// time. So: render once, harvest candidate URLs, verify them without a
// browser, and promote the ones that work.
//
// What it costs. Measured on that same host: domContentLoaded 4.3s, load
// 6.6s. Call it 5–7s a page, and the fixed cost of installing chromium in CI
// is larger than any single page.
//
// Which sources it is pointed at. Not the whole bot-wall bucket — a browser is
// the most expensive rung, so `triage --render-candidates` scores every walled
// source from evidence a wall cannot hide (its own sitemap, and what the AI
// search has actually found there) and this runs against that shortlist.
//
// Batching is a requirement, not an optimisation: one browser per run, and one
// context per HOST reused across that host's URLs, because the interstitial
// sets a cookie and reloads — the second URL on a host should skip the
// challenge, which only holds if the context persists.
//
// The collection-time half (renderFetch, the shared browser) lives in
// @dothingslol/scraper/render; this file is the discovery/promotion half,
// which knows about sources/{city}.yml and data/_probe.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normaliseHost, toISODate } from "@dothingslol/core/shared";
import {
	feedUrlsFromHtml,
	wpJsonRoutesToFeedUrls,
} from "@dothingslol/scraper/parsers";
import {
	countRenderedDateHits,
	launchBrowser,
	looksEventish,
} from "@dothingslol/scraper/render";
import yaml from "js-yaml";
import type { Browser, BrowserContext } from "playwright";
import { type CityConfig, SOURCE_TIERS } from "../config/city.js";
import { DATA_ROOT, SOURCES_ROOT } from "../config/paths.js";

/** Pages rendered per host. A walled host needs its landing page and maybe one
 * listing guess; more than that is a crawl, which this is not. */
const MAX_PAGES_PER_HOST = 2;
/** Hosts rendered concurrently. Each holds its own browser context, so this
 * bounds memory as much as politeness. */

/**
 * Whole-run ceiling. A cron job must not be able to run for hours because 50
 * hosts each decided to be slow — probe already hung a run for 28 minutes on
 * a missing timeout, and that lesson is cheap to reapply here.
 */

export interface RenderFinding {
	host: string;
	/** URLs the rendered page advertised or fetched, for code to verify. */
	candidateUrls: string[];
	/** Date-shaped fragments in the rendered text — did the wall hide content? */
	dateHits: number;
	textLength: number;
	/** JSON responses the page itself fetched whose bodies look event-shaped. */
	xhrUrls: string[];
	error?: string;
}

async function renderHost(
	context: BrowserContext,
	host: string,
	urls: string[],
): Promise<RenderFinding> {
	const finding: RenderFinding = {
		host,
		candidateUrls: [],
		dateHits: 0,
		textLength: 0,
		xhrUrls: [],
	};
	const page = await context.newPage();
	// The highest-value trick available: the API behind a client-rendered
	// calendar or a "load more" button is invisible in the HTML but shows up
	// here. embeddedJson.ts documents post-load XHR as out of scope, and this
	// is how that gap gets closed — without the browser becoming a collector.
	page.on("response", (res) => {
		const url = res.url();
		const type = res.headers()["content-type"] ?? "";
		if (!/json/i.test(type) || finding.xhrUrls.length >= 10) return;
		res
			.text()
			.then((body) => {
				if (looksEventish(body) && !finding.xhrUrls.includes(url)) {
					finding.xhrUrls.push(url);
				}
			})
			.catch(() => {
				// A body already consumed or a redirect with no body: not an error.
			});
	});

	try {
		for (const url of urls.slice(0, MAX_PAGES_PER_HOST)) {
			try {
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: loadPipelineConfig().scrape.render.pageTimeoutMs,
				});
				// Outlast the reload interstitial rather than reading the shell.
				await page.waitForTimeout(loadPipelineConfig().scrape.render.settleMs);
				const html = await page.content();
				// innerText via the locator API, not page.evaluate: this tsconfig
				// has no DOM lib (it is a Node build), and reaching for one just
				// to read text would let every other script reference browser
				// globals it does not have.
				const text = await page.innerText("body").catch(() => "");
				finding.textLength = Math.max(finding.textLength, text.length);
				finding.dateHits = Math.max(
					finding.dateHits,
					countRenderedDateHits(text),
				);

				// What the rendered page says about itself. Both of these are
				// static URLs a plain fetch can verify afterwards, which is the
				// whole point — the browser finds them, code checks them.
				for (const u of feedUrlsFromHtml(html, url)) {
					if (!finding.candidateUrls.includes(u)) finding.candidateUrls.push(u);
				}
				if (/\/wp-json\/|wp-content/i.test(html)) {
					const root = new URL("/wp-json/", url).href;
					const res = await page.request.get(root).catch(() => null);
					if (res?.ok()) {
						const body = await res.text().catch(() => "");
						for (const u of wpJsonRoutesToFeedUrls(body, new URL(url).origin)) {
							if (!finding.candidateUrls.includes(u)) {
								finding.candidateUrls.push(u);
							}
						}
					}
				}
				// Anchors that only exist after JS ran. Read out of the rendered
				// HTML rather than in-page, for the same no-DOM-lib reason — and
				// it is one fewer round trip.
				const hrefs = [...html.matchAll(/<a\b[^>]+href=["']([^"']+)["']/gi)]
					.map((m) => m[1])
					.slice(0, 400);
				const LISTING =
					/\/(whats[-_]?on|events?|calendar|shows?|gigs?|programme?|exhibitions?|workshops?|tickets?)(\/|$|\?)/i;
				for (const href of hrefs) {
					try {
						const u = new URL(href, url);
						if (
							u.hostname.endsWith(host.replace(/^www\./, "")) &&
							LISTING.test(u.pathname)
						) {
							if (!finding.candidateUrls.includes(u.href)) {
								finding.candidateUrls.push(u.href);
							}
						}
					} catch {
						// A malformed href in third-party HTML is not an error.
					}
				}
			} catch (err) {
				finding.error = (err as Error).message.slice(0, 160);
			}
		}
	} finally {
		await page.close().catch(() => {});
	}
	return finding;
}

export interface RenderTarget {
	host: string;
	urls: string[];
}

/**
 * Renders each target once and returns what it found. Flushes after every host
 * so a killed run keeps everything it proved.
 */
export async function renderTargets(
	targets: RenderTarget[],
	outPath: string,
): Promise<RenderFinding[]> {
	if (targets.length === 0) return [];
	const startedAt = Date.now();
	const findings: RenderFinding[] = [];
	let browser: Browser | undefined;
	// Counted, not commented: a regression to one browser per URL is the thing
	// that would quietly make this 50x slower.
	let launches = 0;

	try {
		browser = await launchBrowser();
		launches++;
	} catch (err) {
		// Degrade, don't die: no browser means the deterministic paths still
		// stand, and the run should say so rather than fail.
		console.warn(
			`⚠ no browser available (${(err as Error).message.slice(0, 80)}) — skipping the render pass`,
		);
		return [];
	}

	const flush = () => {
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, `${JSON.stringify(findings, null, 2)}\n`);
	};

	let index = 0;
	const worker = async (): Promise<void> => {
		while (index < targets.length) {
			if (
				Date.now() - startedAt >
				loadPipelineConfig().scrape.render.runBudgetMs
			) {
				console.warn(
					`⚠ render budget of ${Math.round(loadPipelineConfig().scrape.render.runBudgetMs / 60000)}min reached — stopping with ${findings.length}/${targets.length} host(s) done`,
				);
				return;
			}
			const target = targets[index++];
			// One context per host, reused across its URLs: the wall sets a
			// cookie and reloads, so the second URL should skip the challenge.
			const context = await (browser as Browser).newContext({
				viewport: { width: 1280, height: 900 },
			});
			try {
				const finding = await renderHost(context, target.host, target.urls);
				findings.push(finding);
				console.log(
					`  ${finding.candidateUrls.length || finding.xhrUrls.length ? "✓" : "·"} ${target.host.padEnd(34)} ` +
						`${finding.textLength} chars, ${finding.dateHits} date hits, ` +
						`${finding.candidateUrls.length} candidate URL(s), ${finding.xhrUrls.length} JSON response(s)` +
						`${finding.error ? `  ! ${finding.error}` : ""}`,
				);
			} catch (err) {
				findings.push({
					host: target.host,
					candidateUrls: [],
					dateHits: 0,
					textLength: 0,
					xhrUrls: [],
					error: (err as Error).message.slice(0, 160),
				});
			} finally {
				// Contexts close; the browser does not.
				await context.close().catch(() => {});
				flush();
			}
		}
	};

	try {
		await Promise.all(
			Array.from(
				{
					length: Math.min(
						loadPipelineConfig().scrape.render.concurrentHosts,
						targets.length,
					),
				},
				worker,
			),
		);
	} finally {
		await browser.close().catch(() => {});
	}
	console.log(
		`\n${findings.length} host(s) rendered in ${Math.round((Date.now() - startedAt) / 1000)}s with ${launches} browser launch(es).`,
	);
	if (launches !== 1) {
		throw new Error(
			`expected exactly 1 browser launch for the run, got ${launches}`,
		);
	}
	return findings;
}

/**
 * Writes harvested URLs onto their source as candidate `listingUrls`, leaving
 * `method: llm` alone.
 *
 * This is the whole point of rendering for discovery: the browser only
 * *proposes*. probe already fetches declared listingUrls first, extracts from
 * them, and promotes to `method: scraper` only when a page actually yields
 * dated events — so a URL that renders nicely but produces no events is
 * rejected on evidence rather than trusted because a browser liked it. A
 * source whose candidates all fail stays exactly where it was.
 */
/**
 * Date-shaped fragments a rendered page must show before the source is put on
 * the weekly browser path. Cheap proxy for "there are events here": one or two
 * hits is a copyright year and an opening-hours line, which is why this is not
 * 1. The real gate is downstream — collect reports the source barren if the
 * ladder extracts nothing from the rendered HTML, and a barren source demotes.
 */
const RENDER_ONLY_MIN_DATE_HITS = 3;

export function applyCandidates(
	findings: RenderFinding[],
	hostCity: Map<string, string>,
): number {
	// Prefer paths that name a listing over deep single-event pages, and keep
	// only a few: probe evaluates a bounded number of candidates per source.
	const LISTING =
		/\/(whats[-_]?on|events?|calendar|shows?|gigs?|programme?|exhibitions?|workshops?)(\/|$|\?)/i;
	const rank = (u: string): number => {
		try {
			const path = new URL(u).pathname.replace(/\/+$/, "");
			const depth = path.split("/").filter(Boolean).length;
			return (LISTING.test(`${path}/`) ? 0 : 10) + depth;
		} catch {
			return 99;
		}
	};

	const byCity = new Map<string, RenderFinding[]>();
	for (const f of findings) {
		const urls = [...f.candidateUrls, ...f.xhrUrls];
		if (urls.length === 0) continue;
		const city = hostCity.get(f.host);
		if (!city) continue;
		const list = byCity.get(city) ?? [];
		list.push(f);
		byCity.set(city, list);
	}

	let written = 0;
	for (const [city, cityFindings] of byCity) {
		const path = join(SOURCES_ROOT, `${city}.yml`);
		const original = readFileSync(path, "utf-8");
		const cfg = yaml.load(original) as CityConfig;
		let touched = false;
		for (const tier of SOURCE_TIERS) {
			for (const entry of cfg.sources?.[tier] ?? []) {
				const host = normaliseHost(entry.domains?.[0]);
				const finding = cityFindings.find(
					(f) => normaliseHost(f.host) === host,
				);
				if (!finding || entry.method === "scraper") continue;
				const picked = [...finding.candidateUrls, ...finding.xhrUrls]
					.sort((a, b) => rank(a) - rank(b))
					.slice(0, 3);

				// No static path, but the rendered page plainly has dated content:
				// this is the residue the browser exists for. It goes on the
				// weekly render path — the only case where that is worth its cost,
				// and only because a render produced evidence, never on a guess.
				if (picked.length === 0) {
					if (finding.dateHits >= RENDER_ONLY_MIN_DATE_HITS) {
						entry.method = "scraper";
						entry.strategy = "render";
						entry.homepage = entry.homepage ?? `https://${finding.host}/`;
						entry.listingUrls = [entry.homepage];
						entry.note =
							`Render-only source, set ${toISODate(new Date(), cfg.timezone)}: static HTML is walled ` +
							`and no fetchable listing URL could be verified, but rendering it showed ` +
							`${finding.dateHits} date-shaped fragments in ${finding.textLength} chars. ` +
							"Fetched through a browser at collect time; goes barren and demotes if it stops yielding.";
						touched = true;
						written++;
					}
					continue;
				}
				entry.listingUrls = picked;
				entry.note =
					`Candidate listing URLs found by rendering the page ${toISODate(new Date(), cfg.timezone)}: ` +
					"static HTML is walled, so probe-sources could not see these. Still " +
					"method: llm — probe verifies them and promotes only if they yield events.";
				touched = true;
				written++;
			}
		}
		if (!touched) continue;
		const header = original.slice(0, original.indexOf("\nname:") + 1);
		writeFileSync(
			path,
			`${header.replace(/\n+$/, "\n")}\n${yaml.dump(cfg, { lineWidth: 100, noRefs: true })}`,
			"utf-8",
		);
		console.log(
			`→ ${path}: candidates written for ${cityFindings.length} source(s)`,
		);
	}
	return written;
}

// --- CLI ------------------------------------------------------------------

interface Candidate {
	host: string;
	verdict: string;
	city: string;
}

function loadShortlist(limit: number, includeUnknown: boolean): RenderTarget[] {
	const path = join(DATA_ROOT, "_probe", "render-candidates.json");
	if (!existsSync(path)) {
		throw new Error(
			`${path} not found — run: pnpm tsx src/adapters/triage.ts --render-candidates`,
		);
	}
	const rows = JSON.parse(readFileSync(path, "utf-8")) as Candidate[];
	const wanted = rows.filter((r) =>
		includeUnknown ? r.verdict !== "skip" : r.verdict === "worth-rendering",
	);
	return wanted.slice(0, limit).map((r) => ({
		host: r.host,
		urls: [`https://${r.host}/`],
	}));
}

if (process.argv[1]?.endsWith("render.ts")) {
	const arg = (name: string): string | undefined =>
		process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
	const limit = Number(arg("limit") ?? "10");
	const includeUnknown = process.argv.includes("--include-unknown");
	const targets = loadShortlist(limit, includeUnknown);
	console.log(
		`Rendering ${targets.length} walled host(s) to look for a static path they publish.\n`,
	);
	const outPath = join(DATA_ROOT, "_probe", "render-findings.json");
	const findings = await renderTargets(targets, outPath);
	const withPath = findings.filter(
		(f) => f.candidateUrls.length > 0 || f.xhrUrls.length > 0,
	);
	console.log(
		`${withPath.length}/${findings.length} host(s) advertised something a plain fetch could verify.`,
	);
	console.log(`→ ${outPath}`);

	if (process.argv.includes("--apply")) {
		const rows = JSON.parse(
			readFileSync(
				join(DATA_ROOT, "_probe", "render-candidates.json"),
				"utf-8",
			),
		) as Candidate[];
		const hostCity = new Map(rows.map((r) => [r.host, r.city]));
		const written = applyCandidates(findings, hostCity);
		console.log(
			`\n${written} source(s) given candidate listingUrls — they stay method: llm until\n` +
				"probe verifies them:  pnpm probe-sources --city=<city> --force --apply",
		);
	} else if (withPath.length > 0) {
		console.log(
			"\nRe-run with --apply to write these as candidate listingUrls.",
		);
	}
}
