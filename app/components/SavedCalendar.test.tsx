// Renders the modal for real, inside the real provider.
//
// The build already server-renders AppShell, so a crash there would be caught
// — but the modal only mounts on a click, so nothing else exercises it. This
// is the cheapest thing that fails if the grid, the QR code or the context
// wiring breaks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EventsProvider } from "../context";
import type { City, CityData, Event } from "../types";
import SavedCalendar from "./SavedCalendar";

function ev(partial: Partial<Event>): Event {
	return {
		title: "Lebanon Hanover",
		datetime: "Thu 17 Sep, 7:00 PM",
		location: "The Triffid, Newstead",
		link: "https://thetriffid.com.au/lebanon-hanover",
		category: "Concert / Music",
		cost: "$60",
		source: "The Triffid",
		description: "",
		tags: [],
		score: 8,
		datetime_iso: "2026-09-17T19:00:00",
		datetime_end_iso: "",
		image: "",
		...partial,
	};
}

const EVENTS = [
	ev({}),
	ev({ title: "Sunday session", datetime_iso: "2026-09-20" }),
	ev({
		title: "Verso Projects",
		datetime_iso: "2026-09-14",
		datetime_end_iso: "2026-09-26",
	}),
];

const CITY_DATA: CityData = {
	city: "Brisbane, Australia",
	city_key: "brisbane",
	week_start: "2026-09-14",
	week_end: "2026-09-20",
	generated_at: "2026-09-14",
	timezone: "Australia/Brisbane",
	events: EVENTS,
};

const CITIES: City[] = [
	{
		key: "brisbane",
		name: "Brisbane",
		week_start: "2026-09-14",
		week_end: "2026-09-20",
		event_count: EVENTS.length,
		top_pick_count: 1,
	},
];

function render(events: Event[]) {
	return renderToStaticMarkup(
		<EventsProvider initialData={CITY_DATA} allCities={CITIES}>
			<SavedCalendar events={events} onClose={() => {}} />
		</EventsProvider>,
	);
}

test("the modal renders a week, its events and a QR code", () => {
	const html = render(EVENTS);
	assert.match(html, /Lebanon Hanover/);
	// The timed event is on the grid, positioned rather than in the all-day
	// strip: 19:00 in an 08:00–23:00 lane is 73% of the way down.
	assert.match(html, /cal-chip--timed[^>]*top:\s*73/);
	assert.match(html, /<time>19:00<\/time>/);
	// The date-only ones are chips in the all-day strip, with no time.
	assert.match(html, /Sunday session/);
	assert.match(html, /Verso Projects/);
	// Seven day columns, one header each.
	assert.equal(html.match(/cal-day-head/g)?.length, 7);
	assert.match(html, /<svg[^>]*class="saved-qr"/);
	// The QR sits in the sidebar beside the grid, not under it: a full week of
	// events would otherwise push the thing the modal exists for off screen.
	assert.match(html, /class="cal-side"[\s\S]*saved-qr/);
});

test("an empty saved set renders without a QR code or a crash", () => {
	const html = render([]);
	assert.match(html, /Nothing saved yet/);
	assert.doesNotMatch(html, /saved-qr/);
});
