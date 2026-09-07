// Encodes a set of saved events into a URL, and reads it back.
//
// This is what the QR code carries. A saved set lives in the viewer's own
// localStorage and never reaches a server, so the only way to move it to
// another device — or to hand it to someone else — is to put it in the link
// itself.
//
// The ids are eventHash, not the eventId that keys localStorage: eventHash is
// short (a base36 uint32, ~7 characters) and is already the site's public
// identity for an event, used by the iCal UID, the RSS guid and the share URL.
// eventId is the event's whole title, which would blow up a QR code.
//
// In the fragment rather than the query string: it is never sent to a server,
// it costs nothing at build time, and /{city}/ already ships the whole city's
// events to the browser, so the receiving page can resolve the ids with no
// network call and no new route.

import { eventHash, KEY_TO_SLUG, SITE_URL } from "../../src/shared.ts";
import type { Event } from "../types";

const PARAM = "cal";
const SEPARATOR = ".";

/**
 * Beyond this many events the QR code stops being reliably scannable at
 * screen size, so the modal offers the .ics instead. The link itself still
 * works — this only bounds what is worth drawing.
 */
export const QR_EVENT_LIMIT = 60;

export function savedCalendarUrl(events: Event[], cityKey: string): string {
	const citySlug = KEY_TO_SLUG[cityKey] ?? cityKey;
	const ids = events.map((e) => eventHash(cityKey, e)).join(SEPARATOR);
	return `${SITE_URL}/${citySlug}/#${PARAM}=${ids}`;
}

/**
 * The ids in a URL fragment, or null when it carries none — which is the
 * normal case and must not be confused with "a shared link holding nothing".
 */
export function parseSavedIds(hash: string): string[] | null {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	const raw = params.get(PARAM);
	if (raw === null) return null;
	return raw.split(SEPARATOR).filter(Boolean);
}

/**
 * The events those ids name, in the order the link listed them.
 *
 * Ids that resolve to nothing are skipped rather than reported: a link shared
 * last week points at events this week's digest has already dropped, and
 * showing the ones that survive beats showing an error.
 */
export function eventsFromIds(
	ids: string[],
	events: Event[],
	cityKey: string,
): Event[] {
	const byHash = new Map(events.map((e) => [eventHash(cityKey, e), e]));
	return ids
		.map((id) => byHash.get(id))
		.filter((e): e is Event => e !== undefined);
}
