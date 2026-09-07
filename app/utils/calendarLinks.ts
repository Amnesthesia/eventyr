// "Add to calendar" as a URL rather than a file.
//
// Both providers accept a prefilled event in a query string, which is the only
// way to hand someone an event without making them download something first.
//
// The stamps are the pipeline's naive wall-clock strings and must NOT be run
// through `new Date(naive).toISOString()` — that parses as the HOST's local
// time and writes back UTC, which is the ten-hour bug ics.ts documents at
// length. Google is told the zone separately via `ctz`; Outlook takes the
// offset inline, which `isoWithOffset` already builds for schema.org.

import { eventPath, isoWithOffset, SITE_URL } from "../../src/shared.ts";
import type { Event } from "../types";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** YYYYMMDD or YYYYMMDDTHHMMSS, the shape Google's template expects. */
function stamp(value: string): string {
	return value.replace(/[-:]/g, "");
}

/** Adds days to a YYYY-MM-DD string, in UTC so no host offset creeps in. */
function addDays(dateOnly: string, days: number): string {
	const d = new Date(`${dateOnly}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * Start and end as naive strings, with the same assumptions ics.ts makes: an
 * all-day event ends the following day because the end is exclusive, and a
 * timed event with no end runs for two hours. Null when there is no usable
 * date, so a caller offers nothing rather than a broken link.
 */
function span(event: Event): { start: string; end: string } | null {
	const start = (event.datetime_iso || "").trim();
	const rawEnd = (event.datetime_end_iso || "").trim();
	if (DATE_ONLY.test(start)) {
		const end = rawEnd.slice(0, 10) || start;
		return { start, end: addDays(end, 1) };
	}
	if (!TIMED.test(start)) return null;
	if (TIMED.test(rawEnd)) return { start, end: rawEnd };
	const hour = Number(start.slice(11, 13)) + 2;
	// A start late enough that +2h crosses midnight would produce "24:00", which
	// no calendar accepts. Ending at 23:59 the same day is wrong by a minute and
	// right by a day, which is the better of the two errors.
	const end =
		hour > 23
			? `${start.slice(0, 11)}23:59:00`
			: `${start.slice(0, 11)}${String(hour).padStart(2, "0")}${start.slice(13, 19) || ":00:00"}`;
	return { start, end };
}

/** The event's own page, which is where the description points when the
 * source gave us no link of its own. */
function eventUrl(event: Event, cityKey: string): string {
	return event.link || `${SITE_URL}${eventPath(cityKey, event)}`;
}

export function googleCalendarUrl(
	event: Event,
	cityKey: string,
	timezone = "Australia/Brisbane",
): string | null {
	const dates = span(event);
	if (!dates) return null;
	const params = new URLSearchParams({
		action: "TEMPLATE",
		text: event.title,
		dates: `${stamp(dates.start)}/${stamp(dates.end)}`,
		details: [event.description, eventUrl(event, cityKey)]
			.filter(Boolean)
			.join("\n\n"),
		ctz: timezone,
	});
	if (event.location) params.set("location", event.location);
	return `https://calendar.google.com/calendar/render?${params}`;
}

export function outlookCalendarUrl(
	event: Event,
	cityKey: string,
	timezone = "Australia/Brisbane",
): string | null {
	const dates = span(event);
	if (!dates) return null;
	const allDay = DATE_ONLY.test(dates.start);
	const params = new URLSearchParams({
		path: "/calendar/action/compose",
		rru: "addevent",
		subject: event.title,
		// Outlook has no ctz equivalent, so the offset travels with the stamp.
		startdt: isoWithOffset(dates.start, timezone) ?? dates.start,
		enddt: isoWithOffset(dates.end, timezone) ?? dates.end,
		body: [event.description, eventUrl(event, cityKey)]
			.filter(Boolean)
			.join("\n\n"),
	});
	if (allDay) params.set("allday", "true");
	if (event.location) params.set("location", event.location);
	return `https://outlook.live.com/calendar/0/deeplink/compose?${params}`;
}

/**
 * The static per-event .ics that `pnpm ical` writes next to the event page.
 *
 * A real URL rather than a Blob on purpose: iOS Safari hands a .ics URL
 * straight to Calendar with no download step, which a blob: URL does not do.
 */
export function appleCalendarUrl(event: Event, cityKey: string): string | null {
	if (!event.datetime_iso) return null;
	// Root-relative, not absolute: this is our own file, and hard-coding
	// SITE_URL sent every local click to production, where a file the dev
	// server had just written did not exist yet.
	//
	// A sibling of the event page rather than a file inside it — /brisbane/e/
	// {slug}.ics next to /brisbane/e/{slug}/ — so a static host never has to
	// decide whether the path is a directory or a file.
	return `${eventPath(cityKey, event).replace(/\/$/, "")}.ics`;
}

export type CalendarKey = "apple" | "google" | "outlook" | "download";

export interface CalendarLink {
	key: CalendarKey;
	label: string;
	/** null for the download, which is a DOM action rather than a link. */
	href: string | null;
}

/**
 * Every route to a calendar for one event, in the order a menu should list
 * them. A route this event cannot be expressed as is left out entirely rather
 * than offered and broken.
 */
export function calendarLinks(
	event: Event,
	cityKey: string,
	timezone?: string,
): CalendarLink[] {
	const rows: CalendarLink[] = [
		{
			key: "google",
			label: "Google Calendar",
			href: googleCalendarUrl(event, cityKey, timezone),
		},
		{
			key: "apple",
			label: "Apple Calendar",
			href: appleCalendarUrl(event, cityKey),
		},
		{
			key: "outlook",
			label: "Outlook",
			href: outlookCalendarUrl(event, cityKey, timezone),
		},
		{ key: "download", label: "Download .ics", href: null },
	];
	return rows.filter((row) => row.key === "download" || row.href !== null);
}
