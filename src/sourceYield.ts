// Which method: llm sources actually earn their place in the search prompts.
//
// Measured over 18 committed weeks of Brisbane search results: 385 sources were
// named in the prompts, 59 ever produced an event, 50 in the last 8 weeks — and
// the `open` tier, which names no sources at all, yielded as many events per
// call as the tiers that do. A 261-name list costs tokens, constrains a search
// that can only run a handful of queries, and cannot be "checked" anyway.
//
// So curate.ts keeps a ledger of which sources the search providers actually
// returned events from (matched by link host), and llmSourceStrings() names only
// sources that hit recently or were added recently. Everything else is still
// fair game for the search — it just is not spelled out.
//
// Pure: no IO. common.ts loads/saves the file so this module can be imported
// without dragging the data dir along.

import type { SourceEntry } from "./common.ts";
import { isSameSite, normaliseHost } from "./shared.ts";

/** Weeks of history the ledger keeps. Bounded so the file cannot grow forever. */
export const LEDGER_WEEKS = 26;
/** A source that produced nothing for this long is dropped from the prompts. */
export const HIT_WINDOW_WEEKS = 8;
/** A newly added source keeps its place this long regardless, so a discover
 * suggestion gets a chance before the ledger judges it. */
export const GRACE_DAYS = 28;
/**
 * Pruning needs this much history first. With one week recorded, every source
 * that happened to miss that week would be dropped — failing towards the cheap
 * branch, which is the wrong direction.
 */
export const MIN_HISTORY_WEEKS = 8;
/** Unlisted hosts with at least this many events are worth a probe. */
export const UNLISTED_REPORT_MIN = 5;

export interface YieldLedger {
	/** Weeks recorded, ascending. */
	weeks: string[];
	/** Keyed by the source's primary host. */
	sources: Record<string, { weeksHit: string[] }>;
	/** Link hosts the search returned that match no source at all. */
	unlisted: Record<string, { count: number; lastWeek: string }>;
}

export function primaryHost(entry: SourceEntry): string | null {
	return normaliseHost(entry.domains?.[0]);
}

/** The source a link host belongs to, if any. */
export function matchSource(
	host: string | null,
	entries: SourceEntry[],
): SourceEntry | null {
	if (!host) return null;
	for (const entry of entries) {
		for (const d of entry.domains ?? []) {
			const owned = normaliseHost(d);
			if (owned && isSameSite(host, owned)) return entry;
		}
	}
	return null;
}

/**
 * Folds one week's search results (as link hosts) into the ledger. Re-running
 * the same week is idempotent for `weeks`/`weeksHit`; unlisted counts are
 * replaced for that week rather than added twice.
 */
export function updateLedger(
	prev: YieldLedger | null,
	week: string,
	linkHosts: string[],
	entries: SourceEntry[],
): YieldLedger {
	const ledger: YieldLedger = prev
		? {
				weeks: [...prev.weeks],
				sources: Object.fromEntries(
					Object.entries(prev.sources).map(([k, v]) => [
						k,
						{ weeksHit: [...v.weeksHit] },
					]),
				),
				unlisted: { ...prev.unlisted },
			}
		: { weeks: [], sources: {}, unlisted: {} };

	if (!ledger.weeks.includes(week)) ledger.weeks.push(week);
	ledger.weeks.sort();
	const keep = new Set(ledger.weeks.slice(-LEDGER_WEEKS));
	ledger.weeks = [...keep];

	const unlistedThisWeek = new Map<string, number>();
	for (const raw of linkHosts) {
		const host = normaliseHost(raw);
		if (!host) continue;
		const entry = matchSource(host, entries);
		if (entry) {
			const key = primaryHost(entry);
			if (!key) continue;
			const rec = ledger.sources[key] ?? { weeksHit: [] };
			if (!rec.weeksHit.includes(week)) rec.weeksHit.push(week);
			ledger.sources[key] = rec;
		} else {
			unlistedThisWeek.set(host, (unlistedThisWeek.get(host) ?? 0) + 1);
		}
	}
	for (const [host, count] of unlistedThisWeek) {
		const rec = ledger.unlisted[host];
		// Same week again (a FORCE re-run): replace, don't double count.
		if (rec && rec.lastWeek === week) rec.count = count;
		else if (rec) {
			rec.count += count;
			rec.lastWeek = week;
		} else ledger.unlisted[host] = { count, lastWeek: week };
	}

	// Trim history that fell out of the window.
	for (const [key, rec] of Object.entries(ledger.sources)) {
		rec.weeksHit = rec.weeksHit.filter((w) => keep.has(w)).sort();
		if (rec.weeksHit.length === 0) delete ledger.sources[key];
	}
	for (const [host, rec] of Object.entries(ledger.unlisted)) {
		if (!keep.has(rec.lastWeek)) delete ledger.unlisted[host];
	}
	return ledger;
}

/**
 * The date discover-sources stamped into `note`, if this entry came from it.
 *
 * Matches only that specific stamp — not any date in `note` — because
 * probe-sources also writes dated notes onto a source it *demotes* back to
 * llm ("Demoted by probe-sources 2026-09-02: ..."), and 338 of Brisbane's 385
 * llm sources carry one of those. A demotion is not a new addition; reading
 * its date as one gave nearly every source an undeserved grace period and
 * made the ledger prune almost nothing.
 */
function addedOn(entry: SourceEntry): Date | null {
	const m = /^Suggested by discover-sources (\d{4}-\d{2}-\d{2})/.exec(
		entry.note ?? "",
	);
	if (!m) return null;
	const d = new Date(`${m[1]}T00:00:00Z`);
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whether an llm source should be named in the search prompt.
 *
 * No ledger, or too little history ⇒ yes for everyone (today's behaviour).
 * Otherwise: hit within the last HIT_WINDOW_WEEKS recorded weeks, or added
 * within GRACE_DAYS.
 */
export function sourceEarnsPlace(
	entry: SourceEntry,
	ledger: YieldLedger | null,
	today: Date = new Date(),
): boolean {
	if (!ledger || ledger.weeks.length < MIN_HISTORY_WEEKS) return true;
	const added = addedOn(entry);
	if (added && today.getTime() - added.getTime() < GRACE_DAYS * 86_400_000) {
		return true;
	}
	const key = primaryHost(entry);
	if (!key) return false;
	const recent = new Set(ledger.weeks.slice(-HIT_WINDOW_WEEKS));
	return (ledger.sources[key]?.weeksHit ?? []).some((w) => recent.has(w));
}

/** Unlisted hosts worth handing to probe-sources, most productive first. */
export function unlistedWorthProbing(
	ledger: YieldLedger,
): { host: string; count: number }[] {
	return Object.entries(ledger.unlisted)
		.filter(([, r]) => r.count >= UNLISTED_REPORT_MIN)
		.map(([host, r]) => ({ host, count: r.count }))
		.sort((a, b) => b.count - a.count);
}
