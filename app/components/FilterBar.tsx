import { Layers } from "lucide-react";
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
	const { hideLowScore, setHideLowScore, hiddenCount, clearHidden } =
		useEventsContext();

	return (
		<div className="filter-bar-wrapper">
			<div className="filter-bar filter-bar--cats">
				<DateFilter />
				<CategoryFilter />
			</div>
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
					<button type="button" className="filter-btn" onClick={onSwipe}>
						<Layers size={12} strokeWidth={2.2} />
						Swipe
					</button>
				</span>
			</div>
			<ActiveTagsBar />
		</div>
	);
}
