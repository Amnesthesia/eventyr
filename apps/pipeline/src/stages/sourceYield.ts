import { loadPipelineConfig } from "../config/load.js";
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
// Pure: no IO. config/city.ts loads/saves the file so this module can be imported
// without dragging the data dir along.

import { isSameSite, normaliseHost } from "@dothingslol/core/shared";
import {
	type SourceEntry,
	sourceEarnsPlace,
	type YieldLedger,
} from "../config/city.js";

// sourceEarnsPlace moved to config/city.ts — config may not import stages,
// and config/city.ts's llmSourceStrings needs it, so the definition lives
// there and this file imports it back. Re-exported here so this module's
// public shape (and sourceYield.test.ts, which tests it alongside the rest
// of this file's yield logic) is unchanged.
export { sourceEarnsPlace, type YieldLedger };

/** Weeks of history the ledger keeps. Bounded so the file cannot grow forever. */

/** A source that produced nothing for this long is dropped from the prompts. */

/** A newly added source keeps its place this long regardless, so a discover
 * suggestion gets a chance before the ledger judges it. */

/**
 * Pruning needs this much history first. With one week recorded, every source
 * that happened to miss that week would be dropped — failing towards the cheap
 * branch, which is the wrong direction.
 */

/** Unlisted hosts with at least this many events are worth a probe. */

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
	const keep = new Set(
		ledger.weeks.slice(
			-loadPipelineConfig().stages.collect.sourceYield.ledgerWeeks,
		),
	);
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

/** Unlisted hosts worth handing to probe-sources, most productive first. */
export function unlistedWorthProbing(
	ledger: YieldLedger,
): { host: string; count: number }[] {
	return Object.entries(ledger.unlisted)
		.filter(
			([, r]) =>
				r.count >=
				loadPipelineConfig().stages.collect.sourceYield.unlistedReportMin,
		)
		.map(([host, r]) => ({ host, count: r.count }))
		.sort((a, b) => b.count - a.count);
}
