// Hardcoded nice slugs for known categories — short, clean, keyword-friendly
const KNOWN_SLUGS: Record<string, string> = {
	"Arts / Exhibition": "arts",
	"Community / Other": "community",
	"Concert / Music": "music",
	"Public Lecture": "talks",
	"Social / Meetup": "social",
	"Workshop / Class": "workshops",
};

// Convert any category label to a URL-safe slug.
// Uses hardcoded map first; falls back to slugifying the label so new
// categories work without a code change (forward slashes become hyphens).
export function catToSlug(label: string): string {
	if (KNOWN_SLUGS[label]) return KNOWN_SLUGS[label];
	return label
		.toLowerCase()
		.replace(/\s*\/\s*/g, "-")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

// Short display name for titles and nav labels.
// Uses hardcoded map first; falls back to the first segment before " / ".
export function catShortName(label: string): string {
	const known: Record<string, string> = {
		"Arts / Exhibition": "Arts",
		"Community / Other": "Community",
		"Concert / Music": "Music",
		"Public Lecture": "Talks",
		"Social / Meetup": "Social",
		"Workshop / Class": "Workshops",
	};
	return known[label] ?? label.split(/\s*\/\s*/)[0].trim();
}
