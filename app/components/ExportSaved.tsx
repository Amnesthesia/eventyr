// Downloads every saved (bookmarked) event as one .ics.
//
// Reads the saved set against the whole city rather than the filtered list:
// "export my saved events" means all of them, not the ones the current
// category or date filter happens to leave visible.
import { CalendarPlus } from "lucide-react";
import { eventId, useEventsContext } from "../context";
import { buildIcs, downloadIcs } from "../utils/ics";

export default function ExportSaved() {
	const { cityData, cityKey, starred } = useEventsContext();
	const saved = cityData.events.filter((e) => starred.has(eventId(e)));
	if (saved.length === 0) return null;

	function download() {
		const ics = buildIcs(saved, cityKey, {
			timezone: cityData.timezone,
			name: `Saved: do things in ${cityData.city.split(",")[0]}`,
		});
		if (ics) downloadIcs(ics, `saved-${cityKey}.ics`);
	}

	return (
		<button
			type="button"
			className="filter-btn"
			onClick={download}
			title="Download your saved events as a calendar file"
		>
			<CalendarPlus size={12} strokeWidth={2.2} />
			<span>Export saved ({saved.length})</span>
		</button>
	);
}
