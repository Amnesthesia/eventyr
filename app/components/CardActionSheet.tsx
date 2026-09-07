// The long-press menu on a card: bookmark, share, add to calendar.
//
// A bottom sheet rather than a popover anchored to the card, because on a
// phone the card can be anywhere on screen and the thumb is at the bottom.
import {
	Bookmark,
	BookmarkCheck,
	CalendarPlus,
	Check,
	Share2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useEventsContext } from "../context";
import type { Event } from "../types";
import { calendarLinks } from "../utils/calendarLinks";
import { downloadEventIcs } from "../utils/ics";
import { shareEvent } from "../utils/share";

interface Props {
	event: Event;
	cityKey: string;
	isStarred: boolean;
	onStarClick: () => void;
	onClose: () => void;
}

export default function CardActionSheet({
	event,
	cityKey,
	isStarred,
	onStarClick,
	onClose,
}: Props) {
	const { cityData } = useEventsContext();
	const [copied, setCopied] = useState(false);
	// Every calendar route, not just the download: this sheet is the
	// discoverable place to pick one when the button's platform guess is wrong.
	// No date means no calendar entry at all, and calendarLinks drops the rows
	// it cannot build — the download row is the only unconditional one, so a
	// list of exactly that means there is nothing real to offer.
	const calendars = calendarLinks(event, cityKey, cityData.timezone);
	const canAddToCalendar = calendars.some((link) => link.href !== null);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", onKeyDown);
		// The page behind a modal sheet must not scroll under it.
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previous;
		};
	}, [onClose]);

	async function handleShare() {
		const outcome = await shareEvent(event, cityKey);
		if (outcome === "copied") {
			// Held open briefly so the "Link copied" state is actually seen.
			setCopied(true);
			setTimeout(onClose, 900);
			return;
		}
		if (outcome !== "cancelled") onClose();
	}

	return (
		<div className="sheet-backdrop">
			{/* A real button rather than a click handler on the backdrop div: it is
			    focusable, it announces itself, and it needs no keyboard handler of
			    its own. Escape closes the sheet too. */}
			<button
				type="button"
				className="sheet-scrim"
				aria-label="Close menu"
				onClick={onClose}
			/>
			<div
				className="sheet"
				role="dialog"
				aria-modal="true"
				aria-label={event.title}
			>
				<p className="sheet-title">{event.title}</p>
				<button
					type="button"
					className="sheet-action"
					onClick={() => {
						onStarClick();
						onClose();
					}}
				>
					{isStarred ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
					{isStarred ? "Remove pin" : "Pin to Top Picks"}
				</button>
				{canAddToCalendar &&
					calendars.map((link) =>
						link.href ? (
							<a
								key={link.key}
								className="sheet-action"
								href={link.href}
								// Apple's .ics is same-origin and has to be handed to the
								// OS; the web templates are another site.
								target={link.key === "apple" ? undefined : "_blank"}
								rel="noopener"
								onClick={onClose}
							>
								<CalendarPlus size={16} />
								{link.label}
							</a>
						) : (
							<button
								key={link.key}
								type="button"
								className="sheet-action"
								onClick={() => {
									downloadEventIcs(event, cityKey);
									onClose();
								}}
							>
								<CalendarPlus size={16} />
								{link.label}
							</button>
						),
					)}
				<button type="button" className="sheet-action" onClick={handleShare}>
					{copied ? <Check size={16} /> : <Share2 size={16} />}
					{copied ? "Link copied" : "Share"}
				</button>

				<button
					type="button"
					className="sheet-action sheet-cancel"
					onClick={onClose}
				>
					Cancel
				</button>
			</div>
		</div>
	);
}
