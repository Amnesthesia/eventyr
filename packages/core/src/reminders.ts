// When a reminder for a liked event fires, and what it says. The web schedules
// these through the Notification API and its service worker (notifications.ts
// in the web app); native will schedule the same times locally.

import type { EventData } from "./schema.ts";

/**
 * Computes timestamp for 1 hour before an event.
 * If event has no time component (date only), defaults to 8:00 AM on that day.
 */
export function calculate1hReminderTime(datetime_iso: string): number | null {
	if (!datetime_iso) return null;

	// Timed ISO (e.g. 2026-09-07T11:00:00 or 2026-09-07T11:00:00+10:00)
	if (datetime_iso.includes("T")) {
		const startTime = new Date(datetime_iso).getTime();
		if (Number.isNaN(startTime)) return null;
		return startTime - 60 * 60 * 1000;
	}

	// Date-only ISO (e.g. 2026-09-07) -> default to 8:00 AM on that day
	const match = datetime_iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const [, y, m, d] = match;
	const date = new Date(
		Number(y),
		Number(m) - 1,
		Number(d),
		8,
		0,
		0,
		0,
	).getTime();
	if (Number.isNaN(date)) return null;
	return date;
}

/**
 * Format 12-hour time string from event ISO (e.g. "11:00 AM").
 */
export function formatEventTime(datetime_iso: string): string {
	if (!datetime_iso?.includes("T")) return "Today";
	try {
		const date = new Date(datetime_iso);
		let hours = date.getHours();
		const minutes = String(date.getMinutes()).padStart(2, "0");
		const ampm = hours >= 12 ? "PM" : "AM";
		hours = hours % 12 || 12;
		return `${hours}:${minutes} ${ampm}`;
	} catch {
		return "Today";
	}
}

/**
 * Filter events for the morning digest: starts on or overlaps today.
 */
export function filterEventsForMorningDigest(
	events: EventData[],
	today: string,
): EventData[] {
	return events.filter((e) => {
		if (!e) return false;
		const start = (e.datetime_iso || "").slice(0, 10);
		const end = (e.datetime_end_iso || e.datetime_iso || "").slice(0, 10);
		if (!start) return false;
		return start <= today && end >= today;
	});
}

/**
 * Format notification title and body for the morning digest.
 */
export function formatMorningDigest(events: EventData[]): {
	title: string;
	body: string;
} {
	if (events.length === 0) {
		return { title: "Today's Events", body: "No bookmarked events today." };
	}
	if (events.length === 1) {
		const ev = events[0];
		const timeStr = ev.datetime || formatEventTime(ev.datetime_iso);
		const locStr = ev.location ? ` at ${ev.location}` : "";
		return {
			title: `Today: ${ev.title}`,
			body: `${timeStr}${locStr}`,
		};
	}

	const title = `Today's Events (${events.length})`;
	const lines = events
		.slice(0, 3)
		.map(
			(e) => `• ${e.title} (${e.datetime || formatEventTime(e.datetime_iso)})`,
		);
	if (events.length > 3) {
		lines.push(`+ ${events.length - 3} more coming up today`);
	}
	return { title, body: lines.join("\n") };
}
