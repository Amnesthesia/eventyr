import assert from "node:assert/strict";
import { test } from "node:test";
import { assignCause, renderCandidates } from "./triage.ts";

const NO_BODY = {
	feeds: [],
	hasEmbed: false,
	uniformBody: false,
	reloadShell: false,
	bodiesRead: 0,
};

const llm = { name: "Test", method: "llm" as const, domains: ["x.com"] };

const row = (over: Record<string, unknown> = {}) => ({
	city: "brisbane",
	tier: "independents" as const,
	name: "Test",
	host: "x.com",
	probedAt: "2026-09-01T00:00:00.000Z",
	classification: "no-events",
	attempts: [],
	errors: [],
	signals: null,
	...over,
});

test("a source with no probe row is unprobed, not unscrapable", () => {
	// The whole reason this module exists: 695 of 950 llm sources had never
	// been looked at, which read as "cannot be scraped".
	assert.equal(assignCause(llm, null, NO_BODY).cause, "unprobed");
});

test("a deterministic feed outranks every page-quality complaint", () => {
	// beachhotel.com.au serves a 76-char bot wall and *also* publishes
	// wp-json/tribe with 384 upcoming events. Reporting it as bot-walled would
	// send us to a browser for data plain curl can fetch.
	const walled = { ...NO_BODY, feeds: ["events-calendar"], uniformBody: true };
	assert.equal(
		assignCause(llm, row({ classification: "spa-empty" }), walled).cause,
		"feed-available",
	);
});

test("the two promotion-gate questions are reported separately", () => {
	// suncorpstadium: 26 dated events, none inside the two-week window. A real
	// listing page rejected by the wrong question, not an empty one.
	const gated = row({
		attempts: [
			{
				url: "u",
				via: "sitemap",
				textLength: 9000,
				dateHits: 30,
				jsonLdNodes: 0,
				events: 26,
				dated: 26,
				inWindow: 0,
				past: 0,
				outcome: "",
			},
		],
	});
	assert.equal(assignCause(llm, gated, NO_BODY).cause, "gate-only");

	// starlightfestival: 122 dated, all of them over. Genuinely nothing —
	// a verified negative, which must not be confused with the above.
	const archive = row({
		attempts: [
			{
				url: "u",
				via: "sitemap",
				textLength: 9000,
				dateHits: 30,
				jsonLdNodes: 0,
				events: 122,
				dated: 122,
				inWindow: 0,
				past: 122,
				outcome: "",
			},
		],
	});
	assert.equal(assignCause(llm, archive, NO_BODY).cause, "archive-only");
});

test("a rich page that extracted nothing blames the extractor", () => {
	// theurbanlist: 173 KB of text, 86 date mentions, zero events out.
	// "Nothing there" and "failed to look" need opposite remedies.
	const rich = row({
		attempts: [
			{
				url: "u",
				via: "sitemap",
				textLength: 173038,
				dateHits: 86,
				jsonLdNodes: 0,
				events: 0,
				outcome: "no events extracted",
			},
		],
	});
	assert.equal(assignCause(llm, rich, NO_BODY).cause, "read-badly");
});

test("a probe-verified source still marked llm is an unapplied promotion", () => {
	// Remedy is re-running probe with --apply, not changing a threshold.
	assert.equal(
		assignCause(llm, row({ classification: "html" }), NO_BODY).cause,
		"unapplied",
	);
});

test("an entry with no domain is never called unscrapable", () => {
	assert.equal(
		assignCause({ name: "Howard Smith Wharves", method: "llm" }, null, NO_BODY)
			.cause,
		"no-domain",
	);
});

test("a stale robots verdict is reported as re-probeable, not off-limits", () => {
	// probe no longer performs a robots permission check, so a row carrying
	// this classification predates that change and the source may well be
	// fetchable now — the remedy is a re-probe, not "leave it alone".
	const withFeed = { ...NO_BODY, feeds: ["ical"] };
	assert.equal(
		assignCause(llm, row({ classification: "robots-disallowed" }), withFeed)
			.cause,
		"robots-disallowed",
	);
});

test("a hosting signature is not mistaken for an event API", () => {
	// Measured: 8 byron sources flagged "squarespace" all returned upcoming: 0,
	// several with real events collections holding only past events. Promoting
	// those buys a weekly fetch that ends up back on the AI search anyway, so
	// the two must not share a remedy.
	const sqsp = { ...NO_BODY, feeds: ["squarespace"] };
	const tec = { ...NO_BODY, feeds: ["events-calendar"] };
	const rich = row({
		attempts: [
			{
				url: "u",
				via: "sitemap",
				textLength: 9000,
				dateHits: 20,
				jsonLdNodes: 0,
				events: 0,
				outcome: "no events extracted",
			},
		],
	});
	// The event API still outranks everything.
	assert.equal(assignCause(llm, rich, tec).cause, "feed-available");
	// The hosting signature yields to what the page actually contained.
	assert.equal(assignCause(llm, rich, sqsp).cause, "read-badly");
});

test("a render is only spent where there is evidence of events", () => {
	// A browser is the most expensive rung, so the shortlist has to come from
	// signals a wall cannot hide: the host's own sitemap and what the AI search
	// has already found there. Only the buckets a browser could change qualify.
	const walled = (host: string, cause: string) => ({
		city: "brisbane",
		tier: "independents" as const,
		name: host,
		host,
		method: "llm" as const,
		cause: cause as never,
		remedy: "",
		evidence: "",
		classification: "spa-empty",
		bestDated: 0,
		bestInWindow: 0,
		bestPast: 0,
		feeds: [] as string[],
	});

	const cands = renderCandidates([
		walled("no-sitemap-cached.example", "bot-wall"),
		// dead is a DNS/connection failure — rendering cannot fix that, so it
		// must never reach the shortlist and burn a browser.
		walled("gone.example", "dead"),
		walled("archived.example", "archive-only"),
	]);
	assert.deepEqual(
		cands.map((c) => c.host),
		["no-sitemap-cached.example"],
	);
	// With no sitemap on disk and no search history, the honest answer is
	// "cannot tell" — never "skip", because absence of evidence about a walled
	// host is exactly what the wall causes.
	assert.equal(cands[0].verdict, "unknown");
	assert.match(cands[0].evidence, /cannot tell/);
});
