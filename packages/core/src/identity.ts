// Which key the web's saved, hidden and disliked sets store an event under.
// eventHash (shared.ts) is the public identity; this one is older and frozen.

import type { EventData } from "./schema.ts";

/** The identity saved/hidden sets are keyed by. Not eventHash: stars already
 * in people's localStorage use this basis, and changing it would lose them. */
export function eventId(event: EventData): string {
	return event.title + event.datetime_iso;
}
