import { X } from "lucide-react";
import type { DateRange } from "../types";
import { todayIso, tomorrowIso } from "../utils/dates";
import DateRangePicker from "./DateRangePicker";

interface Props {
	categories: string[];
	activeCat: string;
	dateRange: DateRange | null;
	activeTags: string[];
	weekStart?: string;
	weekEnd?: string;
	onCatChange: (cat: string) => void;
	onDateChange: (range: DateRange | null) => void;
	onTagRemove: (tag: string) => void;
}

export default function FilterBar({
	categories,
	activeCat,
	dateRange,
	activeTags,
	weekStart,
	weekEnd,
	onCatChange,
	onDateChange,
	onTagRemove,
}: Props) {
	const today = todayIso();
	const tomorrow = tomorrowIso();

	const isToday = dateRange?.start === today && dateRange?.end === today;
	const isTomorrow =
		dateRange?.start === tomorrow && dateRange?.end === tomorrow;
	// Value shown in the picker: only custom ranges (not today/tomorrow shortcuts)
	const pickerValue = isToday || isTomorrow ? null : dateRange;

	return (
		<div className="filter-bar-wrapper">
			<div className="filter-bar">
				<span className="filters">
					{["All", ...categories].map((cat) => (
						<button
							type="button"
							key={cat}
							className={`filter-btn${activeCat === cat ? " active" : ""}`}
							onClick={() => onCatChange(cat)}
						>
							{cat}
						</button>
					))}
				</span>
				<span className="filters">
					<button
						type="button"
						className={`filter-btn date-filter${isToday ? " active" : ""}`}
						onClick={() =>
							onDateChange(isToday ? null : { start: today, end: today })
						}
					>
						Today
					</button>
					<button
						type="button"
						className={`filter-btn date-filter${isTomorrow ? " active" : ""}`}
						onClick={() =>
							onDateChange(
								isTomorrow ? null : { start: tomorrow, end: tomorrow },
							)
						}
					>
						Tomorrow
					</button>
					<DateRangePicker
						value={pickerValue}
						onChange={onDateChange}
						minDate={weekStart}
						maxDate={weekEnd}
					/>
				</span>
			</div>
			{activeTags.length > 0 && (
				<div className="active-tags-bar">
					<span className="active-tags-label">tags</span>
					{activeTags.map((tag) => (
						<button
							type="button"
							key={tag}
							className="active-tag-chip"
							onClick={() => onTagRemove(tag)}
							aria-label={`Remove tag ${tag}`}
						>
							{tag}
							<X size={9} />
						</button>
					))}
				</div>
			)}
		</div>
	);
}
