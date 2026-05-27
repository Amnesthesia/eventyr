import { Bookmark, BookmarkCheck, CalendarDays, MapPin } from "lucide-react";
import { useMemo } from "react";
import { useEventsContext } from "../context";
import type { Event } from "../types";
import { catToSlug } from "../utils/categorySlug";
import { KEY_TO_SLUG } from "../utils/citySlug";
import { CategoryIcon } from "./CategoryIcon";

interface Props {
	event: Event;
	isTopPick: boolean;
	isPast: boolean;
	isStarred: boolean;
	onStarClick: () => void;
}

export default function EventCard({
	event,
	isTopPick,
	isPast,
	isStarred,
	onStarClick,
}: Props) {
	const { activeTags, toggleTag, cityKey } = useEventsContext();
	const citySlug = KEY_TO_SLUG[cityKey] ?? cityKey;
	const catSlug = catToSlug(event.category);
	const free = /free/.test((event.cost || "").toLowerCase());

	const classes = [
		"card",
		isTopPick ? "top-pick" : "",
		event.image ? "has-image" : "",
		isPast ? "event-past" : "",
	]
		.filter(Boolean)
		.join(" ");

	const style = event.image
		? ({ "--event-image": `url('${event.image}')` } as React.CSSProperties)
		: undefined;

	const cost = useMemo(() => {
		if (free) return "free";
		if (!event.cost) return "Not specified";
		if (/ticketed/i.test(event.cost)) return "Ticketed";
		return event.cost;
	}, [event.cost, free]);
	return (
		<article className={classes} style={style}>
			<div className="card-top">
				<a className="card-cat" href={`/${citySlug}/${catSlug}`}>
					<CategoryIcon name={event.category} size={11} strokeWidth={2.2} />
					{event.category}
				</a>

				<div className="card-top-right">
					<span className={`card-cost${free ? " free" : ""}`}>
						{free || /free/.test(cost || "") ? "free" : cost || "—"}
					</span>
					<button
						type="button"
						className={`star-btn${isStarred ? " starred" : ""}`}
						onClick={(e) => {
							e.preventDefault();
							onStarClick();
						}}
						aria-label={isStarred ? "Remove from saved" : "Save event"}
						aria-pressed={isStarred}
						style={{ position: "absolute", top: 0, right: 4 }}
					>
						{isStarred ? (
							<BookmarkCheck size={18} strokeWidth={2} />
						) : (
							<Bookmark size={18} strokeWidth={2} />
						)}
					</button>
				</div>
			</div>
			<h3 className="card-title">
				{isTopPick && <em className="top-mark">✦</em>}
				{event.link ? (
					<a href={event.link} target="_blank" rel="noopener">
						{event.title}
					</a>
				) : (
					event.title
				)}
			</h3>
			<div className="card-meta">
				<span className="meta-row">
					<CalendarDays size={11} strokeWidth={2.2} />
					{event.datetime || "—"}
				</span>
				<span className="meta-row">
					<MapPin size={11} strokeWidth={2.2} />
					{event.location || "—"}
				</span>
			</div>
			{event.description && <p className="card-desc">{event.description}</p>}
			<div className="card-bottom">
				<div className="card-tags">
					{event.tags.slice(0, 5).map((tag) => (
						<button
							type="button"
							key={tag}
							className={`tag tag-btn${activeTags.includes(tag) ? " active" : ""}`}
							onClick={() => toggleTag(tag)}
							aria-pressed={activeTags.includes(tag)}
						>
							{tag}
						</button>
					))}
				</div>
			</div>
		</article>
	);
}
