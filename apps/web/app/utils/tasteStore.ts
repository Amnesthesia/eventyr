// Where the taste profile is kept in this browser, and the two signals that
// write to it outside React state (sharing and calendaring an event). The
// profile itself, and how it orders events, is @dothingslol/core/taste.

import type { EventData } from "@dothingslol/core/schema";
import { eventHash } from "@dothingslol/core/shared";
import { STORAGE_KEYS } from "@dothingslol/core/storageKeys";
import { bumpTaste, type TasteProfile } from "@dothingslol/core/taste";

const KEY = STORAGE_KEYS.taste;

export function loadTaste(): TasteProfile {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? (JSON.parse(raw) as TasteProfile) : {};
	} catch {
		return {};
	}
}

export function saveTaste(profile: TasteProfile): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(profile));
	} catch {
		// Private mode or storage disabled: still works for this view.
	}
}

// ---------------------------------------------------------------------------
// Weaker signals: sharing an event and adding it to a calendar
// ---------------------------------------------------------------------------

/** Events already counted for a given signal, keyed by eventHash, so mashing
 * Share on one event cannot bend the whole profile toward it. */
const NOTED_KEY = STORAGE_KEYS.tasteNoted;

/** Same-document writes do not fire `storage`, so the profile announces its own
 * changes and the provider re-reads. Without it a share written straight to
 * localStorage would be overwritten by the next bookmark, which bumps from the
 * provider's in-memory copy. */
const CHANGE_EVENT = "eventyr:taste-change";

type InterestSignal = "share" | "calendar";

function loadNoted(): Set<string> {
	if (typeof localStorage === "undefined") return new Set();
	try {
		const raw = localStorage.getItem(NOTED_KEY);
		return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
	} catch {
		return new Set();
	}
}

/** Count a share or an add-to-calendar the same way a bookmark is counted.
 *
 * Both say "this one, not the others", which is the same thing the ranking
 * wants to know. Unlike a bookmark it is one-way — there is no un-sharing — so
 * it is counted once per event per signal and never decremented.
 *
 * Reads the stored profile rather than taking one as an argument, so any
 * component can call this without the events context. */
export function noteInterest(
	event: EventData,
	cityKey: string,
	signal: InterestSignal,
): void {
	if (typeof localStorage === "undefined") return;
	// eventHash, not the eventId the starred set uses: this is a fresh key with
	// no stored history to preserve, and eventHash is already the identity for
	// iCal UIDs, RSS guids and share URLs.
	const marker = `${signal}:${eventHash(cityKey, event)}`;
	const noted = loadNoted();
	if (noted.has(marker)) return;
	noted.add(marker);
	const next = bumpTaste(loadTaste(), event, 1);
	try {
		localStorage.setItem(NOTED_KEY, JSON.stringify([...noted]));
	} catch {
		// Private mode: the bump below still applies for this view, it just
		// cannot be deduped across reloads.
	}
	saveTaste(next);
	window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
}

/** Subscribe to profile changes made outside React state. Returns an
 * unsubscribe function, so it drops straight into a useEffect. */
export function onTasteChange(fn: (profile: TasteProfile) => void): () => void {
	const handler: EventListener = (e) =>
		fn((e as CustomEvent<TasteProfile>).detail);
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}
