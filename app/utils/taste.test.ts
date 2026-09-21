import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types";
import { tagWeights } from "./tagSpecificity";
import {
	bumpDislike,
	bumpTaste,
	effectiveTaste,
	eventKeys,
	loadTaste,
	logTasteProfile,
	noteInterest,
	rankByTaste,
	saveTaste,
	type TasteProfile,
	tasteBoost,
} from "./taste";

function ev(partial: Partial<Event>): Event {
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

/** A profile that has seen `n` bookmarks of the same comedy-shaped event. */
function comedyProfile(n: number): TasteProfile {
	let profile: TasteProfile = {};
	for (let i = 0; i < n; i++) profile = bumpTaste(profile, comedy, 1);
	return profile;
}

test("eventKeys prefixes tags, vibes and category", () => {
	assert.deepEqual(eventKeys(comedy), [
		"tag:comedy",
		"tag:standup",
		"tag:live",
		"vibe:creative",
		"vibe:social",
		"cat:Comedy",
	]);
});

test("bumpTaste counts every facet and reverses cleanly", () => {
	const up = bumpTaste({}, comedy, 1);
	assert.equal(up["tag:comedy"], 1);
	assert.equal(up["vibe:social"], 1);
	assert.equal(up["cat:Comedy"], 1);
	assert.deepEqual(bumpTaste(up, comedy, -1), {});
});

test("bumpTaste clamps at zero instead of going negative", () => {
	// Unstarring an event that was never counted (or counted in an earlier
	// week, before a data refresh) must not leave negative weights behind.
	assert.deepEqual(bumpTaste({}, comedy, -1), {});
});

test("tasteBoost is zero until MIN_SIGNAL bookmarks", () => {
	assert.equal(tasteBoost(comedy, {}), 0);
	assert.equal(tasteBoost(comedy, comedyProfile(1)), 0);
	assert.equal(tasteBoost(comedy, comedyProfile(2)), 0);
	assert.ok(tasteBoost(comedy, comedyProfile(3)) > 0);
});

test("tasteBoost rewards breadth of match", () => {
	const profile = comedyProfile(3);
	const catOnly = tasteBoost(
		ev({ tags: ["knitting"], category: "Comedy" }),
		profile,
	);
	const everything = tasteBoost(comedy, profile);
	assert.ok(
		everything > catOnly,
		`tag+vibe+category (${everything}) should beat category alone (${catOnly})`,
	);
	assert.ok(everything <= 4, "boost stays inside MAX_BOOST");
});

test("tasteBoost accelerates: each extra matching tag is worth more", () => {
	const profile = comedyProfile(3);
	// Same category and vibes throughout, so only the tag count varies.
	const withTags = (tags: string[]) =>
		tasteBoost(
			ev({ tags, category: "Comedy", social: true, creative: true }),
			profile,
		);
	const zero = withTags([]);
	const one = withTags(["comedy"]);
	const two = withTags(["comedy", "standup"]);
	assert.ok(
		two - one > one - zero,
		`second match (+${two - one}) should outweigh the first (+${one - zero})`,
	);
});

test("a lopsided category count does not flatten tag weight", () => {
	// cat: is counted on every bookmark, so its total dwarfs any single tag.
	// Normalising all groups against one shared maximum would drive tag weights
	// to near zero; each group is normalised against its own maximum instead.
	let profile = comedyProfile(3);
	for (let i = 0; i < 40; i++) {
		profile = bumpTaste(profile, ev({ category: "Comedy" }), 1);
	}
	const tagged = tasteBoost(
		ev({ tags: ["comedy", "standup", "live"] }),
		profile,
	);
	assert.ok(tagged > 0.5, `tag-only match still scores (${tagged})`);
});

test("rankByTaste with no profile keeps the incoming order", () => {
	// Input arrives score-desc then soonest-first from the pipeline, and equal
	// scores must not be reshuffled — that soonest-first tiebreak is the only
	// thing ordering same-score events.
	const events = [
		ev({ title: "a", score: 9 }),
		ev({ title: "b", score: 8 }),
		ev({ title: "c", score: 8 }),
		ev({ title: "d", score: 7 }),
	];
	assert.deepEqual(
		rankByTaste(events, {}).map((e) => e.title),
		["a", "b", "c", "d"],
	);
});

test("a full taste match outranks a higher unmatched score", () => {
	const profile = comedyProfile(3);
	const unmatched = ev({ title: "opera", score: 10, category: "Theatre" });
	const ranked = rankByTaste([unmatched, comedy], profile);
	assert.equal(ranked[0].title, comedy.title);
});

test("a single shared tag does not outrank a much higher score", () => {
	const profile = comedyProfile(3);
	const partial = ev({ title: "partial", score: 7, tags: ["comedy"] });
	const unmatched = ev({ title: "opera", score: 10, category: "Theatre" });
	const ranked = rankByTaste([partial, unmatched], profile);
	assert.equal(ranked[0].title, "opera");
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

test("logTasteProfile survives an empty profile and empty picks", () => {
	const real = { ...console };
	Object.assign(console, {
		groupCollapsed() {},
		groupEnd() {},
		log() {},
		table() {},
	});
	try {
		// Runs on every page load, so a throw here would break the whole app.
		logTasteProfile({}, []);
		logTasteProfile(comedyProfile(3), [comedy]);
	} finally {
		Object.assign(console, real);
	}
});

test("an explicit tag preference outranks any score", () => {
	// The point of stating a preference: it has to beat what the counts infer.
	// An additive bonus would let a high enough score float an unwanted event
	// back to the top, which reads as the setting being ignored.
	const raffle = {
		title: "Members Raffle",
		score: 9,
		tags: ["raffle"],
	} as Event;
	const talk = {
		title: "AI Ethics Talk",
		score: 5,
		tags: ["lecture"],
	} as Event;
	const ranked = rankByTaste([raffle, talk], {}, { raffle: -1 });
	assert.deepEqual(
		ranked.map((e) => e.title),
		["AI Ethics Talk", "Members Raffle"],
	);
});

test("a wanted tag sorts first even on a lower score", () => {
	const wanted = { title: "Board Games", score: 5, tags: ["games"] } as Event;
	const higher = { title: "Big Gig", score: 9, tags: ["music"] } as Event;
	const ranked = rankByTaste([higher, wanted], {}, { games: 1 });
	assert.deepEqual(
		ranked.map((e) => e.title),
		["Board Games", "Big Gig"],
	);
});

test("unwanted beats wanted when an event carries both", () => {
	// Saying no to raffles means an event that is both a raffle and live music
	// is still a raffle.
	const both = {
		title: "Raffle + Live Music",
		score: 8,
		tags: ["raffle", "music"],
	} as Event;
	const plain = { title: "Quiet Reading", score: 4, tags: ["books"] } as Event;
	const ranked = rankByTaste([both, plain], {}, { raffle: -1, music: 1 });
	assert.deepEqual(
		ranked.map((e) => e.title),
		["Quiet Reading", "Raffle + Live Music"],
	);
});

test("no stated preference leaves the incoming order alone", () => {
	const a = { title: "A", score: 7, tags: ["x"] } as Event;
	const b = { title: "B", score: 7, tags: ["y"] } as Event;
	assert.deepEqual(
		rankByTaste([a, b], {}, {}).map((e) => e.title),
		["A", "B"],
	);
});

test("rating tags personalises the profile with no bookmarks at all", () => {
	// Preferences used to be a sort tier only, so the profile never learned
	// from them and the taste readout kept reporting "not personalised" however
	// many tags had been rated.
	const comedy = { title: "Comedy", score: 5, tags: ["comedy"] } as Event;
	assert.equal(tasteBoost(comedy, {}), 0, "an empty profile boosts nothing");
	const stated = effectiveTaste({}, { comedy: 1 });
	assert.ok(
		tasteBoost(comedy, stated) > 0,
		"a stated preference is a signal on its own",
	);
});

test("an unwanted tag is removed from the profile, not just outranked", () => {
	// Bookmarking karaoke then saying "less karaoke" has to actually undo the
	// learned weight, or the profile keeps recommending it inside its band.
	const karaoke = { title: "Karaoke", score: 6, tags: ["karaoke"] } as Event;
	const learned = { "tag:karaoke": 4, "cat:Concert / Music": 4 };
	assert.ok(tasteBoost(karaoke, learned) > 0);
	assert.equal(
		tasteBoost(karaoke, effectiveTaste(learned, { karaoke: -1 })),
		0,
	);
});

test("within a band, more wanted tags ranks higher", () => {
	const two = { title: "Two", score: 5, tags: ["comedy", "improv"] } as Event;
	const one = { title: "One", score: 5, tags: ["comedy"] } as Event;
	const ranked = rankByTaste([one, two], {}, { comedy: 1, improv: 1 });
	assert.deepEqual(
		ranked.map((e) => e.title),
		["Two", "One"],
	);
});

// ---------------------------------------------------------------------------
// Dislikes: bumpDislike and its effect on tasteBoost
// ---------------------------------------------------------------------------

const tsConcert = ev({
	title: "Eras Tour",
	tags: ["music", "pop", "taylor-swift"],
	category: "Concert / Music",
	score: 8,
});

const jazzNight = ev({
	title: "Jazz night",
	tags: ["music", "jazz"],
	category: "Concert / Music",
	score: 6,
});

/** A city where "music" is common but each event's other tags are unique —
 * the shape every real city's data has (a handful of broad category tags,
 * many narrow ones). */
function musicCityEvents(fillerCount: number): Event[] {
	const filler = Array.from({ length: fillerCount }, (_, i) =>
		ev({
			title: `filler${i}`,
			tags: ["music"],
			category: "Concert / Music",
		}),
	);
	return [tsConcert, jazzNight, ...filler];
}

test("bumpDislike weights by specificity, then reverses cleanly", () => {
	const weights = tagWeights(musicCityEvents(50));
	const down = bumpDislike({}, tsConcert, weights);
	assert.ok(down["tag:taylor-swift"] < 0, "a unique tag takes the full hit");
	assert.ok(
		Math.abs(down["tag:music"]) < Math.abs(down["tag:taylor-swift"]),
		"a common tag takes a smaller hit than a unique one",
	);
	assert.deepEqual(bumpDislike(down, tsConcert, weights, 1), {});
});

test("disliking one concert barely moves an unrelated one sharing only the generic tag", () => {
	// The whole reason this file weights by specificity: a reader who dislikes
	// one pop concert must not come away disliking "music".
	const weights = tagWeights(musicCityEvents(50));
	let profile: TasteProfile = {};
	for (let i = 0; i < 3; i++)
		profile = bumpDislike(profile, tsConcert, weights);

	const disliked = tasteBoost(tsConcert, profile);
	const unrelated = tasteBoost(jazzNight, profile);
	assert.ok(disliked < 0, "the disliked shape itself scores negative");
	assert.ok(
		unrelated > disliked / 4,
		`jazz night (${unrelated}) should barely move next to the disliked show (${disliked})`,
	);
});

test("many dislikes of a generic tag eventually move it too", () => {
	const weights = tagWeights(musicCityEvents(50));
	const genericEvent = () =>
		ev({ tags: ["music"], category: "Concert / Music" });

	// One specific dislike sets the group's scale, then filler dislikes of the
	// bare "music" tag accumulate against it.
	let few: TasteProfile = bumpDislike({}, tsConcert, weights);
	let many: TasteProfile = bumpDislike({}, tsConcert, weights);
	for (let i = 0; i < 2; i++) few = bumpDislike(few, genericEvent(), weights);
	for (let i = 0; i < 20; i++)
		many = bumpDislike(many, genericEvent(), weights);

	const boostFew = tasteBoost(genericEvent(), few);
	const boostMany = tasteBoost(genericEvent(), many);
	assert.ok(
		boostMany < boostFew,
		`20 generic dislikes (${boostMany}) should sink lower than 2 (${boostFew})`,
	);
});

test("tasteBoost stays finite and inside [-4, 4] for a dislikes-only profile", () => {
	const events = musicCityEvents(10);
	const weights = tagWeights(events);
	let profile: TasteProfile = {};
	for (const disliked of events.slice(0, 5)) {
		profile = bumpDislike(profile, disliked, weights);
	}
	for (const event of events) {
		const boost = tasteBoost(event, profile);
		assert.ok(Number.isFinite(boost), `boost must be finite, got ${boost}`);
		assert.ok(boost >= -4 && boost <= 4, `boost ${boost} out of range`);
	}
});
