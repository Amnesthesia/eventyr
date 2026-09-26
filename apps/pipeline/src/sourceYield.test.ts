import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceEntry } from "./common.ts";
import {
	matchSource,
	primaryHost,
	sourceEarnsPlace,
	unlistedWorthProbing,
	updateLedger,
	type YieldLedger,
} from "./sourceYield.ts";

function llm(name: string, domain: string, note?: string): SourceEntry {
	return { name, method: "llm", domains: [domain], note };
}

test("matchSource finds a source by any of its domains, with a dot boundary", () => {
	const entries = [llm("QAGOMA", "qagoma.qld.gov.au")];
	assert.equal(matchSource("qagoma.qld.gov.au", entries)?.name, "QAGOMA");
	assert.equal(
		matchSource("events.qagoma.qld.gov.au", entries)?.name,
		"QAGOMA",
		"a subdomain still belongs to the source",
	);
	assert.equal(
		matchSource("evil-qagoma.qld.gov.au", entries),
		null,
		"a lookalike prefix is not the same host",
	);
	assert.equal(matchSource(null, entries), null);
});

test("updateLedger records which source a link host hit, and counts unlisted hosts", () => {
	const entries = [
		llm("QAGOMA", "qagoma.qld.gov.au"),
		llm("Dead Venue", "dead.example.com"),
	];
	const ledger = updateLedger(
		null,
		"2026-09-07",
		["events.qagoma.qld.gov.au", "songkick.com", "songkick.com"],
		entries,
	);
	assert.deepEqual(ledger.weeks, ["2026-09-07"]);
	assert.deepEqual(ledger.sources[primaryHost(entries[0]) as string].weeksHit, [
		"2026-09-07",
	]);
	assert.equal(ledger.sources[primaryHost(entries[1]) as string], undefined);
	assert.equal(ledger.unlisted["songkick.com"].count, 2);
});

test("updateLedger merges across weeks and trims history beyond the window", () => {
	const entries = [llm("QAGOMA", "qagoma.qld.gov.au")];
	let ledger: YieldLedger | null = null;
	for (let i = 1; i <= 30; i++) {
		const week = `2026-01-${String(i).padStart(2, "0")}`;
		ledger = updateLedger(
			ledger,
			week,
			i % 5 === 0 ? ["qagoma.qld.gov.au"] : [],
			entries,
		);
	}
	assert.ok(ledger);
	assert.equal(ledger?.weeks.length, 26, "history is capped at 26 weeks");
});

test("updateLedger re-running the same week does not double-count", () => {
	const entries = [llm("QAGOMA", "qagoma.qld.gov.au")];
	let ledger = updateLedger(null, "2026-09-07", ["qagoma.qld.gov.au"], entries);
	ledger = updateLedger(ledger, "2026-09-07", ["qagoma.qld.gov.au"], entries);
	assert.deepEqual(ledger.sources[primaryHost(entries[0]) as string].weeksHit, [
		"2026-09-07",
	]);
});

test("sourceEarnsPlace: no ledger, or too little history, keeps every source", () => {
	const source = llm("Dead Venue", "dead.example.com");
	assert.equal(sourceEarnsPlace(source, null), true);
	const thin = updateLedger(null, "2026-09-07", [], []);
	assert.equal(sourceEarnsPlace(source, thin), true);
});

test("sourceEarnsPlace drops a source that never hit once there is enough history", () => {
	const hit = llm("QAGOMA", "qagoma.qld.gov.au");
	const dead = llm("Dead Venue", "dead.example.com");
	let ledger: YieldLedger | null = null;
	for (let i = 1; i <= 8; i++) {
		ledger = updateLedger(
			ledger,
			`2026-01-${String(i).padStart(2, "0")}`,
			["qagoma.qld.gov.au"],
			[hit, dead],
		);
	}
	assert.equal(sourceEarnsPlace(hit, ledger), true);
	assert.equal(sourceEarnsPlace(dead, ledger), false);
});

test("sourceEarnsPlace keeps a recently added source during its grace period", () => {
	const hit = llm("QAGOMA", "qagoma.qld.gov.au");
	const fresh = llm(
		"New Venue",
		"new.example.com",
		"Suggested by discover-sources 2026-09-01; not yet verified.",
	);
	let ledger: YieldLedger | null = null;
	for (let i = 1; i <= 8; i++) {
		ledger = updateLedger(
			ledger,
			`2026-01-${String(i).padStart(2, "0")}`,
			["qagoma.qld.gov.au"],
			[hit, fresh],
		);
	}
	assert.equal(
		sourceEarnsPlace(fresh, ledger, new Date("2026-09-10")),
		true,
		"9 days after being added is inside the grace window",
	);
	assert.equal(
		sourceEarnsPlace(fresh, ledger, new Date("2026-12-01")),
		false,
		"months later, with no hits, the grace period is long over",
	);
});

test("unlistedWorthProbing surfaces hosts above the minimum, most productive first", () => {
	const ledger = updateLedger(
		null,
		"2026-09-07",
		["a.com", "a.com", "a.com", "a.com", "a.com", "b.com", "b.com"],
		[],
	);
	const worth = unlistedWorthProbing(ledger);
	assert.deepEqual(
		worth.map((w) => w.host),
		["a.com"],
		"b.com has only 2 hits, below the reporting minimum",
	);
});
