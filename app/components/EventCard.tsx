import { Bookmark, BookmarkCheck, CalendarDays, MapPin } from "lucide-react";
import { useState } from "react";
import { costLabel, stripForDisplay } from "../../src/shared.ts";
import { useEventsContext } from "../context";
import { useLongPress } from "../hooks/useLongPress";
import type { Event } from "../types";
import { catToSlug } from "../utils/categorySlug";
import { KEY_TO_SLUG } from "../utils/citySlug";
import { VIBE_LABELS, vibesOf } from "../utils/vibes";
import AddToCalendar from "./AddToCalendar";
import CardActionSheet from "./CardActionSheet";
import { CategoryIcon } from "./CategoryIcon";
import ShareButton from "./ShareButton";

/**
 * Above this many characters, a description becomes expandable.
 *
 * A character count rather than a measurement, because measuring needs a
 * laid-out DOM and this has to work in the static HTML. Tuned against the
 * NARROWEST card the grid produces (360px minus 40px of padding, ~50
 * characters per line at 0.8rem, five lines), so anything past it is genuinely
 * clamped at every width. Erring low on purpose: an expander that reveals
 * nothing on a wide card is a small annoyance, where text silently cut with no
 * way to reach it is a defect.
 */
const DESC_CLAMP_CHARS = 240;

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
	const { activeTags, toggleTag, cityKey, vibeFilters, setVibe, costLocale } =
		useEventsContext();
	const citySlug = KEY_TO_SLUG[cityKey] ?? cityKey;
	const [sheetOpen, setSheetOpen] = useState(false);
	const longPress = useLongPress(() => setSheetOpen(true));
	const catSlug = catToSlug(event.category);
	// null when the value says neither a price nor "free" — "See link" is 294 of
	// 643 events, and a pill carrying it tells a reader nothing.
	const cost = costLabel(event.cost, costLocale);
	const free = cost === "free";

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

	// Stripped at render, not in the pipeline: the data keeps the URL because a
	// description is often the only place a ticket link appears, but a card has
	// no room for one and a half-broken "(https://)" is just noise.
	const title = stripForDisplay(event.title);
	const description = stripForDisplay(event.description);

	return (
		<article
			className={classes}
			style={style}
			data-cat={catSlug}
			{...longPress}
		>
			<div className="card-top">
				<a className="card-cat" href={`/${citySlug}/${catSlug}/`}>
					<CategoryIcon name={event.category} size={11} strokeWidth={2.2} />
					{event.category}
				</a>

				<div className="card-top-right">
					{cost && (
						<span className={`card-cost${free ? " free" : ""}`}>{cost}</span>
					)}
					<AddToCalendar event={event} cityKey={cityKey} />
					<ShareButton event={event} cityKey={cityKey} />
					<button
						type="button"
						className={`star-btn${isStarred ? " starred" : ""}`}
						onClick={(e) => {
							e.preventDefault();
							onStarClick();
						}}
						aria-label={isStarred ? "Remove from saved" : "Save event"}
						aria-pressed={isStarred}
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
				{isTopPick && (
					// role="img" + aria-label rather than a bare glyph: to a screen
					// reader "✦" is noise, and this is the card's only remaining
					// top-pick marker now that the left rule is gone.
					<span
						className="top-mark"
						role="img"
						aria-label="Top pick"
						title="Top pick"
					>
						✦
					</span>
				)}
				{event.link ? (
					<a href={event.link} target="_blank" rel="noopener">
						{title}
					</a>
				) : (
					title
				)}
			</h3>
			<div className="card-meta">
				<span className="meta-row">
					<CalendarDays size={11} strokeWidth={2.2} />
					{event.datetime || "—"}
				</span>
				<span className="meta-row">
					<MapPin size={11} strokeWidth={2.2} />
					{event.location_url ? (
						<a href={event.location_url} target="_blank" rel="noopener">
							{event.location || "—"}
						</a>
					) : (
						event.location || "—"
					)}
				</span>
			</div>
			{description &&
				(description.length > DESC_CLAMP_CHARS ? (
					// <details> rather than a React toggle, so this works in the static
					// HTML with no JavaScript and no layout measurement. The full text is
					// always in the DOM — the clamp is purely visual — so nothing is
					// hidden from a screen reader, which is why the toggle is aria-hidden.
					<details className="card-desc-details">
						<summary>
							<span className="card-desc">{description}</span>
							<span className="card-desc-toggle" aria-hidden="true" />
						</summary>
					</details>
				) : (
					<p className="card-desc card-desc--plain">{description}</p>
				))}
			<div className="card-bottom">
				{event.score > 0 && (
					// Outside .card-tags on purpose: that row scrolls horizontally, and
					// the score must not be able to scroll out of view.
					<span
						className="card-score"
						title={`Fit score ${event.score} of 10`}
						style={
							{
								// Border strength only: 35% at a score of 1 through 100% at
								// 10. The full range is usable because this drives a border
								// rather than text — see the note on .card-score for why the
								// number cannot take this ramp.
								"--score-tint": `${Math.round(35 + ((event.score - 1) / 9) * 65)}%`,
							} as React.CSSProperties
						}
					>
						{event.score}
					</span>
				)}
				<div className="card-tags">
					{vibesOf(event).map((key) => (
						<button
							type="button"
							key={key}
							className={`tag tag-vibe${vibeFilters[key] === "yes" ? " active" : ""}`}
							data-vibe={key}
							// Toggles the vibe filter rather than the tag filter: these are
							// booleans on the event, not free-text tags, and VibeFilter in
							// the bar above is the control they belong to.
							onClick={() =>
								setVibe(key, vibeFilters[key] === "yes" ? "any" : "yes")
							}
							aria-pressed={vibeFilters[key] === "yes"}
						>
							{VIBE_LABELS[key]}
						</button>
					))}
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
			{sheetOpen && (
				<CardActionSheet
					event={event}
					cityKey={cityKey}
					isStarred={isStarred}
					onStarClick={onStarClick}
					onClose={() => setSheetOpen(false)}
				/>
			)}
		</article>
	);
}
