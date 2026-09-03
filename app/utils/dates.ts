const MONTH_NUM: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

function localDateStr(offset: number): string {
	const d = new Date();
	return new Date(
		d.getFullYear(),
		d.getMonth(),
		d.getDate() + offset,
	).toLocaleDateString("sv");
}

/** Shifts a YYYY-MM-DD string by whole days. Built on local Date arithmetic
 * rather than string maths so month and year ends are the platform's problem. */
export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	d.setDate(d.getDate() + days);
	return d.toLocaleDateString("sv");
}

/** Last day of the month containing `iso`, as YYYY-MM-DD. */
export function endOfMonth(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	// Day 0 of the next month is the last day of this one.
	return new Date(d.getFullYear(), d.getMonth() + 1, 0).toLocaleDateString(
		"sv",
	);
}

/** Monday of the week containing `iso`, as YYYY-MM-DD. */
export function startOfWeek(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	// getDay: Sunday is 0, so Sunday belongs to the week that started six days ago.
	return addDays(iso, -((d.getDay() + 6) % 7));
}

export function todayIso(): string {
	return localDateStr(0);
}
export function tomorrowIso(): string {
	return localDateStr(1);
}

export function parseEndDate(dt: string, startIso: string): string {
	if (!startIso) return "";
	const year = startIso.slice(0, 4);
	const pad = (n: number) => String(n).padStart(2, "0");
	const short = dt.match(/\b(\d{1,2})\s*[–—-]\s*(\d{1,2})\s+([A-Za-z]{3})\b/);
	if (short) {
		const mon = MONTH_NUM[short[3].toLowerCase()];
		if (mon) return `${year}-${pad(mon)}-${pad(+short[2])}`;
	}
	const all = [...dt.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3})\b/g)];
	if (all.length >= 2) {
		const last = all[all.length - 1];
		const mon = MONTH_NUM[last[2].toLowerCase()];
		if (mon) return `${year}-${pad(mon)}-${pad(+last[1])}`;
	}
	return startIso.slice(0, 10);
}

export function fmtRange(a: string, b: string): string {
	const fmt = (d: string) =>
		new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", {
			day: "numeric",
			month: "short",
		});
	return `${fmt(a)} – ${fmt(b)}`;
}
