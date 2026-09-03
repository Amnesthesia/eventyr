// A popover holding two native date inputs.
//
// Twice rebuilt: it began as a react-aria RangeCalendar (two dependencies for
// one component, when the values here are already the YYYY-MM-DD strings
// <input type="date"> speaks), and then the popover stopped appearing at all.
// That was not hydration — the cause is CSS. Its parent `.filters` sets
// `overflow-x: auto`, and the spec does not honour `overflow-y: visible` when
// the other axis is auto, so the whole row is a scroll container and an
// absolutely positioned panel hanging below the button is clipped by it.
// `.filters--date` therefore opts out of scrolling and wraps instead.

import { CalendarDays, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
	// Local, because a half-entered range must not filter the list down to
	// nothing while the second date is still being chosen.
	const [draft, setDraft] = useState<DateRange>({ start: "", end: "" });
	const wrapperRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!open) return;
		function onClickOutside(e: MouseEvent) {
			const target = e.target as Node | null;
			// A native date picker panel is browser UI, not part of the page, so a
			// click in one must not read as a click outside — that would close the
			// popover mid-pick.
			if (!target || !document.contains(target)) return;
			if (wrapperRef.current && !wrapperRef.current.contains(target)) {
				setOpen(false);
			}
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onClickOutside);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onClickOutside);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	function edit(part: "start" | "end", raw: string) {
		const next = { ...draft, [part]: raw };
		setDraft(next);
		if (!next.start || !next.end) return;
		// A backwards range is the user picking the end first; read it either way
		// rather than rejecting it.
		const [start, end] =
			next.start <= next.end ? [next.start, next.end] : [next.end, next.start];
		onChange({ start, end });
		setOpen(false);
	}

	const label = value ? fmtRange(value.start, value.end) : "date range";

	return (
		<span className="date-range-wrapper" ref={wrapperRef}>
			<button
				type="button"
				className={`filter-btn date-filter${value ? " active" : ""}`}
				onClick={() => {
					setDraft(value ?? { start: "", end: "" });
					setOpen((v) => !v);
				}}
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
						setDraft({ start: "", end: "" });
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
					<label className="date-picker-field">
						From
						<input
							type="date"
							value={draft.start}
							min={minDate}
							max={draft.end || maxDate}
							onChange={(e) => edit("start", e.target.value)}
						/>
					</label>
					<label className="date-picker-field">
						To
						<input
							type="date"
							value={draft.end}
							min={draft.start || minDate}
							max={maxDate}
							onChange={(e) => edit("end", e.target.value)}
						/>
					</label>
				</div>
			)}
		</span>
	);
}
