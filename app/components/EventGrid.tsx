import type { DateRange, Event } from "../types";
import EventCard from "./EventCard";

interface Props {
	events: Event[];
	isTopPick: boolean;
	dateRange: DateRange | null;
	activeTags: string[];
	onTagClick: (tag: string) => void;
	isEventPast?: (event: Event) => boolean;
}

export default function EventGrid({
	events,
	isTopPick,
	activeTags,
	onTagClick,
	isEventPast,
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
					isPast={isEventPast?.(event) ?? false}
				/>
			))}
		</div>
	);
}
