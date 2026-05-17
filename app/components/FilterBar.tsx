import ActiveTagsBar from "./filters/ActiveTagsBar";
import CategoryFilter from "./filters/CategoryFilter";
import DateFilter from "./filters/DateFilter";
import VibeFilter from "./filters/VibeFilter";

export default function FilterBar() {
	return (
		<div className="filter-bar-wrapper">
			<div className="filter-bar filter-bar--cats">
				<CategoryFilter />
				<DateFilter />
			</div>
			<div className="filter-bar filter-bar--vibe">
				<VibeFilter />
			</div>
			<ActiveTagsBar />
		</div>
	);
}
