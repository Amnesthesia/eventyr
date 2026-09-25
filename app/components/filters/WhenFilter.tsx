import { addDays, weekendRange } from "@dothingslol/core/dates";
import type { DateRange } from "@dothingslol/core/schema";
import { zonedDate } from "@dothingslol/core/tz";
import { useEventsContext } from "../../context";
import DateRangePicker from "../DateRangePicker";

/**
 * The when-control: one segmented row, always exactly one segment lit.
 *
 * Derived from `dateRange` rather than carrying its own state — the date-range
 * picker and the /today/ /tomorrow/ /this-weekend/ pages already write that,
 * and a second source of truth would have to be kept in step with all three.
 * A custom range from the picker simply matches no segment.
 */
function sameRange(a: DateRange | null, b: DateRange | null): boolean {
	if (!a || !b) return a === b;
	return a.start === b.start && a.end === b.end;
}

export default function WhenFilter() {
	const { dateRange, setDateRange, dateMin, dateMax, todayStr, cityData } =
		useEventsContext();
	// The viewer's own date once mounted (todayStr). Before that, in the build's
	// render and the first client render, which have to agree: the city's date,
	// the same one the /today/ page was built for. Calling todayIso() here read
	// the BUILD host's clock, so a UTC build lit the wrong segment for the first
	// ten hours of a Brisbane day.
	const today = todayStr || zonedDate(cityData.timezone, new Date());
	const tomorrow = addDays(today, 1);
	const options: { key: string; label: string; range: DateRange | null }[] = [
		{ key: "any", label: "Any day", range: null },
		{ key: "today", label: "Today", range: { start: today, end: today } },
		{
			key: "tomorrow",
			label: "Tomorrow",
			range: { start: tomorrow, end: tomorrow },
		},
		{ key: "weekend", label: "Weekend", range: weekendRange(today) },
	];

	// A range that is none of the presets belongs to the picker, which is what
	// keeps its own label showing the dates rather than blank.
	const custom = !options.some((o) => sameRange(o.range, dateRange));

	return (
		<div className="when-filter">
			<fieldset className="seg" aria-label="When">
				{options.map((o) => {
					const on = sameRange(o.range, dateRange);
					return (
						<button
							type="button"
							key={o.key}
							className={`seg-btn${on ? " seg-btn--on" : ""}`}
							aria-pressed={on}
							onClick={() => setDateRange(o.range)}
						>
							{o.label}
						</button>
					);
				})}
			</fieldset>
			{/* Any other date lives here, next to the presets rather than behind
			    the disclosure: "what is on next Thursday" is a first-tier question,
			    and the presets cannot answer it. */}
			<DateRangePicker
				value={custom ? dateRange : null}
				onChange={setDateRange}
				minDate={dateMin}
				maxDate={dateMax}
			/>
		</div>
	);
}
