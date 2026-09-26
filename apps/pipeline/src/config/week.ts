import { addDays, zonedDate, zonedMidnight } from "@dothingslol/utils/tz";

export function getWeekRange(
	now: Date,
	timeZone: string,
): {
	monday: Date;
	sunday: Date;
} {
	const today = zonedDate(timeZone, now);
	const day = new Date(`${today}T00:00:00Z`).getUTCDay();
	const monday = addDays(today, day === 0 ? 1 : 1 - day);
	return {
		monday: zonedMidnight(timeZone, monday),
		sunday: zonedMidnight(timeZone, addDays(monday, 6)),
	};
}

export function fmtDate(d: Date, timeZone: string): string {
	return d.toLocaleDateString("en-AU", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone,
	});
}
