import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CandidatePair,
	completeness,
	dedupeEventsSmart,
	planDedupe,
} from "./dedupe.ts";

function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		title: "Jazz Night",
		datetime_iso: "2026-09-09T19:00:00",
		location: "The Tivoli",
		link: "https://example.com/a",
		description: "",
		image: "",
		cost: "See link",
		tags: [],
		...over,
	};
}

test("obvious duplicates are settled without asking the LLM", async () => {
	const events = [ev(), ev({ link: "https://other.com/b" })];
	const { settled, candidates } = planDedupe(events);
	assert.equal(settled.length, 1);
	assert.equal(candidates.length, 0, "identical titles never reach the model");

	let asked = 0;
	const { events: out } = await dedupeEventsSmart(events, {
		classify: async (pairs) => {
			asked += pairs.length;
			return pairs.map(() => true);
		},
	});
	assert.equal(out.length, 1);
	assert.equal(asked, 0);
});

test("unrelated same-day events are never compared by the LLM", () => {
	const { settled, candidates } = planDedupe([
		ev({ title: "Jazz Night" }),
		ev({ title: "Ceramics Workshop for Beginners" }),
	]);
	assert.equal(settled.length, 0);
	assert.equal(
		candidates.length,
		0,
		"low similarity is below the ask threshold",
	);
});

test("only the grey zone is escalated", () => {
	// Neither an exact/prefix match (which common.ts settles by itself) nor
	// clearly unrelated: too different to merge automatically, too similar to
	// throw away.
	const { settled, candidates } = planDedupe([
		ev({ title: "Life Drawing Session" }),
		ev({ title: "Life Drawing Class" }),
	]);
	assert.equal(settled.length, 0);
	assert.equal(candidates.length, 1);
});

test("events on different days are never paired", () => {
	const { settled, candidates } = planDedupe([
		ev({ datetime_iso: "2026-09-09T19:00:00" }),
		ev({ datetime_iso: "2026-09-20T19:00:00" }),
	]);
	assert.equal(settled.length + candidates.length, 0);
});

test("a neighbouring day with a matching title is asked about, not merged", () => {
	// A late-night event and an all-day one can land either side of midnight,
	// but so can a genuine two-night run of the same show — so this must go to
	// the model rather than being auto-merged or silently dropped.
	const { settled, candidates } = planDedupe([
		ev({ datetime_iso: "2026-09-09T23:30:00" }),
		ev({ datetime_iso: "2026-09-10" }),
	]);
	assert.equal(settled.length, 0, "never auto-merge across days");
	assert.equal(candidates.length, 1);
});

test("the LLM's verdict decides a grey-zone pair", async () => {
	const events = [
		ev({ title: "Life Drawing Session" }),
		ev({ title: "Life Drawing Class" }),
	];
	const seen: CandidatePair[] = [];
	const merged = await dedupeEventsSmart(events, {
		classify: async (pairs) => {
			seen.push(...pairs);
			return pairs.map(() => true);
		},
	});
	assert.equal(seen.length, 1);
	assert.equal(merged.events.length, 1);
	assert.equal(merged.stats.confirmedByLlm, 1);

	const kept = await dedupeEventsSmart(events, {
		classify: async (pairs) => pairs.map(() => false),
	});
	assert.equal(kept.events.length, 2, "a 'different' verdict keeps both");
});

test("without a classifier the grey zone is kept, never guessed at", async () => {
	const { events: out, stats } = await dedupeEventsSmart([
		ev({ title: "Life Drawing Session" }),
		ev({ title: "Life Drawing Class" }),
	]);
	assert.equal(out.length, 2);
	assert.equal(stats.askedPairs, 1);
	assert.equal(stats.confirmedByLlm, 0);
});

test("the most complete record survives a merge", async () => {
	const thin = ev({ link: "" });
	const rich = ev({
		link: "https://example.com/full",
		image: "https://example.com/i.jpg",
		description: "A long, genuinely useful description of the evening.",
		cost: "$25",
		tags: ["jazz"],
	});
	assert.ok(completeness(rich) > completeness(thin));
	const { events: out } = await dedupeEventsSmart([thin, rich]);
	assert.equal(out.length, 1);
	assert.equal(out[0].link, "https://example.com/full");
});

test("a three-way duplicate collapses to one", async () => {
	const { events: out } = await dedupeEventsSmart([ev(), ev(), ev()]);
	assert.equal(out.length, 1);
});

test("a cross-day pair is found regardless of array order", () => {
	// Array position carries no date ordering — events are concatenated file
	// by file. Skipping on index dropped roughly a third of cross-day pairs.
	const later = ev({ datetime_iso: "2026-09-10" });
	const earlier = ev({ datetime_iso: "2026-09-09T23:30:00" });
	assert.equal(planDedupe([earlier, later]).candidates.length, 1);
	assert.equal(planDedupe([later, earlier]).candidates.length, 1);
});

test("a matching title at two different venues is asked about, not merged", () => {
	// The classifier prompt names this case explicitly, but stage 1 used to
	// settle it first — so the rule was unreachable and every venue whose
	// event title prefixed another's lost its event.
	const { settled, candidates } = planDedupe([
		ev({ title: "Trivia Night", location: "Netherworld, Fortitude Valley" }),
		ev({
			title: "Trivia Night at Junk Bar",
			location: "The Junk Bar, Ashgrove",
		}),
	]);
	assert.equal(settled.length, 0);
	assert.equal(candidates.length, 1);
});

test("the same venue written two ways still merges without asking", () => {
	const { settled, candidates } = planDedupe([
		ev({ title: "Jazz Night", location: "The Triffid" }),
		ev({ title: "Jazz Night", location: "The Triffid, Newstead" }),
	]);
	assert.equal(settled.length, 1);
	assert.equal(candidates.length, 0);
});

test("a cross-midnight twin with no event link is merged away", () => {
	// Measured case: "The Silence Paradox" appeared twice at Caxton Street
	// Brewing Company on consecutive days — once from a scrape with a real
	// /e/... listing URL, once from a search summary whose only link was
	// eventbrite.com.au and whose date was a day out.
	//
	// It could never merge before: the ±1-day window gathered the pair, stage 1
	// requires equal dates, and the classifier prompt is told different dates
	// mean different events. So the two stages left a hole between them.
	const scraped = {
		title: "The Silence Paradox: What AI Is Teaching Us About Being Human",
		datetime_iso: "2026-09-09T18:30:00",
		location: "Caxton Street Brewing Company, Milton",
		link: "https://www.eventbrite.com/e/the-silence-paradox-tickets-123",
	};
	const summary = {
		title: "The Silence Paradox: What AI Is Teaching Us About Being Human",
		datetime_iso: "2026-09-08T19:00:00",
		location: "Caxton Street Brewing Company, Petrie Terrace",
		link: "https://www.eventbrite.com.au",
	};
	const { settled } = planDedupe([scraped, summary]);
	assert.equal(
		settled.length,
		1,
		"the pair is settled without asking the model",
	);

	// The record with a real listing URL is the one kept.
	assert.ok(completeness(scraped) > completeness(summary));
});

test("a real two-night run is never merged by that rule", () => {
	// Both nights carry their own listing URL, so neither is a guess and the
	// exception does not apply — deleting a real event is unrecoverable.
	const friday = {
		title: "Hamlet",
		datetime_iso: "2026-09-11T19:30:00",
		location: "La Boite Theatre",
		link: "https://laboite.com.au/hamlet/fri",
	};
	const saturday = {
		title: "Hamlet",
		datetime_iso: "2026-09-12T19:30:00",
		location: "La Boite Theatre",
		link: "https://laboite.com.au/hamlet/sat",
	};
	const { settled } = planDedupe([friday, saturday]);
	assert.equal(settled.length, 0, "consecutive nights stay separate events");
});
