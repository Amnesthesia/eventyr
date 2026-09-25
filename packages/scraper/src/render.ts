// @dothingslol/scraper/render — the browser rung.
//
// Playwright is an optional peer dependency, loaded lazily on first use: a
// consumer with no browser installed still gets every deterministic path,
// and a launch failure degrades to a warning (the render-only sources are
// reported barren with the reason) rather than ending the run.
//
// Two halves lived in the pipeline's render.ts. This is the collection-time
// half: a `fetch` implementation that returns the DOM after scripts have run,
// which plugs into SourceFetcher so the ladder runs unchanged over rendered
// HTML. The discovery half (render a walled host once, harvest the static
// URLs it advertises, write them back to the city's source list) stays in the
// pipeline and borrows `launchBrowser` and the two signal helpers from here.

import type { Browser } from "playwright";

/** Per-page ceiling. The measured worst case is ~7s; a page still going at
 * 25s is not going to start working. */
export const PAGE_TIMEOUT_MS = 25_000;
/** The interstitial reloads after 5s, so a render has to outlast that before
 * concluding there is nothing here. */
export const SETTLE_MS = 6_000;

/** Date-shaped text, matching dates.ts's own cheap signal. */
export function countRenderedDateHits(text: string): number {
	return (
		text.match(
			/\b(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}|\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi,
		) ?? []
	).length;
}

/** Whether a JSON body the page fetched looks like it carries events. */
export function looksEventish(body: string): boolean {
	if (body.length < 40) return false;
	const head = body.slice(0, 4000);
	return (
		/"(start_date|startDate|start|dtstart|event_date|when)"/i.test(head) &&
		/\d{4}-\d{2}-\d{2}|\d{10,13}/.test(head)
	);
}

/**
 * Launches Chromium through the optional Playwright peer. CHROME_PATH lets CI
 * supply its own cached binary (browser-actions/setup-chrome) instead of
 * downloading Playwright's ~95 MB chromium on every run — that download is
 * the single largest fixed cost in the job, far bigger than any page it
 * renders. Unset locally, where the bundled browser is already there.
 *
 * Throws when Playwright is not installed or the launch fails; callers decide
 * whether that degrades or aborts.
 */
export async function launchBrowser(): Promise<Browser> {
	const { chromium } = await import("playwright");
	return chromium.launch({
		executablePath: process.env.CHROME_PATH || undefined,
	});
}

/**
 * A `fetch` that returns the DOM after scripts have run.
 *
 * One browser for the whole run, launched on first use and reused: a browser
 * per URL would be the single easiest way to make the weekly scrape
 * unaffordable. Callers must close it with `closeRenderBrowser()`.
 */
let sharedBrowser: Browser | null = null;
let sharedBrowserFailed = false;

export async function closeRenderBrowser(): Promise<void> {
	await sharedBrowser?.close().catch(() => {});
	sharedBrowser = null;
	sharedBrowserFailed = false;
}

export const renderFetch: typeof fetch = async (input) => {
	const url = typeof input === "string" ? input : input.toString();
	if (sharedBrowserFailed) {
		throw new Error("render browser unavailable");
	}
	if (!sharedBrowser) {
		try {
			sharedBrowser = await launchBrowser();
		} catch (err) {
			// Degrade, don't die: the deterministic sources still collect, and
			// the render-only ones are reported barren with this reason rather
			// than the run failing.
			sharedBrowserFailed = true;
			throw new Error(
				`render browser unavailable: ${(err as Error).message.slice(0, 80)}`,
			);
		}
	}
	const context = await sharedBrowser.newContext({
		viewport: { width: 1280, height: 900 },
	});
	const page = await context.newPage();
	try {
		const res = await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: PAGE_TIMEOUT_MS,
		});
		// Outlast the reload interstitial rather than capturing the shell.
		await page.waitForTimeout(SETTLE_MS);
		const html = await page.content();
		return new Response(html, {
			status: res?.status() ?? 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	} finally {
		await context.close().catch(() => {});
	}
};
