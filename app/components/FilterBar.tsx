import { ChevronDown, Layers } from "lucide-react";
import { type CSSProperties, useId, useState } from "react";
import { LOW_SCORE_THRESHOLD, TOP_PICK_THRESHOLD } from "../../src/shared.ts";
import { useEventsContext } from "../context";
import ActiveTagsBar from "./filters/ActiveTagsBar";
import CategoryFilter from "./filters/CategoryFilter";
import DateFilter from "./filters/DateFilter";
import GroupByFilter from "./filters/GroupByFilter";
import TagFilter from "./filters/TagFilter";
import VibeFilter from "./filters/VibeFilter";
import PreferencesPane from "./PreferencesPane";

interface Props {
	onSwipe: () => void;
}

/**
 * Score thresholds offered in the filter.
 *
 * Anchored on the two values that already mean something elsewhere rather than
 * an invented scale: LOW_SCORE_THRESHOLD is where venue promotion stops (the
 * ical/rss feeds cut there too) and TOP_PICK_THRESHOLD is what the site
 * surfaces as a top pick. The rest fill in the top of the ramp, where a long
 * list actually needs thinning.
 */
const SCORE_STEPS: { value: number; label: string; title: string }[] = [
	// Carries the naming for the whole control, so no separate label is needed
	// — the same trick "All Vibes" and "Ungrouped" already use in this bar.
	{ value: 0, label: "Any score", title: "Every event, whatever it scored" },
	{
		value: LOW_SCORE_THRESHOLD,
		label: String(LOW_SCORE_THRESHOLD),
		title: `Score ${LOW_SCORE_THRESHOLD} or higher — hides venue promotion`,
	},
	{ value: 5, label: "5", title: "Score 5 or higher" },
	{ value: 6, label: "6", title: "Score 6 or higher" },
	{
		value: TOP_PICK_THRESHOLD,
		label: String(TOP_PICK_THRESHOLD),
		title: `Score ${TOP_PICK_THRESHOLD} or higher — top picks`,
	},
	{ value: 8, label: "8", title: "Score 8 or higher" },
	{ value: 9, label: "9", title: "Score 9 or higher" },
];

/** Border strength for a score chip, on the same ramp EventCard uses for
 * .card-score — so a 9 here looks like a 9 on a card. */
function scoreTint(score: number): string {
	return `${Math.round(35 + ((score - 1) / 9) * 65)}%`;
}

export default function FilterBar({ onSwipe }: Props) {
	const { minScore, setMinScore, hiddenCount, clearHidden, vibeFilters } =
		useEventsContext();
	const activeVibeCount = Object.values(vibeFilters).filter(
		(v) => v !== "any",
	).length;
	// Closed by default, matching the server-rendered markup exactly (no
	// hydration mismatch) — CSS forces the row open above 900px regardless of
	// this state (see .filters-more), so only a phone-width visitor ever sees
	// the closed state or the toggle button at all.
	//
	// A plain state-driven class, not <details>/<summary>: Chromium's <details>
	// hides its non-summary content through an internal not-rendered state
	// rather than a plain `display: none` UA rule, and that cannot be
	// overridden by author CSS the way the display:none-based collapse in
	// older engines could — so "always open above 900px, closed below it" had
	// no CSS-only way to express with a real <details>.
	const [moreOpen, setMoreOpen] = useState(false);
	const moreId = useId();

	return (
		<div className="filter-bar-wrapper">
			{/* Date and category stay sticky above the list (see .filter-bar--cats)
			    — the controls a returning reader reaches for every visit, kept in
			    view across a 400-card scroll. */}
			<div className="filter-bar filter-bar--cats">
				<DateFilter />
				<CategoryFilter />
			</div>

			{/* Below 900px this collapses behind one toggle row: three rows of
			    pills above the fold pushed the first event off a phone screen for
			    someone who just followed a search result in. */}
			<button
				type="button"
				className="filters-more-toggle filter-btn"
				onClick={() => setMoreOpen((open) => !open)}
				aria-expanded={moreOpen}
				aria-controls={moreId}
			>
				More filters{activeVibeCount > 0 && ` (${activeVibeCount})`}
				<ChevronDown size={12} strokeWidth={2.2} />
			</button>
			<div id={moreId} className={`filters-more${moreOpen ? " open" : ""}`}>
				<div className="filter-bar filter-bar--vibe">
					<VibeFilter />
				</div>
				<div className="filter-bar filter-bar--tag">
					<TagFilter />
				</div>
				<div className="filter-bar filter-bar--group">
					<GroupByFilter />
					<span className="filters filters--tools">
						<PreferencesPane />
						{/* Real radios, visually hidden: arrow-key navigation, the
						    roving tabindex and single-choice semantics all come free, and
						    a threshold is genuinely a single-choice control.
						    role="radiogroup" + aria-labelledby rather than
						    fieldset/legend: a <legend> is rendered in the fieldset's
						    border box rather than as a flex item, so it always stacked
						    above the chips and pushed this control onto a second row. */}
						<div
							className="score-picker"
							role="radiogroup"
							aria-label="Minimum score"
						>
							{SCORE_STEPS.map((step) => (
								<label
									key={step.value}
									className={`score-chip${
										minScore === step.value ? " score-chip--on" : ""
									}${
										// "Any" is the off switch, not a score being excluded,
										// so it never dims.
										step.value > 0 && step.value < minScore
											? " score-chip--out"
											: ""
									}${step.value === 0 ? " score-chip--any" : ""}`}
									title={step.title}
									style={
										step.value > 0
											? ({
													"--score-tint": scoreTint(step.value),
												} as CSSProperties)
											: undefined
									}
								>
									<input
										type="radio"
										name="min-score"
										value={step.value}
										checked={minScore === step.value}
										onChange={() => setMinScore(step.value)}
									/>
									<span>{step.label}</span>
								</label>
							))}
						</div>
						{hiddenCount > 0 && (
							<button
								type="button"
								className="filter-btn"
								onClick={clearHidden}
								title="Bring back every event you swiped away"
							>
								Unhide {hiddenCount} skipped
							</button>
						)}
						<button
							type="button"
							className="filter-btn swipe-btn"
							onClick={onSwipe}
						>
							<Layers size={12} strokeWidth={2.2} />
							Swipe
						</button>
					</span>
				</div>
			</div>
			<ActiveTagsBar />
		</div>
	);
}
