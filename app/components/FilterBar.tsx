import { X } from "lucide-react";
import type { DateRange, PastFilter, TriState, VibeFilters, VibeKey } from "../types";
import { todayIso, tomorrowIso } from "../utils/dates";
import DateRangePicker from "./DateRangePicker";

const VIBE_LABELS: Record<VibeKey, string> = {
	intellectual: "Stimulating",
	creative: "Creative",
	hands_on: "Hands On",
	social: "Social",
};
const VIBE_KEYS: VibeKey[] = ["intellectual", "creative", "hands_on", "social"];
const CYCLE: Record<TriState, TriState> = { any: "yes", yes: "no", no: "any" };

interface Props {
	categories: string[];
	activeCat: string;
	dateRange: DateRange | null;
	activeTags: string[];
	weekStart?: string;
	weekEnd?: string;
	pastFilter: PastFilter;
	vibeFilters: VibeFilters;
	onCatChange: (cat: string) => void;
	onDateChange: (range: DateRange | null) => void;
	onTagRemove: (tag: string) => void;
	onPastFilterChange: (v: PastFilter) => void;
	onVibeChange: (key: VibeKey, state: TriState) => void;
}

const PAST_CYCLE: Record<PastFilter, PastFilter> = {
	"no-past": "all",
	all: "only-past",
	"only-past": "no-past",
};
const PAST_LABEL: Record<PastFilter, string> = {
	"no-past": "No Past",
	all: "All Events",
	"only-past": "Past Events",
};

export default function FilterBar({
	categories,
	activeCat,
	dateRange,
	activeTags,
	weekStart,
	weekEnd,
	pastFilter,
	vibeFilters,
	onCatChange,
	onDateChange,
	onTagRemove,
	onPastFilterChange,
	onVibeChange,
}: Props) {
	const today = todayIso();
	const tomorrow = tomorrowIso();

	const isToday = dateRange?.start === today && dateRange?.end === today;
	const isTomorrow =
		dateRange?.start === tomorrow && dateRange?.end === tomorrow;
	const pickerValue = isToday || isTomorrow ? null : dateRange;

	return (
		<div className="filter-bar-wrapper">
			<div className="filter-bar filter-bar--cats">
				<span className="filters filters--cat">
						<button
							type="button"
							className={`filter-btn${activeCat === "All" || !activeCat ? " active" : ""}`}
							onClick={() => onCatChange("All")}
						>
							All Categories
						</button>
					{categories.map((cat) => (
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
				<span className="filters filters--date">
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
					<button
						type="button"
						className={
							pastFilter === "only-past"
								? "filter-btn active"
								: pastFilter === "no-past"
									? "filter-btn vibe-no"
									: "filter-btn"
						}
						onClick={() => onPastFilterChange(PAST_CYCLE[pastFilter])}
					>
						{PAST_LABEL[pastFilter]}
					</button>
					<DateRangePicker
						value={pickerValue}
						onChange={onDateChange}
						minDate={weekStart}
						maxDate={weekEnd}
					/>
				</span>
			</div>
			<div className="filter-bar filter-bar--vibe">
				<span className="filters">
					<button
						type="button"
						className={`filter-btn${Object.values(vibeFilters).every((v) => v === "any") ? " active" : ""}`}
						onClick={() => {
							onVibeChange("intellectual", "any");
							onVibeChange("creative", "any");
							onVibeChange("hands_on", "any");
							onVibeChange("social", "any");
						}}
					>
						All Vibes
					</button>
					{VIBE_KEYS.map((key) => {
						const state = vibeFilters[key];
						const cls =
							state === "yes"
								? "filter-btn active"
								: state === "no"
									? "filter-btn vibe-no"
									: "filter-btn";
						const prefix = state === "yes" ? "+ " : state === "no" ? "− " : "";
						return (
							<button
								type="button"
								key={key}
								className={cls}
								onClick={() => onVibeChange(key, CYCLE[state])}
							>
								{prefix}{VIBE_LABELS[key]}
							</button>
						);
					})}
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
