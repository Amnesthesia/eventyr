import ActiveTagsBar from "./filters/ActiveTagsBar";
import CategoryFilter from "./filters/CategoryFilter";
import DateFilter from "./filters/DateFilter";
import GroupByFilter from "./filters/GroupByFilter";
import VibeFilter from "./filters/VibeFilter";

export default function FilterBar() {
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
			</div>
			<ActiveTagsBar />
		</div>
	);
}
