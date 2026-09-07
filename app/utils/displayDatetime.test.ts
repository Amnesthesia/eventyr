import assert from "node:assert/strict";
import { test } from "node:test";
import { displayDatetime, shortDate } from "./dates";

const TODAY = "2026-09-07";

test("a run already open says so instead of leading with its start", () => {
	// The most common way this site has been misread: an exhibition dated from
	// 2023 in the saved list looks like something already missed.
	assert.equal(
		displayDatetime(
			{
				datetime: "Wed 20 Sep 2023, 10:00 AM – Tue 26 Jan 2027",
				datetime_iso: "2023-09-20T10:00:00",
				datetime_end_iso: "2027-01-26",
			},
			TODAY,
		),
		"On now — until 26 Jan",
	);
});

test("an event that has not started yet keeps its own string", () => {
	const upcoming = {
		datetime: "Thu 10 Sep, 6:00 PM",
		datetime_iso: "2026-09-10T18:00:00",
		datetime_end_iso: "",
	};
	assert.equal(displayDatetime(upcoming, TODAY), "Thu 10 Sep, 6:00 PM");
	// Starting today is not "on now" either — the time still matters.
	assert.equal(
		displayDatetime({ ...upcoming, datetime_iso: `${TODAY}T18:00:00` }, TODAY),
		"Thu 10 Sep, 6:00 PM",
	);
});

test("a finished run is left alone, so the past filter still reads as past", () => {
	assert.equal(
		displayDatetime(
			{
				datetime: "Sat 1 Aug – Sat 29 Aug",
				datetime_iso: "2026-08-01",
				datetime_end_iso: "2026-08-29",
			},
			TODAY,
		),
		"Sat 1 Aug – Sat 29 Aug",
	);
});

test("a past start with no end is not claimed to be on now", () => {
	// Without an end date there is no evidence the thing is still running, and
	// "On now" would be a claim the data does not support.
	assert.equal(
		displayDatetime(
			{
				datetime: "Sat 29 Aug, 10:30 AM",
				datetime_iso: "2026-08-29T10:30:00",
				datetime_end_iso: "",
			},
			TODAY,
		),
		"Sat 29 Aug, 10:30 AM",
	);
});

test("before hydration knows the date, the plain string is used", () => {
	// todayStr is "" until after mount, and the pre-hydration render has to
	// match the server exactly.
	assert.equal(
		displayDatetime(
			{
				datetime: "Wed 20 Sep 2023, 10:00 AM – Tue 26 Jan 2027",
				datetime_iso: "2023-09-20T10:00:00",
				datetime_end_iso: "2027-01-26",
			},
			"",
		),
		"Wed 20 Sep 2023, 10:00 AM – Tue 26 Jan 2027",
	);
});

test("shortDate is hand-built, so it cannot drift with the runtime's ICU", () => {
	assert.equal(shortDate("2026-09-05"), "5 Sep");
	assert.equal(shortDate("2026-12-26T10:00:00"), "26 Dec");
	assert.equal(shortDate("not a date"), "not a date");
});
