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

/** The vibes an event actually has, in a stable order. */
export function vibesOf(event: Event): VibeKey[] {
	return VIBE_KEYS.filter((key) => event[key] === true);
}
