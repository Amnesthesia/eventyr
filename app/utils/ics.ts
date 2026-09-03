// A single-event .ics, built in the browser.
//
// src/ical.ts cannot be reused here — it calls requireEnv("CITY") at module
// scope, so importing it into the bundle would throw — but the rules it
// documents are load-bearing and are repeated deliberately:
//
//   * The stamps are naive wall-clock strings and must NOT be converted. The
//     version before it did `new Date(naive).toISOString()`, which parses as
//     the HOST's local time and writes back UTC: on an Australia/Brisbane
//     machine every timed event came out ten hours early (a 7:30pm gig
//     published as 9:30am) while CI happened to be correct. The value is
//     already local to the TZID.
//   * A date with no time is an all-day event: DTSTART;VALUE=DATE with DTEND
//     the following day, because DTEND is exclusive. DTEND == DTSTART renders
//     as a zero-length event and some clients drop it.
//   * TEXT values need escaping and long lines need folding, or clients reject
//     the file.

import { eventHash, eventPath, SITE_URL } from "../../src/shared.ts";
import type { Event } from "../types";

const TIMED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYYMMDD[THHMMSS] from a naive wall-clock string. No conversion. */
function stamp(value: string): string {
	return value.replace(/[-:]/g, "");
}

/** Adds days to a YYYY-MM-DD string, in UTC so no host offset creeps in. */
function addDays(dateOnly: string, days: number): string {
	const d = new Date(`${dateOnly}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function esc(value: string): string {
	return String(value)
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r?\n/g, "\\n");
}

/** RFC 5545 caps a line at 75 octets; continuations start with a space. */
function fold(line: string): string {
	if (line.length <= 75) return line;
	const parts: string[] = [line.slice(0, 75)];
	let rest = line.slice(75);
	while (rest.length > 74) {
		parts.push(` ${rest.slice(0, 74)}`);
		rest = rest.slice(74);
	}
	if (rest) parts.push(` ${rest}`);
	return parts.join("\r\n");
}

/** The VEVENT block for one event, or null when it has no usable date. */
function eventLines(
	event: Event,
	cityKey: string,
	timezone: string,
): string[] | null {
	const start = (event.datetime_iso || "").trim();
	if (!start) return null;

	const lines: string[] = [];
	if (DATE_ONLY.test(start)) {
		const end = (event.datetime_end_iso || "").slice(0, 10) || start;
		lines.push(`DTSTART;VALUE=DATE:${stamp(start)}`);
		// Exclusive, so a one-day event ends the next day.
		lines.push(`DTEND;VALUE=DATE:${stamp(addDays(end, 1))}`);
	} else if (TIMED.test(start)) {
		const raw = (event.datetime_end_iso || "").trim();
		const end = TIMED.test(raw)
			? raw
			: // No usable end: two hours is the assumption src/ical.ts makes, and a
				// calendar entry has to have some duration.
				`${start.slice(0, 11)}${String(
					Number(start.slice(11, 13)) + 2,
				).padStart(2, "0")}${start.slice(13, 19) || ":00:00"}`;
		lines.push(`DTSTART;TZID=${timezone}:${stamp(start)}`);
		lines.push(`DTEND;TZID=${timezone}:${stamp(end)}`);
	} else {
		return null;
	}

	const url = `${SITE_URL}${eventPath(cityKey, event)}`;
	return [
		"BEGIN:VEVENT",
		// The same identity the city-wide feed uses, so adding one event and
		// subscribing to the feed do not produce two copies of it.
		`UID:${cityKey}-${eventHash(cityKey, event)}`,
		...lines,
		`SUMMARY:${esc(event.title)}`,
		event.location ? `LOCATION:${esc(event.location)}` : "",
		`DESCRIPTION:${esc(
			[event.description, event.link || url].filter(Boolean).join("\n\n"),
		)}`,
		`URL:${event.link || url}`,
		"END:VEVENT",
	].filter(Boolean);
}

/**
 * A calendar holding every dated event in `events`. Null when none of them
 * has a date, so a caller never downloads an empty calendar. `name` becomes
 * X-WR-CALNAME, which is what Apple/Google show when the file is imported.
 */
export function buildIcs(
	events: Event[],
	cityKey: string,
	{
		timezone = "Australia/Brisbane",
		name,
	}: { timezone?: string; name?: string } = {},
): string | null {
	const blocks = events
		.map((e) => eventLines(e, cityKey, timezone))
		.filter((b): b is string[] => b !== null);
	if (blocks.length === 0) return null;
	const body = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//dothings.lol//event//EN",
		"CALSCALE:GREGORIAN",
		name ? `X-WR-CALNAME:${esc(name)}` : "",
		...blocks.flat(),
		"END:VCALENDAR",
	].filter(Boolean);
	return `${body.map(fold).join("\r\n")}\r\n`;
}

export function buildEventIcs(
	event: Event,
	cityKey: string,
	timezone = "Australia/Brisbane",
): string | null {
	return buildIcs([event], cityKey, { timezone });
}

/** Filename-safe, and obviously about this event when it lands in Downloads. */
export function icsFilename(event: Event): string {
	const name =
		(event.title || "event")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 50) || "event";
	return `${name}.ics`;
}

/**
 * Triggers the download. Built as a Blob on click rather than a data: URI at
 * render time: 643 inline URIs would bloat every page, and the content would
 * otherwise be computed during SSR where anything time-dependent differs from
 * the hydrated render.
 */
export function downloadEventIcs(event: Event, cityKey: string): boolean {
	const ics = buildEventIcs(event, cityKey);
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
