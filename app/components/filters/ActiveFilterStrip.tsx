import { X } from "lucide-react";
import { LOW_SCORE_THRESHOLD } from "../../../src/shared.ts";
import { useEventsContext } from "../../context";
import { catShortName } from "../../utils/categorySlug";
import { fmtRange } from "../../utils/dates";
import { TIME_BAND_LABELS } from "../../utils/timeOfDay";
import { VIBE_LABELS } from "../../utils/vibes";

/**
 * Everything currently narrowing the list, one removable chip each.
 *
 * This is what replaced the "All Categories" / "All Vibes" / "All Tags" pills:
 * no filter applied is now the absence of chips — and this whole strip — rather
 * than the highest-contrast element on the page announcing that nothing is
 * happening.
 */
export default function ActiveFilterStrip() {
	const {
		hasActiveFilters,
		clearAllFilters,
		activeCat,
		setActiveCat,
		dateRange,
		setDateRange,
		activeTags,
		toggleTag,
		vibes,
		toggleVibe,
		timeBands,
		toggleTimeBand,
		pastFilter,
		setPastFilter,
		minScore,
		setMinScore,
		query,
		setQuery,
	} = useEventsContext();

	if (!hasActiveFilters) return null;

	const chips: { key: string; label: string; clear: () => void }[] = [];
	if (activeCat !== "All") {
		chips.push({
			key: "cat",
			label: catShortName(activeCat),
			clear: () => setActiveCat("All"),
		});
	}
	if (dateRange) {
		chips.push({
			key: "when",
			label: fmtRange(dateRange.start, dateRange.end),
			clear: () => setDateRange(null),
		});
	}
	for (const band of timeBands) {
		chips.push({
			key: `band:${band}`,
			label: TIME_BAND_LABELS[band],
			clear: () => toggleTimeBand(band),
		});
	}
	for (const key of vibes) {
		chips.push({
			key: `vibe:${key}`,
			label: VIBE_LABELS[key],
			clear: () => toggleVibe(key),
		});
	}
	for (const tag of activeTags) {
		chips.push({ key: `tag:${tag}`, label: tag, clear: () => toggleTag(tag) });
	}
	if (minScore !== LOW_SCORE_THRESHOLD) {
		chips.push({
			key: "score",
			label: `${minScore}+`,
			clear: () => setMinScore(LOW_SCORE_THRESHOLD),
		});
	}
	if (pastFilter !== "no-past") {
		chips.push({
			key: "past",
			label: pastFilter === "only-past" ? "only past" : "including past",
			clear: () => setPastFilter("no-past"),
		});
	}
	if (query.trim()) {
		chips.push({
			key: "query",
			label: `“${query.trim()}”`,
			clear: () => setQuery(""),
		});
	}

	return (
		<div className="filter-strip">
			<span className="frow-label">Filtering by</span>
			{chips.map((chip) => (
				<button
					type="button"
					key={chip.key}
					className="strip-chip"
					onClick={chip.clear}
					aria-label={`Remove filter ${chip.label}`}
				>
					{chip.label}
					<X size={9} strokeWidth={2.5} />
				</button>
			))}
			<button type="button" className="strip-clear" onClick={clearAllFilters}>
				Clear all
			</button>
		</div>
	);
}
