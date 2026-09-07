// Sharing one event, as a function rather than only inside a button, so the
// card's long-press sheet and the Share button behave identically.
import { eventPath, SITE_URL } from "../../src/shared.ts";
import type { Event } from "../types";

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

export function eventUrl(event: Event, cityKey: string): string {
	// Absolute, and from SITE_URL rather than window.location: a link copied
	// while running the dev server has to be shareable, not a localhost URL.
	return `${SITE_URL}${eventPath(cityKey, event)}`;
}

/** Native share sheet where there is one, clipboard where there is not. The
 * saved-events calendar shares a link that is not an event, so this is the
 * half both callers have in common. */
export async function shareUrl(
	url: string,
	title: string,
): Promise<ShareOutcome> {
	try {
		if (navigator.share) {
			await navigator.share({ title, text: title, url });
			return "shared";
		}
		await navigator.clipboard.writeText(url);
		return "copied";
	} catch (err) {
		// Dismissing the share sheet rejects with AbortError. That is a user
		// deciding not to share, not a failure, and must not look like one.
		if ((err as Error)?.name === "AbortError") return "cancelled";
		return "failed";
	}
}

export async function shareEvent(
	event: Event,
	cityKey: string,
): Promise<ShareOutcome> {
	return shareUrl(eventUrl(event, cityKey), event.title);
}
