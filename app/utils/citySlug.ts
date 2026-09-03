// Single source of truth lives in src/shared.ts, which the pipeline also
// reads — a second copy here is exactly how the site's URLs and the generated
// sitemap/feed URLs drift apart. Imported from shared.ts, not common.ts:
// common.ts reads the filesystem and cannot be bundled for the browser.
import { KEY_TO_SLUG } from "../../src/shared.ts";

export { KEY_TO_SLUG };

export const SLUG_TO_KEY: Record<string, string> = Object.fromEntries(
	Object.entries(KEY_TO_SLUG).map(([key, slug]) => [slug, key]),
);
