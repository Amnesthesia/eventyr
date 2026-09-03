// Share one event.
//
// Rendered as an anchor to the event's own page, then progressively enhanced.
// That ordering is the point: with no JavaScript, a middle-click, or a
// right-click "copy link", it behaves like the link it is. With JavaScript it
// opens the native share sheet, and where that does not exist it copies the
// URL.
import { Check, Share2 } from "lucide-react";
import { useState } from "react";
import { eventPath, SITE_URL } from "../../src/shared";
import type { Event } from "../types";

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

export default function ShareButton({
	event,
	cityKey,
	label,
	className,
	iconSize,
}: Props) {
	const [copied, setCopied] = useState(false);
	const path = eventPath(cityKey, event);
	// Absolute, and from SITE_URL rather than window.location: a link copied
	// while running the dev server has to be shareable, not a localhost URL.
	const url = `${SITE_URL}${path}`;

	async function handleShare(e: React.MouseEvent<HTMLAnchorElement>) {
		// Let the browser handle the ways a user asks for a new tab, so the
		// anchor keeps behaving like an anchor.
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		try {
			if (navigator.share) {
				await navigator.share({ title: event.title, text: event.title, url });
				return;
			}
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			// Dismissing the share sheet rejects with AbortError. That is a user
			// deciding not to share, not a failure, and must not look like one.
			if ((err as Error)?.name === "AbortError") return;
			// Clipboard denied or unavailable: fall back to the anchor's own
			// behaviour so the user still gets to the page and can copy the URL.
			window.location.href = path;
		}
	}

	return (
		<a
			className={className ?? (label ? "filter-btn" : "icon-btn")}
			href={path}
			onClick={handleShare}
			aria-label={`Share ${event.title}`}
			title="Share this event"
		>
			{copied ? (
				<Check size={iconSize ?? (label ? 12 : 11)} strokeWidth={2.2} />
			) : (
				<Share2 size={iconSize ?? (label ? 12 : 11)} strokeWidth={2.2} />
			)}
			{label && <span>{copied ? "Copied" : label}</span>}
		</a>
	);
}
