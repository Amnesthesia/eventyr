// Which calendar the viewer most likely uses, guessed from their platform.
//
// There is no web API for "add this to my calendar", so every route is a
// compromise: Apple devices take an .ics URL and open the Add Event sheet
// natively, while everyone else is best served by a prefilled Google Calendar
// template. Guessing wrong is recoverable — long-press on a card reaches the
// full list — so this optimises the common case rather than trying to be right
// for everybody.

export type CalendarTarget = "apple" | "google";

/**
 * Deliberately runs only in the browser and only when asked.
 *
 * These components render into the static HTML too, and a value read during
 * SSR would differ from the value read after hydration — React would warn and
 * the markup would flicker. Callers read this in an effect or on click, and
 * "google" is the pre-hydration default because it is the larger audience and
 * because its failure mode (a browser tab) is gentler than a stray download.
 */
export function calendarTarget(): CalendarTarget {
	if (typeof navigator === "undefined") return "google";
	// userAgentData is the modern, unspoofed-by-default answer where it exists;
	// Safari and Firefox still have only the UA string.
	const platform =
		(navigator as { userAgentData?: { platform?: string } }).userAgentData
			?.platform ?? "";
	const ua = navigator.userAgent || "";
	if (/android/i.test(ua)) return "google";
	// iPadOS reports itself as a Mac, and the only reliable tell is that Macs
	// do not have a touchscreen. Both answers are "apple" here, so this only
	// matters if the two ever diverge — but leaving it out invites the classic
	// "iPad is treated as desktop" bug the next time they do.
	const iOS = /iphone|ipad|ipod/i.test(ua);
	const macish = /mac/i.test(platform) || /macintosh|mac os x/i.test(ua);
	return iOS || macish ? "apple" : "google";
}
