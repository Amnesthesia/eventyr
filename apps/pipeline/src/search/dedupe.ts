// Per-batch dedupe for a single search provider's own results (google.ts):
// the same event often lands twice within one provider's own extraction
// batches, before curate.ts's cross-source merge ever sees them. Moved out of
// stages/dedupe.ts (1.11 step 7) — its only real caller is search/google.ts,
// and search may not import stages.
import { diceSimilarity } from "@dothingslol/utils/text";

export interface EventFingerprint {
	title: string;
	date: string;
}

function normalizeTitle(title: string): string {
	return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export function fingerprintEvent(
	event: Record<string, unknown>,
): EventFingerprint {
	return {
		title: normalizeTitle((event.title as string) ?? ""),
		date: (
			(event.datetime_iso as string) ??
			(event.datetime as string) ??
			""
		).slice(0, 10),
	};
}

// The same event often shows up once bare ("Board Game Weekly Meetup") and
// once with a venue suffix from a different source ("Board Game Weekly
// Meetup @ Vault Games Brisbane City") — a straight Dice comparison
// undercounts these because the extra suffix dominates the bigram overlap.
// Catch that case with a prefix/containment check before falling back to
// fuzzy matching for typos/reordering.
function titlesMatch(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a))) {
		return true;
	}
	return diceSimilarity(a, b) > 0.85;
}

export function isDuplicateEvent(
	a: EventFingerprint,
	b: EventFingerprint,
): boolean {
	// Both dates must be known and equal. Treating a missing date as
	// "matches anything" let one undated artifact swallow every event whose
	// title it prefixed: ["Live Music" (no date), "Live Music at The Triffid"
	// (3 Sep), "Live Music Sundays" (7 Sep)] collapsed to just the artifact,
	// because the fingerprint scan keeps the first occurrence. Keeping a
	// duplicate is recoverable; deleting a real event is not.
	if (!a.date || !b.date || a.date !== b.date) return false;
	return titlesMatch(a.title, b.title);
}

export function dedupeEvents(
	events: Record<string, unknown>[],
): Record<string, unknown>[] {
	const seen: EventFingerprint[] = [];
	const unique: Record<string, unknown>[] = [];
	for (const event of events) {
		const fp = fingerprintEvent(event);
		if (!seen.some((s) => isDuplicateEvent(fp, s))) {
			unique.push(event);
			seen.push(fp);
		}
	}
	return unique;
}
