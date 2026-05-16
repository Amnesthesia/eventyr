import {
	getLocalTimeZone,
	today as getToday,
	parseDate,
} from "@internationalized/date";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DateValue, RangeValue } from "react-aria-components";
import {
	Button,
	CalendarCell,
	CalendarGrid,
	CalendarGridBody,
	CalendarGridHeader,
	CalendarHeaderCell,
	Heading,
	RangeCalendar,
} from "react-aria-components";
import type { DateRange } from "../types";
import { fmtRange } from "../utils/dates";

interface Props {
	value: DateRange | null;
	onChange: (range: DateRange | null) => void;
	minDate?: string;
	maxDate?: string;
}

export default function DateRangePicker({
	value,
	onChange,
	minDate,
	maxDate,
}: Props) {
	const [open, setOpen] = useState(false);
	const wrapperRef = useRef<HTMLSpanElement>(null);
	const tz = getLocalTimeZone();

	useEffect(() => {
		if (!open) return;
		function onClickOutside(e: MouseEvent) {
			if (
				wrapperRef.current &&
				!wrapperRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", onClickOutside);
		return () => document.removeEventListener("mousedown", onClickOutside);
	}, [open]);

	const ariaValue = value
		? { start: parseDate(value.start), end: parseDate(value.end) }
		: null;

	function handleCalendarChange(range: RangeValue<DateValue> | null) {
		if (range) {
			onChange({ start: range.start.toString(), end: range.end.toString() });
			setOpen(false);
		}
	}

	const label = value ? fmtRange(value.start, value.end) : "date range";

	return (
		<span className="date-range-wrapper" ref={wrapperRef}>
			<button
				type="button"
				className={`filter-btn date-filter${value ? " active" : ""}`}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-label={value ? `Date range: ${label}` : "Pick date range"}
			>
				<CalendarDays size={10} />
				{value && <span>{label}</span>}
			</button>
			{value && (
				<button
					type="button"
					className="filter-btn date-range-clear"
					onClick={() => {
						onChange(null);
						setOpen(false);
					}}
					aria-label="Clear date range"
				>
					<X size={10} />
				</button>
			)}
			{open && (
				<div
					className="date-picker-popover"
					role="dialog"
					aria-label="Select date range"
				>
					<RangeCalendar
						className="range-calendar"
						value={ariaValue}
						onChange={handleCalendarChange}
						defaultFocusedValue={ariaValue?.start ?? getToday(tz)}
						minValue={minDate ? parseDate(minDate) : undefined}
						maxValue={maxDate ? parseDate(maxDate) : undefined}
					>
						<header className="cal-header">
							<Button slot="previous" className="cal-nav-btn">
								<ChevronLeft size={13} />
							</Button>
							<Heading className="cal-heading" />
							<Button slot="next" className="cal-nav-btn">
								<ChevronRight size={13} />
							</Button>
						</header>
						<CalendarGrid className="cal-grid">
							<CalendarGridHeader>
								{(day) => (
									<CalendarHeaderCell className="cal-header-cell">
										{day}
									</CalendarHeaderCell>
								)}
							</CalendarGridHeader>
							<CalendarGridBody>
								{(date) => <CalendarCell date={date} className="cal-cell" />}
							</CalendarGridBody>
						</CalendarGrid>
					</RangeCalendar>
				</div>
			)}
		</span>
	);
}
