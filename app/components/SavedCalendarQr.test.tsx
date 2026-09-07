import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Event } from "../types";
import { QR_EVENT_LIMIT, savedCalendarUrl } from "../utils/savedLink";
import SavedCalendarQr from "./SavedCalendarQr";

function ev(i: number): Event {
	return {
		title: `Event ${i}`,
		datetime: "",
		location: "The Triffid",
		link: "",
		category: "Concert / Music",
		cost: "",
		source: "",
		description: "",
		tags: [],
		score: 5,
		datetime_iso: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T19:00:00`,
		datetime_end_iso: "",
		image: "",
	};
}

test("the code renders as one path with a painted quiet zone", () => {
	const svg = renderToStaticMarkup(
		<SavedCalendarQr url="https://www.dothings.lol/brisbane/#cal=abc.def" />,
	);
	// A single path rather than one rect per module: 1,600 elements in the DOM
	// for a decoration is not worth it.
	assert.equal(svg.match(/<path/g)?.length, 1);
	assert.match(svg, /<rect[^>]*fill="#fff"/);
	// Fixed black-on-white, not theme colours: a scanner needs the contrast,
	// and in dark mode the page behind is nearly the code's own value.
	assert.match(svg, /fill="#000"/);
});

test("a full saved set still fits in a code a phone can read", () => {
	// The reason QR_EVENT_LIMIT exists. Version is (modules - 17) / 4; past
	// about version 20 a code stops resolving reliably off a laptop screen at
	// this size, so the modal must fall back to the link before then.
	const url = savedCalendarUrl(
		Array.from({ length: QR_EVENT_LIMIT }, (_, i) => ev(i)),
		"brisbane",
	);
	const svg = renderToStaticMarkup(<SavedCalendarQr url={url} />);
	const viewBox = svg.match(/viewBox="0 0 (\d+)/);
	const modules = Number(viewBox?.[1]) - 8; // minus the quiet zone
	const version = (modules - 17) / 4;
	assert.ok(Number.isInteger(version), `modules ${modules} is not a QR size`);
	assert.ok(version <= 20, `version ${version} is too dense to scan`);
});
