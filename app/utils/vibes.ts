// The four vibe flags, their labels, and the order they are shown in.
//
// Shared by VibeFilter (the filter bar) and EventCard (the chips on a card) so
// the two cannot disagree about what "hands_on" is called — the card chips
// toggle the filter, and a label mismatch there would read as two features.
import type { Event, VibeKey } from "../types";

export const VIBE_KEYS: VibeKey[] = [
	"intellectual",
	"creative",
	"hands_on",
	"social",
];

export const VIBE_LABELS: Record<VibeKey, string> = {
	intellectual: "Stimulating",
	creative: "Creative",
	hands_on: "Hands On",
	social: "Social",
};

/** Lowercased vibe labels, for stripping free tags that collide with one.
 * "social" and "hands on" exist in both vocabularies, and the same word in two
 * chips with two meanings is the defect this removes. */
export const VIBE_LABEL_SET = new Set(
	Object.values(VIBE_LABELS).map((l) => l.toLowerCase()),
);

/** The vibes an event actually has, in a stable order. */
export function vibesOf(event: Event): VibeKey[] {
	return VIBE_KEYS.filter((key) => event[key] === true);
}
