// Hand-built events for filters.test.ts. Each one exists for an edge case,
// named in its comment. The week is Mon 28 Sep – Sun 4 Oct 2026 and "today"
// is Wednesday 30 Sep.

import type { EventData } from "../schema.ts";

export const WEEK = {
	week_start: "2026-09-28",
	week_end: "2026-10-04",
	generated_at: "2026-09-27",
};
export const TODAY = "2026-09-30";

export function ev(partial: Partial<EventData> & { title: string }): EventData {
	return {
		datetime: "",
		location: "",
		link: `https://example.test/${encodeURIComponent(partial.title)}`,
		category: "Community / Other",
		cost: "",
		source: "",
		description: "",
		tags: [],
		score: 5,
		datetime_iso: "",
		datetime_end_iso: null,
		image: "",
		social: false,
		intellectual: false,
		hands_on: false,
		creative: false,
		venue: "independents",
		venue_name: null,
		...partial,
	};
}

export const EVENTS: EventData[] = [
	// Evening, a pick, a venue shared with "Late Set".
	ev({
		title: "Jazz at the Tivoli",
		category: "Concert / Music",
		datetime_iso: "2026-09-30T19:00:00",
		score: 8,
		tags: ["jazz", "live music"],
		social: true,
		venue_name: "The Tivoli",
	}),
	// Diacritic in the title ("cafe" must find it); two tags for AND.
	ev({
		title: "Café Poetry Night",
		category: "Social / Meetup",
		datetime_iso: "2026-10-01T18:30:00",
		score: 7,
		tags: ["poetry", "free"],
		social: true,
		creative: true,
		venue_name: "Café Nook",
	}),
	// 01:00 start: the Evening band wraps past midnight.
	ev({
		title: "Late Set",
		category: "Concert / Music",
		datetime_iso: "2026-10-02T01:00:00",
		score: 6,
		tags: ["electronic", "live music"],
		venue_name: "The Tivoli",
	}),
	// Morning band.
	ev({
		title: "Morning Yoga",
		category: "Workshop / Class",
		datetime_iso: "2026-10-01T07:00:00",
		score: 5,
		tags: ["wellness", "free"],
		hands_on: true,
	}),
	// Afternoon band, top score.
	ev({
		title: "Lunchtime Lecture",
		category: "Public Lecture",
		datetime_iso: "2026-09-30T12:30:00",
		score: 9,
		tags: ["science"],
		intellectual: true,
		venue_name: "State Library",
	}),
	// A free tag spelled like a vibe ("hands on"): excluded from the tag facet.
	ev({
		title: "Pottery Class",
		category: "Workshop / Class",
		datetime_iso: "2026-10-03T14:00:00",
		score: 7,
		tags: ["ceramics", "hands on"],
		hands_on: true,
		creative: true,
	}),
	// Date-only, runs for over a year: overlaps every range, never a pick
	// (starts before the window), no time band.
	ev({
		title: "Long Exhibition",
		category: "Arts / Exhibition",
		datetime_iso: "2026-02-01",
		datetime_end_iso: "2027-04-30",
		score: 8,
		tags: ["art"],
		intellectual: true,
		creative: true,
		venue_name: "Museum",
	}),
	// Multi-day inside the week: a pick, matched by overlap on any of its days.
	ev({
		title: "Four-Day Festival",
		category: "Arts / Exhibition",
		datetime_iso: "2026-09-29",
		datetime_end_iso: "2026-10-02",
		score: 7,
		tags: ["art", "festival"],
		social: true,
		venue_name: "Museum",
	}),
	// Ended before today: past.
	ev({
		title: "Monday Market",
		datetime_iso: "2026-09-28T08:00:00",
		datetime_end_iso: "2026-09-28T12:00:00",
		score: 6,
		tags: ["market", "free"],
		social: true,
	}),
	// Unscored: never hidden by the score floor. Its tag duplicates a vibe.
	ev({
		title: "Unscored Meetup",
		category: "Social / Meetup",
		datetime_iso: "2026-10-01T18:00:00",
		score: null,
		tags: ["social"],
		social: true,
	}),
	// Below LOW_SCORE_THRESHOLD: hidden by default, counted in lowScored.
	ev({
		title: "Happy Hour",
		datetime_iso: "2026-10-01T17:00:00",
		score: 2,
		tags: ["drinks"],
	}),
	// No date at all: never past, no band, overlaps no range.
	ev({ title: "Someday Thing", score: 5, tags: ["misc"] }),
	// Past AND low-scored: lowScored must not count it (past hid it first).
	ev({
		title: "Old Trivia",
		datetime_iso: "2026-09-28T19:00:00",
		score: 3,
		tags: ["trivia"],
	}),
	// A tag duplicating a vibe in another case ("Social").
	ev({
		title: "Board Game Club",
		category: "Social / Meetup",
		datetime_iso: "2026-10-04T15:00:00",
		score: 6,
		tags: ["Social", "games"],
		social: true,
	}),
	// Scores 7+ but starts next week: outside the window, not a pick.
	ev({
		title: "Next Week Gala",
		category: "Concert / Music",
		datetime_iso: "2026-10-06T19:00:00",
		score: 9,
		tags: ["gala"],
	}),
	// Pick candidates, so there are more than MAX_PICKS eligible events.
	...[7, 8, 9, 7, 8, 10, 7, 9].map((score, i) =>
		ev({
			title: `Pick Candidate ${i + 1}`,
			category: "Arts / Exhibition",
			datetime_iso: `2026-10-0${(i % 4) + 1}T10:00:00`,
			score,
			tags: ["art"],
			creative: true,
		}),
	),
	// Two events sharing eventId (title + datetime_iso) but not link: keyOf matters.
	ev({
		title: "Twin Talk",
		category: "Public Lecture",
		datetime_iso: "2026-10-02T18:00:00",
		link: "https://example.test/twin-a",
		score: 6,
		intellectual: true,
	}),
	ev({
		title: "Twin Talk",
		category: "Public Lecture",
		datetime_iso: "2026-10-02T18:00:00",
		link: "https://example.test/twin-b",
		score: 6,
		intellectual: true,
	}),
];
