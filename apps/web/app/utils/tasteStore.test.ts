import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventData } from "@dothingslol/core/schema";
import { bumpTaste } from "@dothingslol/core/taste";
import { loadTaste, noteInterest, saveTaste } from "./tasteStore";

function ev(partial: Partial<EventData>): EventData {
	return {
		title: "",
		datetime: "",
		location: "",
		link: "",
		category: "Community / Other",
		cost: "",
		source: "",
		description: "",
		tags: [],
		score: 5,
		datetime_iso: "",
		datetime_end_iso: "",
		image: "",
		social: false,
		intellectual: false,
		hands_on: false,
		creative: false,
		venue: "",
		...partial,
	};
}

const comedy = ev({
	title: "Standup",
	tags: ["comedy", "standup", "live"],
	category: "Comedy",
	social: true,
	creative: true,
	score: 7,
});

/** Minimal localStorage + window, so noteInterest can be tested without jsdom
 * (there is no DOM test dependency in this repo, deliberately). */
function stubBrowser(): { dispatched: number; reset: () => void } {
	const store = new Map<string, string>();
	const state = { dispatched: 0, reset: () => store.clear() };
	// biome-ignore lint/suspicious/noExplicitAny: test stub, not the real DOM
	const g = globalThis as any;
	g.localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	};
	g.window = {
		dispatchEvent: () => {
			state.dispatched++;
			return true;
		},
	};
	g.CustomEvent = class {
		detail: unknown;
		constructor(_type: string, init?: { detail?: unknown }) {
			this.detail = init?.detail;
		}
	};
	return state;
}

test("noteInterest counts a share once, however many times it is shared", () => {
	const browser = stubBrowser();
	noteInterest(comedy, "brisbane", "share");
	const once = loadTaste();
	assert.equal(once["tag:comedy"], 1);
	noteInterest(comedy, "brisbane", "share");
	noteInterest(comedy, "brisbane", "share");
	assert.deepEqual(
		loadTaste(),
		once,
		"re-sharing the same event must not stack",
	);
	assert.equal(
		browser.dispatched,
		1,
		"only the counted share announces itself",
	);
});

test("noteInterest counts share and calendar as separate signals", () => {
	stubBrowser();
	noteInterest(comedy, "brisbane", "share");
	noteInterest(comedy, "brisbane", "calendar");
	assert.equal(loadTaste()["tag:comedy"], 2);
});

test("noteInterest reads storage, so it cannot be clobbered by stale state", () => {
	stubBrowser();
	// A bookmark counted earlier in the session, already persisted.
	saveTaste(bumpTaste({}, comedy, 1));
	noteInterest(comedy, "brisbane", "share");
	assert.equal(loadTaste()["tag:comedy"], 2);
});
