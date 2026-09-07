// Hands one event to the viewer's calendar.
//
// A click no longer downloads a file. There is no web API for "add this to my
// calendar", so the route is guessed from the platform: Apple devices open a
// real .ics URL, which Safari passes straight to Calendar with no download
// step, and everyone else gets a prefilled Google Calendar template. Both are
// URLs — nothing lands in Downloads unless the viewer asks for it.
//
// The guess is sometimes wrong (a Windows user living in Apple Calendar), so
// the full list is one gesture away: right-click here, or long-press the card,
// which opens CardActionSheet with the same four rows.
import { CalendarPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEventsContext } from "../context";
import type { Event } from "../types";
import { calendarLinks } from "../utils/calendarLinks";
import { downloadEventIcs } from "../utils/ics";
import { type CalendarTarget, calendarTarget } from "../utils/platform";
import { noteInterest } from "../utils/taste";

interface Props {
	event: Event;
	cityKey: string;
	/** Shown next to the icon. Omit for the icon-only version used on cards. */
	label?: string;
	/** Overrides the default styling, so a card can render this small and
	 * inline where the event page renders it as a button. */
	className?: string;
	iconSize?: number;
}

export default function AddToCalendar({
	event,
	cityKey,
	label,
	className,
	iconSize,
}: Props) {
	const { cityData } = useEventsContext();
	const links = calendarLinks(event, cityKey, cityData.timezone);
	// "google" until the browser has told us otherwise. Read in an effect
	// rather than during render because this component is in the static HTML
	// too, and a platform-dependent first render would not match it.
	const [target, setTarget] = useState<CalendarTarget>("google");
	const [menuOpen, setMenuOpen] = useState(false);
	const root = useRef<HTMLSpanElement>(null);

	useEffect(() => setTarget(calendarTarget()), []);

	useEffect(() => {
		if (!menuOpen) return;
		// A pointer inside the menu is a selection, not a dismissal; the rows
		// close it themselves once used.
		const onPointerDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setMenuOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen]);

	// An event with no parsable date cannot be a calendar entry, so there is
	// nothing to offer rather than a button that opens a broken link. The
	// download row is always present, so a list of one means no real route.
	const primary = links.find((l) => l.key === target);
	if (!primary?.href) return null;

	return (
		<span className="cal-wrap" ref={root}>
			<a
				className={className ?? (label ? "filter-btn" : "icon-btn")}
				href={primary.href}
				// Apple's .ics is same-origin and must be handed to the OS, not
				// opened in a tab; the web templates are another site.
				target={target === "apple" ? undefined : "_blank"}
				rel="noopener"
				aria-label={`Add ${event.title} to ${primary.label}`}
				title={`Add to ${primary.label} — right-click for other calendars`}
				onClick={() => noteInterest(event, cityKey, "calendar")}
				onContextMenu={(e) => {
					e.preventDefault();
					setMenuOpen(true);
				}}
			>
				<CalendarPlus size={iconSize ?? (label ? 12 : 11)} strokeWidth={2.2} />
				{label && <span>{label}</span>}
			</a>
			{menuOpen && (
				<span className="cal-menu" role="menu">
					{links.map((link) =>
						link.href ? (
							<a
								key={link.key}
								role="menuitem"
								href={link.href}
								target={link.key === "apple" ? undefined : "_blank"}
								rel="noopener"
								onClick={() => {
									noteInterest(event, cityKey, "calendar");
									setMenuOpen(false);
								}}
							>
								{link.label}
							</a>
						) : (
							<button
								key={link.key}
								type="button"
								role="menuitem"
								onClick={() => {
									downloadEventIcs(event, cityKey);
									noteInterest(event, cityKey, "calendar");
									setMenuOpen(false);
								}}
							>
								{link.label}
							</button>
						),
					)}
				</span>
			)}
		</span>
	);
}
