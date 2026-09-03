// Downloads a single-event .ics.
//
// Built on click as a Blob rather than as a data: URI at render time. Two
// reasons: 643 inline data URIs would bloat every page's HTML, and the file
// content would otherwise have to be computed during SSR, where anything
// time-dependent differs from the hydrated render.
import { CalendarPlus } from "lucide-react";
import type { Event } from "../types";
import { buildEventIcs, icsFilename } from "../utils/ics";

interface Props {
	event: Event;
	cityKey: string;
	/** Shown next to the icon. Omit for the icon-only version used on cards. */
	label?: string;
	/** Overrides the default styling, so a card can render this small and
	 * inline where the event page renders it as a button. */
	className?: string;
	iconSize?: number;
}

export default function AddToCalendar({
	event,
	cityKey,
	label,
	className,
	iconSize,
}: Props) {
	// An event with no parsable date cannot be a calendar entry, so there is
	// nothing to offer rather than a button that downloads a broken file.
	const ics = buildEventIcs(event, cityKey);
	if (!ics) return null;

	function download() {
		const blob = new Blob([ics as string], {
			type: "text/calendar;charset=utf-8",
		});
		const href = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = href;
		a.download = icsFilename(event);
		a.click();
		// Released on the next tick: revoking synchronously can cancel the
		// download before the browser has read the blob.
		setTimeout(() => URL.revokeObjectURL(href), 0);
	}

	return (
		<button
			type="button"
			className={className ?? (label ? "filter-btn" : "icon-btn")}
			onClick={download}
			aria-label={`Add ${event.title} to your calendar`}
			title="Add to calendar"
		>
			<CalendarPlus size={iconSize ?? (label ? 12 : 11)} strokeWidth={2.2} />
			{label && <span>{label}</span>}
		</button>
	);
}
