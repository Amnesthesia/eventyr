import { useEventsContext } from "../context";
import type { Event } from "../types";
import EventCard from "./EventCard";

interface Props {
	events: Event[];
	isTopPick: boolean;
}

export default function EventGrid({ events, isTopPick }: Props) {
	const { starred, toggleStar, isEventPast } = useEventsContext();

	return (
		<div className="card-grid">
			{events.map((event) => {
				const id = event.title + event.datetime_iso;
				return (
					<EventCard
						key={id}
						event={event}
						isTopPick={isTopPick}
						isPast={isEventPast(event)}
						isStarred={starred.has(id)}
						onStarClick={() => toggleStar(id)}
					/>
				);
			})}
		</div>
	);
}
