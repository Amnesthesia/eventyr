import type { EventData } from "@dothingslol/core/schema";
import { eventId, useEventsContext } from "../context";
import EventCard from "./EventCard";

interface Props {
	events: EventData[];
	isTopPick: boolean;
}

export default function EventGrid({ events, isTopPick }: Props) {
	const { starred, toggleStar, dislikeEvent, isEventPast } = useEventsContext();

	return (
		<div className="card-grid">
			{events.map((event) => {
				const id = eventId(event);
				return (
					<EventCard
						// eventId alone repeats: council feeds list "Yoga" at 09:00 in
						// two parks. A duplicate key leaves stale cards on screen once
						// a filter removes one — the venue filter showed it.
						key={`${id}\u0000${event.location}`}
						event={event}
						isTopPick={isTopPick}
						isPast={isEventPast(event)}
						isStarred={starred.has(id)}
						onStarClick={() => toggleStar(id)}
						onDislikeClick={() => dislikeEvent(id)}
					/>
				);
			})}
		</div>
	);
}
