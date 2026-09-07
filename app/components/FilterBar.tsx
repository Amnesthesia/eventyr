import { ChevronDown, Layers } from "lucide-react";
import { useId, useState } from "react";
import { LOW_SCORE_THRESHOLD } from "../../src/shared.ts";
import { useEventsContext } from "../context";
import ActiveTagsBar from "./filters/ActiveTagsBar";
import CategoryFilter from "./filters/CategoryFilter";
import DateFilter from "./filters/DateFilter";
import GroupByFilter from "./filters/GroupByFilter";
import VibeFilter from "./filters/VibeFilter";

interface Props {
	onSwipe: () => void;
}

export default function FilterBar({ onSwipe }: Props) {
	const {
		hideLowScore,
		setHideLowScore,
		hiddenCount,
		clearHidden,
		vibeFilters,
	} = useEventsContext();
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
				<div className="filter-bar filter-bar--group">
					<GroupByFilter />
					<span className="filters filters--tools">
						<button
							type="button"
							className={`filter-btn${hideLowScore ? " active" : ""}`}
							onClick={() => setHideLowScore(!hideLowScore)}
							aria-pressed={hideLowScore}
							title={`Hide events scored below ${LOW_SCORE_THRESHOLD}`}
						>
							Hide low scores
						</button>
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
