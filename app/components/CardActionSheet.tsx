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
import type { Event } from "../types";
import { buildEventIcs, downloadEventIcs } from "../utils/ics";
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
	const [copied, setCopied] = useState(false);
	// No date means no calendar entry, so that row is not offered rather than
	// offered and broken.
	const canAddToCalendar = buildEventIcs(event, cityKey) !== null;

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
				{canAddToCalendar && (
					<button
						type="button"
						className="sheet-action"
						onClick={() => {
							downloadEventIcs(event, cityKey);
							onClose();
						}}
					>
						<CalendarPlus size={16} />
						Add to calendar
					</button>
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
