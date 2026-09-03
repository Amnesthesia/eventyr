// CATEGORIES (src/shared.ts) is a closed enum and annotate.ts validates every
// event against it, defaulting to "Community / Other" — so this table is
// total, and both functions used to carry an unreachable slugify fallback
// "so new categories work without a code change". A new category is a code
// change to shared.ts by construction; the fallback only hid a missing row
// here behind a URL nobody had checked.
import type { Category } from "../../src/shared.ts";

const CATEGORY_META: Record<Category, { slug: string; short: string }> = {
	"Arts / Exhibition": { slug: "arts", short: "Arts" },
	"Community / Other": { slug: "community", short: "Community" },
	"Concert / Music": { slug: "music", short: "Music" },
	"Public Lecture": { slug: "talks", short: "Talks" },
	"Social / Meetup": { slug: "social", short: "Social" },
	"Workshop / Class": { slug: "workshops", short: "Workshops" },
};

/** URL-safe slug for a category label. */
export function catToSlug(label: string): string {
	return CATEGORY_META[label as Category]?.slug ?? "community";
}

/** Short display name for titles and nav labels. */
export function catShortName(label: string): string {
	return CATEGORY_META[label as Category]?.short ?? label;
}
