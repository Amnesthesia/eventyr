import type { DateRange, Event } from "../types";
import EventCard from "./EventCard";

interface Props {
	events: Event[];
	isTopPick: boolean;
	dateRange: DateRange | null;
	activeTags: string[];
	onTagClick: (tag: string) => void;
}

export default function EventGrid({
	events,
	isTopPick,
	activeTags,
	onTagClick,
}: Props) {
	return (
		<div className="card-grid">
			{events.map((event) => (
				<EventCard
					key={event.title + event.datetime_iso}
					event={event}
					isTopPick={isTopPick}
					activeTags={activeTags}
					onTagClick={onTagClick}
				/>
			))}
		</div>
	);
}
