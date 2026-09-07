import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
	DATA_ROOT,
	eventHash,
	eventSlug,
	KEY_TO_SLUG,
	loadCityConfig,
	meetsScoreFloor,
	PROJECT_ROOT,
	requireEnv,
} from "./common.ts";

const CITY = requireEnv("CITY");

/**
 * Converts the pipeline's naive Brisbane wall-clock strings into the
 * YYYYMMDDTHHMMSS stamps a VEVENT carries under `TZID=Australia/Brisbane`.
 *
 * Done by string surgery on purpose. The previous version did
 * `new Date("2026-09-03T19:30:00").toISOString()`, which parses as the HOST's
 * local time and writes back UTC — an identity only when the host is UTC. On
 * an Australia/Brisbane machine every timed event came out ten hours early
 * (a 7:30pm gig published as 9:30am) while CI happened to be right. The
 * value is already local to `tz`, so it must not be converted at all.
 */
/** YYYYMMDD[THHMMSS] stamp from a naive wall-clock string, no conversion. */
function stamp(value: string): string {
	return value.replace(/[-:]/g, "");
}

/** Adds days to a YYYY-MM-DD string, in UTC so no host offset creeps in. */
function addDays(dateOnly: string, days: number): string {
	const d = new Date(`${dateOnly}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Adds hours to a naive YYYY-MM-DDTHH:MM:SS string, returning the same shape. */
function addHours(naive: string, hours: number): string {
	const d = new Date(`${naive}Z`);
	d.setUTCHours(d.getUTCHours() + hours);
	return d.toISOString().slice(0, 19);
}

const TIMED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Converts the pipeline's naive Brisbane wall-clock strings into the stamps a
 * VEVENT carries under `TZID=<city timezone>`.
 *
 * String surgery on purpose. The previous version did
 * `new Date("2026-09-03T19:30:00").toISOString()`, which parses as the HOST's
 * local time and writes back UTC — an identity only when the host is UTC. On
 * an Australia/Brisbane machine every timed event came out ten hours early (a
 * 7:30pm gig published as 9:30am) while CI happened to be correct. The value
 * is already local to the TZID, so it must not be converted at all.
 */
function parseDt(
	startIso: string,
	endIso?: string,
): { start: string; end: string; allDay: boolean } | null {
	if (!startIso) return null;

	if (TIMED.test(startIso)) {
		const startNaive = startIso.length === 16 ? `${startIso}:00` : startIso;
		// Both collection paths produce datetime_end_iso, and the calendar is
		// the one consumer where an end time is load-bearing — multi-day runs
		// were being published as two hours.
		const endNaive =
			endIso && TIMED.test(endIso) && endIso > startIso
				? endIso.length === 16
					? `${endIso}:00`
					: endIso
				: // ponytail: no usable end published, so assume 2h.
					addHours(startNaive, 2);
		return { start: stamp(startNaive), end: stamp(endNaive), allDay: false };
	}

	if (DATE_ONLY.test(startIso)) {
		// RFC 5545 §3.8.2.2: a VALUE=DATE DTEND is exclusive and must be later
		// than DTSTART. Emitting start === end made every all-day event
		// zero-length, which strict parsers drop entirely.
		const lastDay =
			endIso && DATE_ONLY.test(endIso) && endIso > startIso ? endIso : startIso;
		return {
			start: stamp(startIso),
			end: stamp(addDays(lastDay, 1)),
			allDay: true,
		};
	}

	return null;
}

/**
 * Stable per-event UID. The old `${CITY}-${index}` changed every week because
 * rank.ts re-sorts by score, so subscribers saw every event rewritten and
 * stable events change identity. Same basis as the RSS guid.
 */
function uidFor(city: string, ev: Record<string, unknown>): string {
	// The hash lives in shared.ts, so this and rss.ts's guid cannot drift apart
	// — they used to hold identical copies of it, including the comment about
	// why the venue is in the basis. The `${city}-` prefix must stay: a changed
	// UID makes calendar clients re-add every event.
	return `${city}-${eventHash(city, ev)}`;
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
	// No silent "UTC" fallback: that is exactly how every published .ics ended
	// up stamped TZID=UTC while carrying Brisbane wall-clock times.
	const tz = cfg.timezone;
	if (!tz) {
		throw new Error(
			`✗ sources/${CITY}.yml declares no timezone. Add e.g. "timezone: Australia/Brisbane" — a wrong timezone silently shifts every event in the calendar.`,
		);
	}
	const cityName = cfg.name;

	const dataPath = join(DATA_ROOT, `${CITY}.json`);
	if (!existsSync(dataPath)) {
		throw new Error(`✗ ${dataPath} not found. Run curate.ts first.`);
	}

	const payload = JSON.parse(readFileSync(dataPath, "utf-8")) as Record<
		string,
		unknown
	>;
	// Below LOW_SCORE_THRESHOLD is mostly venue promotion — happy hours, meal
	// deals, schnitzel nights — which rank.ts scores 1. The site hides these by
	// default and a subscriber has no toggle at all, so a feed carrying them
	// would be the one place they still reached a reader.
	const events = ((payload.events as Record<string, unknown>[]) ?? []).filter(
		(e) => meetsScoreFloor(e.score),
	);

	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:-//do things//${CITY}//EN`,
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		fold(`X-WR-CALNAME:${cityName} — do things`),
		`X-WR-TIMEZONE:${tz}`,
	];

	// One builder for both outputs. The per-event files below carry the same
	// VEVENT — the same UID especially, so adding one event and subscribing to
	// the city feed do not produce two copies of it.
	function vevent(ev: Record<string, unknown>): string[] | null {
		const parsed = parseDt(
			(ev.datetime_iso as string) ?? "",
			(ev.datetime_end_iso as string) ?? undefined,
		);
		if (!parsed) return null;
		const { start, end, allDay } = parsed;
		return [
			"BEGIN:VEVENT",
			`UID:${uidFor(CITY, ev)}@dothings`,
			allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART;TZID=${tz}:${start}`,
			allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND;TZID=${tz}:${end}`,
			fold(`SUMMARY:${esc((ev.title as string) ?? "")}`),
			fold(`DESCRIPTION:${esc((ev.description as string) ?? "")}`),
			fold(`LOCATION:${esc((ev.location as string) ?? "")}`),
			fold(`URL:${(ev.link as string) ?? ""}`),
			"END:VEVENT",
		];
	}

	// One .ics per event, at public/{citySlug}/e/{slug}.ics — a sibling of the
	// event page rather than a file inside it, so a static host never has to
	// decide whether the path is a directory or a file.
	//
	// A file in public/ rather than an Astro endpoint route, which was tried
	// first: `trailingSlash: "always"` makes the DEV server 404 every route
	// whose path ends in an extension, so the link worked in a build and was
	// broken in `astro dev`. public/ bypasses routing entirely and behaves the
	// same in both — which is also why these have to be committed: deploy.yml
	// runs `astro build` from a checkout and never runs this script.
	const citySlug = KEY_TO_SLUG[CITY] ?? CITY;
	const eventDir = join(PROJECT_ROOT, "public", citySlug, "e");
	mkdirSync(eventDir, { recursive: true });

	let count = 0;
	let files = 0;
	const written = new Set<string>();
	for (const ev of events) {
		const block = vevent(ev);
		if (!block) continue;
		lines.push(...block);
		count++;

		const single = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			`PRODID:-//do things//${CITY}//EN`,
			"CALSCALE:GREGORIAN",
			fold(`X-WR-CALNAME:${esc((ev.title as string) ?? "")}`),
			`X-WR-TIMEZONE:${tz}`,
			...block,
			"END:VCALENDAR",
		];
		// eventSlug is the same bounded, sanitised value the event page's route
		// uses, so this path cannot escape eventDir.
		const name = `${eventSlug(CITY, ev)}.ics`;
		writeFileSync(join(eventDir, name), `${single.join("\r\n")}\r\n`, "utf-8");
		written.add(name);
		files++;
	}

	// Whatever this run did not write is an event that has since been dropped —
	// a cancelled listing, a wrong-city event curate now rejects. Without this
	// the directory only ever grows and those files keep being served: the
	// Vienna and Manchester meetups curate had already removed were still
	// downloadable as calendar entries. A rule that can only add accumulates
	// stale state no later run can correct.
	let removed = 0;
	for (const name of readdirSync(eventDir)) {
		if (name.endsWith(".ics") && !written.has(name)) {
			rmSync(join(eventDir, name));
			removed++;
		}
	}

	lines.push("END:VCALENDAR");

	const outPath = join(PROJECT_ROOT, "public", `${CITY}.ics`);
	writeFileSync(outPath, `${lines.join("\r\n")}\r\n`, "utf-8");
	console.log(
		`→ Written ${CITY}.ics (${count} events) and ${files} per-event .ics under public/${citySlug}/e/` +
			(removed > 0 ? `, removed ${removed} stale` : ""),
	);
}

main();
