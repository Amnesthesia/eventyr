import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	DATA_ROOT,
	loadCityConfig,
	PROJECT_ROOT,
	requireEnv,
} from "./common.ts";

const CITY = requireEnv("CITY");

function parseDt(
	s: string,
): { start: string; end: string; allDay: boolean } | null {
	if (!s) return null;

	// Try datetime formats
	const dtMatch = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/);
	if (dtMatch) {
		const dt = new Date(s.length === 16 ? `${s}:00` : s);
		if (Number.isNaN(dt.getTime())) return null;
		const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").slice(0, 15); // YYYYMMDDTHHmmss
		const start = fmt(dt);
		const end = fmt(new Date(dt.getTime() + 2 * 60 * 60 * 1000));
		return { start, end, allDay: false };
	}

	// Try date-only
	const dateMatch = s.match(/^(\d{4}-\d{2}-\d{2})$/);
	if (dateMatch) {
		const start = s.replace(/-/g, "");
		return { start, end: start, allDay: true };
	}

	return null;
}

function esc(s: string): string {
	return String(s)
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\n/g, "\\n");
}

function fold(line: string): string {
	const out: string[] = [];
	while (Buffer.byteLength(line, "utf-8") > 75) {
		// split at safe byte boundary
		let i = 75;
		while (Buffer.byteLength(line.slice(0, i), "utf-8") > 75) i--;
		out.push(line.slice(0, i));
		line = ` ${line.slice(i)}`;
	}
	out.push(line);
	return out.join("\r\n");
}

function main(): void {
	const cfg = loadCityConfig(CITY);
	const tz = cfg.timezone ?? "UTC";
	const cityName = cfg.name;

	const dataPath = join(DATA_ROOT, `${CITY}.json`);
	if (!existsSync(dataPath)) {
		throw new Error(`✗ ${dataPath} not found. Run curate.ts first.`);
	}

	const payload = JSON.parse(readFileSync(dataPath, "utf-8")) as Record<
		string,
		unknown
	>;
	const events = (payload.events as Record<string, unknown>[]) ?? [];

	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:-//do things//${CITY}//EN`,
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		fold(`X-WR-CALNAME:${cityName} — do things`),
		`X-WR-TIMEZONE:${tz}`,
	];

	let count = 0;
	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		const parsed = parseDt((ev.datetime_iso as string) ?? "");
		if (!parsed) continue;

		const { start, end, allDay } = parsed;
		const dtStart = allDay
			? `DTSTART;VALUE=DATE:${start}`
			: `DTSTART;TZID=${tz}:${start}`;
		const dtEnd = allDay
			? `DTEND;VALUE=DATE:${start}`
			: `DTEND;TZID=${tz}:${end}`;

		lines.push(
			"BEGIN:VEVENT",
			`UID:${CITY}-${i}@dothings`,
			dtStart,
			dtEnd,
			fold(`SUMMARY:${esc((ev.title as string) ?? "")}`),
			fold(`DESCRIPTION:${esc((ev.description as string) ?? "")}`),
			fold(`LOCATION:${esc((ev.location as string) ?? "")}`),
			fold(`URL:${(ev.link as string) ?? ""}`),
			"END:VEVENT",
		);
		count++;
	}

	lines.push("END:VCALENDAR");

	const outPath = join(PROJECT_ROOT, "public", `${CITY}.ics`);
	writeFileSync(outPath, `${lines.join("\r\n")}\r\n`, "utf-8");
	console.log(`→ Written ${CITY}.ics (${count} events)`);
}

main();
