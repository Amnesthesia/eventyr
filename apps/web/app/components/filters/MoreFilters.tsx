import {
	facetCounts,
	liveCounts,
	visibleTags,
} from "@dothingslol/core/filters";
import {
	LOW_SCORE_THRESHOLD,
	TOP_PICK_THRESHOLD,
} from "@dothingslol/core/shared";
import { VIBE_KEYS, VIBE_LABELS } from "@dothingslol/core/vibes";
import { useMemo, useState } from "react";
import { useEventsContext } from "../../context";
import PastFilter from "./PastFilter";
import TimeOfDayFilter from "./TimeOfDayFilter";

/**
 * Score thresholds offered in the filter.
 *
 * Four named tiers, not the old row of bare digits: "6" next to "any score"
 * said nothing about what the number was or which direction it cut. Anchored
 * on the two values that already mean something elsewhere — LOW_SCORE_THRESHOLD
 * is where venue promotion stops (the ical/rss feeds cut there too) and
 * TOP_PICK_THRESHOLD is what the site surfaces as a top pick.
 *
 * ponytail: "Any" is LOW_SCORE_THRESHOLD rather than 0. Below 4 is happy hours
 * and schnitzel nights, which nobody opened this site to read, so no tier
 * reaches them; add a fifth if that ever needs to be visible.
 */
const SCORE_TIERS: { value: number; label: string; title: string }[] = [
	{
		value: LOW_SCORE_THRESHOLD,
		label: "Any",
		title: "Every event worth listing — hides venue promotion",
	},
	{ value: 6, label: "6+ Good", title: "Scored 6 or higher" },
	{
		value: TOP_PICK_THRESHOLD,
		label: `${TOP_PICK_THRESHOLD}+ Great`,
		title: `Scored ${TOP_PICK_THRESHOLD} or higher — top picks`,
	},
	{ value: 8, label: "8+ Best", title: "Scored 8 or higher" },
];

export default function MoreFilters() {
	const {
		cityData,
		filtered,
		activeTags,
		toggleTag,
		vibes,
		toggleVibe,
		minScore,
		setMinScore,
		hiddenCount,
		clearHidden,
		venues,
		activeVenue,
		setActiveVenue,
	} = useEventsContext();
	const [tagQuery, setTagQuery] = useState("");

	// The pool is global and its order is stable, so a chip does not jump or
	// vanish as other filters narrow the list — that is what makes a zero-count
	// chip visible as "nothing here" instead of silently absent.
	const pool = useMemo(() => facetCounts(cityData.events).tags, [cityData]);
	// Counted over what is on screen right now, never the corpus.
	const live = useMemo(() => liveCounts(filtered), [filtered]);
	const shown = useMemo(
		() => visibleTags(pool, tagQuery, activeTags),
		[pool, tagQuery, activeTags],
	);

	const vibeMatch = tagQuery.trim().toLowerCase();

	return (
		<div className="more-panel">
			<div className="frow">
				<span className="frow-label">Min score</span>
				<fieldset className="seg" aria-label="Minimum score">
					{SCORE_TIERS.map((tier) => (
						<button
							type="button"
							key={tier.value}
							className={`seg-btn${minScore === tier.value ? " seg-btn--on" : ""}`}
							title={tier.title}
							aria-pressed={minScore === tier.value}
							onClick={() => setMinScore(tier.value)}
						>
							{tier.label}
						</button>
					))}
				</fieldset>
			</div>

			<div className="frow">
				<span className="frow-label">Vibe + tag</span>
				<div className="frow-body">
					<input
						type="text"
						className="tag-typeahead"
						value={tagQuery}
						onChange={(e) => setTagQuery(e.target.value)}
						placeholder="filter vibes + tags…"
						aria-label="Filter the vibe and tag chips"
						autoComplete="off"
					/>
					<div className="chips chips--pool">
						{VIBE_KEYS.filter(
							(key) =>
								!vibeMatch ||
								VIBE_LABELS[key].toLowerCase().includes(vibeMatch),
						).map((key) => {
							const on = vibes.includes(key);
							const count = live.vibes[key];
							const dead = count === 0 && !on;
							return (
								<button
									type="button"
									key={key}
									data-vibe={key}
									className={`chip chip--vibe${on ? " chip--on" : ""}${dead ? " chip--zero" : ""}`}
									disabled={dead}
									aria-pressed={on}
									onClick={() => toggleVibe(key)}
								>
									{VIBE_LABELS[key]}
									<span className="chip-count">{count}</span>
								</button>
							);
						})}
						{shown.map((tag) => {
							const on = activeTags.includes(tag);
							const count = live.tags.get(tag) ?? 0;
							const dead = count === 0 && !on;
							return (
								<button
									type="button"
									key={tag}
									className={`chip${on ? " chip--on" : ""}${dead ? " chip--zero" : ""}`}
									disabled={dead}
									aria-pressed={on}
									onClick={() => toggleTag(tag)}
								>
									{tag}
									<span className="chip-count">{count}</span>
								</button>
							);
						})}
						{shown.length === 0 && (
							<span className="frow-empty">no tags match “{tagQuery}”</span>
						)}
					</div>
				</div>
			</div>

			{venues.length > 0 && (
				<div className="frow">
					<span className="frow-label">Venue</span>
					<div className="frow-body">
						{/* Native select: a city has ~300 venues, and the platform
						    picker already does type-to-jump and a usable phone wheel. */}
						<select
							className="venue-select"
							aria-label="Venue"
							value={activeVenue ?? ""}
							onChange={(e) => setActiveVenue(e.target.value || null)}
						>
							<option value="">Any venue</option>
							{venues.map((v) => (
								<option key={v.name} value={v.name}>
									{v.name} ({v.count})
								</option>
							))}
						</select>
					</div>
				</div>
			)}

			<div className="frow">
				<span className="frow-label">Time</span>
				<div className="frow-body frow-body--inline">
					<TimeOfDayFilter />
					<PastFilter />
					{hiddenCount > 0 && (
						<button
							type="button"
							className="chip"
							onClick={clearHidden}
							title="Bring back every event you hid, and undo what it taught your preferences"
						>
							Unhide {hiddenCount} hidden
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
