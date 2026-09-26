import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildDayFile,
	buildWeekFile,
	type CityPayload,
	getDayDates,
	mapEvent,
	validateOutput,
} from "./ai.ts";

const TZ = "Australia/Brisbane";

test("mapEvent maps and normalises a well-formed event", () => {
	const compact = mapEvent(
		{
			title: "Trivia Night",
			datetime_iso: "2026-09-18T19:00:00",
			datetime_end_iso: "2026-09-18T21:00:00",
			location: "Home of the Arts, Bundall",
			category: "Social / Meetup",
			cost: "$10",
			description: "A **fun** night [book here](https://x.example) of trivia.",
			score: 8,
		},
		"goldcoast",
		TZ,
	);
	assert.ok(compact);
	assert.equal(compact.start, "2026-09-18T19:00:00+10:00");
	assert.equal(compact.end, "2026-09-18T21:00:00+10:00");
	assert.equal(compact.price, 10);
	assert.equal(compact.free, false);
	assert.ok(!compact.description.includes("["), "markdown link stripped");
	assert.ok(compact.url.startsWith("https://www.dothings.lol/gold-coast/e/"));
});

test("mapEvent treats a zero-cost string as free with a numeric price of 0", () => {
	const compact = mapEvent(
		{
			title: "Free Yoga",
			datetime_iso: "2026-09-18T07:00:00",
			cost: "AUD 0",
		},
		"brisbane",
		TZ,
	);
	assert.ok(compact);
	assert.equal(compact.price, 0);
	assert.equal(compact.free, true);
});

test("mapEvent leaves end null rather than guessing a duration", () => {
	const compact = mapEvent(
		{ title: "Art Talk", datetime_iso: "2026-09-18T18:00:00" },
		"brisbane",
		TZ,
	);
	assert.ok(compact);
	assert.equal(compact.end, null);
});

test("mapEvent drops an event with no usable title or start", () => {
	assert.equal(
		mapEvent({ datetime_iso: "2026-09-18T18:00:00" }, "brisbane", TZ),
		null,
	);
	assert.equal(mapEvent({ title: "No date" }, "brisbane", TZ), null);
});

test("getDayDates covers today() through week_end, and is empty once the week has passed", () => {
	const payload: CityPayload = {
		city: "Brisbane",
		city_key: "brisbane",
		week_start: "2026-09-14",
		week_end: "2026-09-20",
		timezone: TZ,
		events: [],
	};
	assert.deepEqual(getDayDates(payload, "2026-09-17"), [
		"2026-09-17",
		"2026-09-18",
		"2026-09-19",
		"2026-09-20",
	]);
	assert.deepEqual(getDayDates(payload, "2026-09-21"), []);
});

test("a multi-day event appears in every day file it spans, and only those", () => {
	const payload: CityPayload = {
		city: "Brisbane",
		city_key: "brisbane",
		week_start: "2026-09-14",
		week_end: "2026-09-20",
		timezone: TZ,
		events: [
			{
				title: "Archie Moore: kith and kin",
				datetime_iso: "2026-09-15T10:00:00",
				datetime_end_iso: "2026-09-18",
				location: "GOMA",
				score: 8,
			},
		],
	};
	assert.equal(buildDayFile(payload, "2026-09-14", TZ).events.length, 0);
	assert.equal(buildDayFile(payload, "2026-09-16", TZ).events.length, 1);
	assert.equal(buildDayFile(payload, "2026-09-18", TZ).events.length, 1);
	assert.equal(buildDayFile(payload, "2026-09-19", TZ).events.length, 0);
});

test("day and week files drop events below the score floor", () => {
	const payload: CityPayload = {
		city: "Brisbane",
		city_key: "brisbane",
		week_start: "2026-09-14",
		week_end: "2026-09-20",
		timezone: TZ,
		events: [
			{
				title: "Schnitzel Night",
				datetime_iso: "2026-09-16T18:00:00",
				score: 1,
			},
			{ title: "Real Event", datetime_iso: "2026-09-16T18:00:00", score: 6 },
		],
	};
	assert.equal(buildDayFile(payload, "2026-09-16", TZ).events.length, 1);
	assert.equal(buildWeekFile(payload, TZ).events.length, 1);
});

test("events are sorted by start time", () => {
	const payload: CityPayload = {
		city: "Brisbane",
		city_key: "brisbane",
		week_start: "2026-09-14",
		week_end: "2026-09-20",
		timezone: TZ,
		events: [
			{ title: "Later", datetime_iso: "2026-09-16T20:00:00", score: 6 },
			{ title: "Earlier", datetime_iso: "2026-09-16T09:00:00", score: 6 },
		],
	};
	const file = buildDayFile(payload, "2026-09-16", TZ);
	assert.deepEqual(
		file.events.map((e) => e.title),
		["Earlier", "Later"],
	);
});

test("a day file is not trimmed for size — every score>=4 event survives regardless of file size", () => {
	const manyEvents = Array.from({ length: 400 }, (_, i) => ({
		title: `Event number ${i} with a moderately long descriptive title`,
		datetime_iso: "2026-09-16T18:00:00",
		location: "Some Venue, Some Suburb",
		description:
			"A reasonably long description that pads out the file size " +
			"so a few hundred of these comfortably exceed 100 KB.",
		score: 4,
	}));
	const payload: CityPayload = {
		city: "Brisbane",
		city_key: "brisbane",
		week_start: "2026-09-14",
		week_end: "2026-09-20",
		timezone: TZ,
		events: manyEvents,
	};
	const file = buildDayFile(payload, "2026-09-16", TZ);
	assert.equal(file.events.length, manyEvents.length);
	assert.ok(
		Buffer.byteLength(JSON.stringify(file), "utf-8") > 100 * 1024,
		"file is genuinely over 100 KB and stays that way",
	);
});

test("validateOutput rejects an index.json that references a missing file", () => {
	assert.throws(
		() =>
			validateOutput(
				"/nonexistent/dir/index.json.does.not.exist.for.this.test",
				{},
			),
		/does not exist/,
	);
});
