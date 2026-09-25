// Saving a built .ics as a file, which needs the DOM. Building one is
// @dothingslol/core/ics.

import { buildEventIcs, icsFilename } from "@dothingslol/core/ics";
import type { EventData } from "@dothingslol/core/schema";

/**
 * Triggers the download. Built as a Blob on click rather than a data: URI at
 * render time: 643 inline URIs would bloat every page, and the content would
 * otherwise be computed during SSR where anything time-dependent differs from
 * the hydrated render.
 */
export function downloadEventIcs(
	event: EventData,
	cityKey: string,
	timezone: string,
): boolean {
	const ics = buildEventIcs(event, cityKey, timezone);
	if (!ics) return false;
	downloadIcs(ics, icsFilename(event));
	return true;
}

export function downloadIcs(ics: string, filename: string): void {
	const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
	const href = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = href;
	a.download = filename;
	a.click();
	// Released on the next tick: revoking synchronously can cancel the download
	// before the browser has read the blob.
	setTimeout(() => URL.revokeObjectURL(href), 0);
}
