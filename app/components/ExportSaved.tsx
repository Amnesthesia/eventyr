// Downloads every saved (bookmarked) event as one .ics.
//
// Reads the saved set against the whole city rather than the filtered list:
// "export my saved events" means all of them, not the ones the current
// category or date filter happens to leave visible.
import { BookmarkCheck, CalendarPlus } from "lucide-react";
import { eventId, useEventsContext } from "../context";
import { buildIcs, downloadIcs } from "../utils/ics";

interface Props {
	/** Header form: bookmark icon + count, sized like the theme button. */
	compact?: boolean;
}

export default function ExportSaved({ compact }: Props) {
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

	const title = `${saved.length} saved. Download them as a calendar file`;
	if (compact) {
		return (
			<button
				type="button"
				className="theme-btn saved-count"
				onClick={download}
				title={title}
				aria-label={title}
			>
				<BookmarkCheck size={12} strokeWidth={2} />
				{saved.length}
			</button>
		);
	}
	return (
		<button
			type="button"
			className="filter-btn"
			onClick={download}
			title={title}
		>
			<CalendarPlus size={12} strokeWidth={2.2} />
			<span>Export saved ({saved.length})</span>
		</button>
	);
}
