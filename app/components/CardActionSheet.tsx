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
import { useState } from "react";
import { useEventsContext } from "../context";
import { useModalDialog } from "../hooks/useModalDialog";
import type { Event } from "../types";
import { calendarLinks } from "../utils/calendarLinks";
import { downloadEventIcs } from "../utils/ics";
import { shareEvent } from "../utils/share";
import { noteInterest } from "../utils/taste";

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
	const { ref, close } = useModalDialog(onClose);
	// Every calendar route, not just the download: this sheet is the
	// discoverable place to pick one when the button's platform guess is wrong.
	// No date means no calendar entry at all, and calendarLinks drops the rows
	// it cannot build — the download row is the only unconditional one, so a
	// list of exactly that means there is nothing real to offer.
	const calendars = calendarLinks(event, cityKey, cityData.timezone);
	const canAddToCalendar = calendars.some((link) => link.href !== null);

	async function handleShare() {
		const outcome = await shareEvent(event, cityKey);
		noteInterest(event, cityKey, "share");
		if (outcome === "copied") {
			// Held open briefly so the "Link copied" state is actually seen.
			setCopied(true);
			setTimeout(close, 900);
			return;
		}
		if (outcome !== "cancelled") close();
	}

	return (
		<dialog ref={ref} className="sheet-backdrop" aria-label={event.title}>
			{/* A real button rather than a click handler on the backdrop div: it is
			    focusable and it announces itself. Escape closes the sheet too, via
			    the dialog's own handling. */}
			<button
				type="button"
				className="sheet-scrim"
				aria-label="Close menu"
				onClick={close}
			/>
			<div className="sheet">
				<p className="sheet-title">{event.title}</p>
				<button
					type="button"
					className="sheet-action"
					onClick={() => {
						onStarClick();
						close();
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
								onClick={() => {
									noteInterest(event, cityKey, "calendar");
									close();
								}}
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
									noteInterest(event, cityKey, "calendar");
									close();
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
					onClick={close}
				>
					Cancel
				</button>
			</div>
		</dialog>
	);
}
