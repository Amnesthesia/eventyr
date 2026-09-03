// robots.txt for the shared fetch layer. Thin wrapper over robots-parser,
// which implements RFC 9309 properly.
//
// This replaced a ~100-line hand-rolled parser whose own header admitted it
// did prefix matching only: a site publishing "Disallow: /*/events" read as
// allowing everything, and "Disallow: /private$" matched every path under
// /private. This is the scraper's trust boundary, so "close enough" was the
// wrong trade — and the library also handles group merging, precedence by
// specificity, and crawl-delay, all of which the local version approximated
// or ignored.

import robotsParserImport from "robots-parser";

// robots-parser is CJS (`module.exports = fn`) but ships a .d.ts declaring an
// ESM default export, so under NodeNext TypeScript types the import as a
// namespace rather than the callable it actually is at runtime.
const robotsParser = robotsParserImport as unknown as (
	url: string,
	body: string,
) => { isAllowed(url: string, ua?: string): boolean | undefined };

export interface RobotsPolicy {
	isAllowed(path: string): boolean;
}

const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };

export async function fetchRobotsPolicy(
	origin: string,
	userAgent: string,
	fetchImpl: typeof fetch = fetch,
): Promise<RobotsPolicy> {
	const robotsUrl = `${origin}/robots.txt`;
	try {
		const res = await fetchImpl(robotsUrl, {
			headers: { "User-Agent": userAgent },
		});
		if (!res.ok) return ALLOW_ALL;
		const robots = robotsParser(robotsUrl, await res.text());
		return {
			isAllowed(path: string): boolean {
				// robots-parser wants absolute URLs and returns undefined when no
				// rule matches at all, which means allowed.
				return (
					robots.isAllowed(new URL(path, origin).href, userAgent) !== false
				);
			},
		};
	} catch {
		// robots.txt unreachable — don't let that block fetching the site.
		return ALLOW_ALL;
	}
}
