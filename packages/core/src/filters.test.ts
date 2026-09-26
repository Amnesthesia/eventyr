import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyFilters,
	coverage,
	DEFAULT_FILTERS,
	dateBounds,
	type FilterContext,
	type FilterState,
	facetCounts,
	hasActiveFilters,
	hiddenCount,
	isPast,
	liveCounts,
	MAX_PICKS,
	splitSections,
	VISIBLE_TAGS,
	visibleTags,
} from "./filters.ts";
import { EVENTS, ev, TODAY, WEEK } from "./fixtures/events.ts";
import { eventId } from "./identity.ts";
import type { EventData } from "./schema.ts";
import { TOP_PICK_THRESHOLD } from "./shared.ts";

const ctx: FilterContext = { today: TODAY, hidden: new Set(), keyOf: eventId };
const titles = (events: readonly EventData[]) => events.map((e) => e.title);
const run = (f: Partial<FilterState>, c: Partial<FilterContext> = {}) =>
	applyFilters(EVENTS, { ...DEFAULT_FILTERS, ...f }, { ...ctx, ...c });
const shown = (f: Partial<FilterState>, c?: Partial<FilterContext>) =>
	titles(run(f, c).filtered);

test("defaults: past and low-scored events drop, unscored and undated stay", () => {
	const { filtered, lowScored } = run({});
	const t = titles(filtered);
	assert.ok(!t.includes("Monday Market"), "past");
	assert.ok(!t.includes("Happy Hour"), "below the floor");
	assert.ok(
		t.includes("Unscored Meetup"),
		"unscored is never hidden by minScore",
	);
	assert.ok(t.includes("Someday Thing"), "undated is never past");
	// Only what the floor alone removed: Old Trivia is low-scored but also past.
	assert.deepEqual(titles(lowScored), ["Happy Hour"]);
});

test("today unknown (pre-mount): nothing is past", () => {
	assert.ok(shown({}, { today: "" }).includes("Monday Market"));
	assert.deepEqual(titles(run({}, { today: "" }).lowScored), [
		"Happy Hour",
		"Old Trivia",
	]);
});

test("isPast compares the end date, else the start", () => {
	assert.equal(
		isPast(ev({ title: "a", datetime_iso: "2026-09-29T10:00" }), TODAY),
		true,
	);
	assert.equal(
		isPast(
			ev({
				title: "a",
				datetime_iso: "2026-09-29",
				datetime_end_iso: "2026-09-30",
			}),
			TODAY,
		),
		false,
	);
	assert.equal(isPast(ev({ title: "a" }), TODAY), false);
});

test("category", () => {
	assert.deepEqual(shown({ category: "Concert / Music" }), [
		"Jazz at the Tivoli",
		"Late Set",
		"Next Week Gala",
	]);
});

test("venue", () => {
	assert.deepEqual(shown({ venue: "The Tivoli" }), [
		"Jazz at the Tivoli",
		"Late Set",
	]);
});

test("date range matches multi-day events by overlap", () => {
	const t = shown({ range: { start: "2026-10-02", end: "2026-10-02" } });
	assert.ok(t.includes("Long Exhibition"), "runs Feb → Apr");
	assert.ok(t.includes("Four-Day Festival"), "29 Sep → 2 Oct");
	assert.ok(t.includes("Late Set"));
	assert.ok(!t.includes("Jazz at the Tivoli"));
	assert.ok(!t.includes("Someday Thing"), "undated overlaps no range");
});

test("tags are ANDed", () => {
	assert.deepEqual(shown({ tags: ["free"] }), [
		"Café Poetry Night",
		"Morning Yoga",
	]);
	assert.deepEqual(shown({ tags: ["free", "poetry"] }), ["Café Poetry Night"]);
});

test("vibes are ANDed", () => {
	assert.deepEqual(shown({ vibes: ["intellectual", "creative"] }), [
		"Long Exhibition",
	]);
});

test("time bands: untimed events drop, bands OR, evening wraps past midnight", () => {
	assert.deepEqual(shown({ timeBands: ["morning"] }), [
		"Morning Yoga",
		...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Pick Candidate ${n}`),
	]);
	const evening = shown({ timeBands: ["evening"] });
	assert.ok(evening.includes("Late Set"), "01:00 is evening");
	assert.ok(
		!evening.includes("Long Exhibition") && !evening.includes("Someday Thing"),
		"untimed",
	);
	const both = shown({ timeBands: ["morning", "evening"] });
	assert.ok(both.includes("Morning Yoga") && both.includes("Late Set"));
	assert.equal(
		shown({ timeBands: ["afternoon"] }).includes("Lunchtime Lecture"),
		true,
	);
});

test("past: include and only", () => {
	assert.ok(shown({ past: "all" }).includes("Monday Market"));
	assert.deepEqual(shown({ past: "only-past" }), ["Monday Market"]);
	assert.deepEqual(titles(run({ past: "only-past" }).lowScored), [
		"Old Trivia",
	]);
});

test("minScore: unscored events are never hidden", () => {
	const { filtered, lowScored } = run({ minScore: 9 });
	assert.deepEqual(titles(filtered), [
		"Lunchtime Lecture",
		"Unscored Meetup",
		"Next Week Gala",
		"Pick Candidate 3",
		"Pick Candidate 6",
		"Pick Candidate 8",
	]);
	assert.ok(!titles(lowScored).includes("Unscored Meetup"));
	assert.equal(shown({ minScore: 0 }).includes("Happy Hour"), true);
});

test("search: diacritic-insensitive, tokens ANDed", () => {
	assert.deepEqual(shown({ query: "cafe" }), ["Café Poetry Night"]);
	assert.deepEqual(shown({ query: "café" }), ["Café Poetry Night"]);
	assert.deepEqual(shown({ query: "music live" }), [
		"Jazz at the Tivoli",
		"Late Set",
	]);
	assert.deepEqual(shown({ query: "jazz tivoli" }), ["Jazz at the Tivoli"]);
	assert.deepEqual(shown({ query: "jaz" }), ["Jazz at the Tivoli"]);
	assert.deepEqual(
		shown({ query: "poetyr" }),
		["Café Poetry Night"],
		"one typo on a 4+ token",
	);
	assert.deepEqual(shown({ query: "  " }), shown({}));
});

test("hidden events are excluded under whichever keyOf is passed", () => {
	const [twinA, twinB] = EVENTS.filter((e) => e.title === "Twin Talk");
	const byLink = (e: EventData) => e.link;
	// eventId can't tell the twins apart: hiding one hides both.
	assert.equal(
		shown({}, { hidden: new Set([eventId(twinA)]) }).filter(
			(t) => t === "Twin Talk",
		).length,
		0,
	);
	// Keyed by link, only the one hidden goes.
	const onlyB = run(
		{},
		{ hidden: new Set([byLink(twinA)]), keyOf: byLink },
	).filtered;
	assert.deepEqual(
		onlyB.filter((e) => e.title === "Twin Talk"),
		[twinB],
	);
	// A set written under one key basis means nothing under the other.
	assert.equal(
		shown({}, { hidden: new Set([byLink(twinA)]) }).length,
		shown({}).length,
	);
	assert.equal(hiddenCount(EVENTS, new Set([eventId(twinA)]), eventId), 2);
	assert.equal(hiddenCount(EVENTS, new Set([byLink(twinA)]), byLink), 1);
});

test("hasActiveFilters: false at defaults, true for every field", () => {
	assert.equal(hasActiveFilters(DEFAULT_FILTERS), false);
	assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, query: "   " }), false);
	const changes: Partial<FilterState>[] = [
		{ category: "Public Lecture" },
		{ venue: "Museum" },
		{ range: { start: TODAY, end: TODAY } },
		{ tags: ["art"] },
		{ vibes: ["social"] },
		{ timeBands: ["morning"] },
		{ query: "jazz" },
		{ minScore: 0 },
		{ past: "all" },
	];
	for (const change of changes) {
		assert.equal(
			hasActiveFilters({ ...DEFAULT_FILTERS, ...change }),
			true,
			JSON.stringify(change),
		);
	}
});

const split = (
	filtered: readonly EventData[],
	starred: string[] = [],
	keyOf = eventId,
	range = null,
) =>
	splitSections(filtered, {
		starred: new Set(starred),
		keyOf,
		taste: {},
		tagPrefs: {},
		range,
		weekStart: WEEK.week_start,
		weekEnd: WEEK.week_end,
	});

test("picks: at most nine, each 7+ and starting inside the window", () => {
	const { filtered } = run({});
	const { saved, picks, rest } = split(filtered);
	assert.equal(saved.length, 0);
	assert.equal(picks.length, MAX_PICKS);
	for (const p of picks) {
		assert.ok((p.score ?? 0) >= TOP_PICK_THRESHOLD, p.title);
		const start = p.datetime_iso.slice(0, 10);
		assert.ok(start >= WEEK.week_start && start <= WEEK.week_end, p.title);
	}
	const r = titles(rest);
	assert.ok(r.includes("Long Exhibition"), "7+ but started in February");
	assert.ok(r.includes("Next Week Gala"), "7+ but starts after the window");
	// Everything lands in exactly one section.
	assert.equal(picks.length + rest.length, filtered.length);
	// The highest scores win the row (empty taste profile: score order).
	assert.equal(picks[0].title, "Pick Candidate 6");
});

test("picks: a selected range replaces the week as the window", () => {
	const { filtered } = run({
		range: { start: "2026-10-06", end: "2026-10-06" },
	});
	const { picks } = splitSections(filtered, {
		starred: new Set(),
		keyOf: eventId,
		taste: {},
		tagPrefs: {},
		range: { start: "2026-10-06", end: "2026-10-06" },
		weekStart: WEEK.week_start,
		weekEnd: WEEK.week_end,
	});
	assert.deepEqual(titles(picks), ["Next Week Gala"]);
});

test("saved events only appear in Saved, keyed by keyOf", () => {
	const { filtered } = run({});
	const jazz = filtered.find(
		(e) => e.title === "Jazz at the Tivoli",
	) as EventData;
	const { saved, picks, rest } = split(filtered, [eventId(jazz)]);
	assert.deepEqual(saved, [jazz]);
	assert.ok(!picks.includes(jazz) && !rest.includes(jazz));
	// The same set under a different key basis stars nothing.
	assert.equal(split(filtered, [eventId(jazz)], (e) => e.link).saved.length, 0);
});

test("facetCounts: categories, venues, and a tag pool without vibe names", () => {
	const { categories, venues, tags } = facetCounts(EVENTS);
	assert.deepEqual(categories, [
		"Concert / Music",
		"Social / Meetup",
		"Workshop / Class",
		"Public Lecture",
		"Arts / Exhibition",
		"Community / Other",
	]);
	assert.deepEqual(venues, [
		{ name: "Café Nook", count: 1 },
		{ name: "Museum", count: 2 },
		{ name: "State Library", count: 1 },
		{ name: "The Tivoli", count: 2 },
	]);
	for (const vibeName of ["social", "Social", "hands on"])
		assert.ok(!tags.includes(vibeName), vibeName);
	// Most common first, ties alphabetical.
	assert.deepEqual(tags.slice(0, 4), ["art", "free", "live music", "ceramics"]);
});

test("liveCounts counts only what is passed in", () => {
	const { tags, vibes } = liveCounts(
		run({ category: "Concert / Music" }).filtered,
	);
	assert.equal(tags.get("live music"), 2);
	assert.equal(tags.get("art"), undefined);
	assert.deepEqual(vibes, {
		intellectual: 0,
		creative: 0,
		hands_on: 0,
		social: 1,
	});
});

test("visibleTags: head, typeahead, and selected tags always kept", () => {
	const pool = Array.from(
		{ length: 80 },
		(_, i) => `tag${String(i).padStart(2, "0")}`,
	);
	assert.equal(visibleTags(pool, "", []).length, VISIBLE_TAGS);
	assert.equal(visibleTags(pool, "TAG", []).length, 60);
	assert.deepEqual(
		visibleTags(pool, " tag7 ", []),
		pool.filter((t) => t.startsWith("tag7")),
	);
	assert.ok(visibleTags(pool, "", ["tag79"]).includes("tag79"));
});

test("dateBounds: min is the digest day, max capped at the end of coverage's month", () => {
	assert.deepEqual(dateBounds({ ...WEEK, events: EVENTS }), {
		dateMin: "2026-09-27",
		dateMax: "2026-10-31",
	});
	const short = [ev({ title: "x", datetime_iso: "2026-10-02T10:00:00" })];
	assert.deepEqual(dateBounds({ ...WEEK, events: short }), {
		dateMin: "2026-09-27",
		dateMax: "2026-10-02",
	});
	assert.deepEqual(dateBounds({ ...WEEK, generated_at: "", events: [] }), {
		dateMin: "2026-09-28",
		dateMax: "2026-10-04",
	});
});

test("coverage: never starts before the viewer's Monday", () => {
	// Earliest start is February; pre-mount the floor is the digest's Monday.
	assert.deepEqual(coverage({ ...WEEK, events: EVENTS }, ""), {
		weekStart: "2026-09-28",
		weekEnd: "2026-10-06",
	});
	// A viewer in the following week: floor is that Monday.
	assert.deepEqual(coverage({ ...WEEK, events: EVENTS }, "2026-10-06"), {
		weekStart: "2026-10-05",
		weekEnd: "2026-10-06",
	});
	assert.deepEqual(coverage({ ...WEEK, events: [] }, TODAY), {
		weekStart: "2026-09-28",
		weekEnd: "2026-10-04",
	});
});
