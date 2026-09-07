// The pure half of rank.ts's reuse logic — split out so it can be unit
// tested without triggering rank.ts's module-level requireEnv("CITY") /
// requireEnv("GOOGLE_API_KEY"), the same reason dedupeClassifier.ts is split
// from dedupe.ts.

import { eventHash } from "./common.ts";

type Event = Record<string, unknown>;

/** A truncated description still identifies the event's substance for reuse
 * purposes, and keeps the prompt small — the longest seen so far is 4,884
 * chars for a field the score barely needs the tail of. */
export const RANK_DESCRIPTION_CHARS = 300;
/** Bump when RANK_SYSTEM or the fields it reads change meaning, so a reused
 * score can never answer a question the current prompt no longer asks. */
export const RANK_PROMPT_VERSION = "v2";

/**
 * What a score is actually a judgement of: the event's identity (title, start,
 * location — same basis as eventHash) plus the fields the prompt shows
 * (category, description truncated the same way, tags) plus the prompt
 * version. Unchanged on all of these ⇒ last week's score is still the answer
 * this week's call would give, so 43% of a typical week's events (whatever
 * carried over unchanged) never need to be asked about again.
 */
export function rankReuseKey(cityKey: string, event: Event): string {
	const tags = ((event.tags as string[]) ?? []).join(",");
	const description = ((event.description as string) ?? "").slice(
		0,
		RANK_DESCRIPTION_CHARS,
	);
	return [
		RANK_PROMPT_VERSION,
		eventHash(cityKey, event),
		(event.category as string) ?? "",
		description,
		tags,
	].join("|");
}
