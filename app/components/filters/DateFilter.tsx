import { useEventsContext } from "../../context";
import { todayIso, tomorrowIso } from "../../utils/dates";
import DateRangePicker from "../DateRangePicker";
import PastFilter from "./PastFilter";

export default function DateFilter() {
	const { dateRange, setDateRange, weekStart, weekEnd } = useEventsContext();
	const today = todayIso();
	const tomorrow = tomorrowIso();

	const isToday = dateRange?.start === today && dateRange?.end === today;
	const isTomorrow =
		dateRange?.start === tomorrow && dateRange?.end === tomorrow;
	const pickerValue = isToday || isTomorrow ? null : dateRange;

	return (
		<span className="filters filters--date">
			<button
				type="button"
				className={`filter-btn date-filter${isToday ? " active" : ""}`}
				onClick={() =>
					setDateRange(isToday ? null : { start: today, end: today })
				}
			>
				Today
			</button>
			<button
				type="button"
				className={`filter-btn date-filter${isTomorrow ? " active" : ""}`}
				onClick={() =>
					setDateRange(isTomorrow ? null : { start: tomorrow, end: tomorrow })
				}
			>
				Tomorrow
			</button>
			<PastFilter />
			<DateRangePicker
				value={pickerValue}
				onChange={setDateRange}
				minDate={weekStart}
				maxDate={weekEnd}
			/>
		</span>
	);
}
