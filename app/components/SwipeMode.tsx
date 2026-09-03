// Tinder-style pass over the current list: right saves, left hides.
//
// The deck is a snapshot taken when the mode opens. Committing a swipe changes
// the saved/hidden sets, which changes `filtered`, and a deck that re-derived
// from it would reshuffle under the finger. Undo is the same snapshot walked
// backwards, reversing whatever the swipe did.
import { Bookmark, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { eventId, useEventsContext } from "../context";
import type { Event } from "../types";
import { todayIso } from "../utils/dates";
import { dateLabel } from "../utils/grouping";
import EventCard from "./EventCard";
import ExportSaved from "./ExportSaved";

/** Drag past this many pixels and letting go commits the swipe. */
const COMMIT_PX = 90;
/** A pointer that moves less than this is a tap on the card, not a drag. */
const TAP_PX = 8;
/** Matches the CSS transition on .swipe-card. */
const FLY_MS = 200;

type Verdict = "save" | "skip";

interface Props {
	onClose: () => void;
}

export default function SwipeMode({ onClose }: Props) {
	const {
		filtered,
		starred,
		saveEvent,
		unsaveEvent,
		hideEvent,
		unhideEvent,
		isEventPast,
	} = useEventsContext();
	const [deck] = useState<Event[]>(() =>
		filtered.filter((e) => !starred.has(eventId(e))),
	);
	const [index, setIndex] = useState(0);
	// history[i] is the verdict given to deck[i]; its length is always index.
	const [history, setHistory] = useState<Verdict[]>([]);
	const [dx, setDx] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [leaving, setLeaving] = useState<Verdict | null>(null);
	const origin = useRef<number | null>(null);
	const moved = useRef(false);

	const current: Event | undefined = deck[index];

	// Whether it is on tonight or next month usually decides the swipe, and
	// the card's own date line is small and mid-card. So the day gets a banner
	// of its own, fixed above the card so it does not tilt with the drag.
	const when = (() => {
		if (!current) return "";
		const today = todayIso();
		const start = (current.datetime_iso || "").slice(0, 10);
		const end = (current.datetime_end_iso || "").slice(0, 10);
		if (!start) return "Date unknown";
		if (start < today && end >= today)
			return `Ongoing, until ${dateLabel(end, today)}`;
		return dateLabel(start, today);
	})();

	function fly(verdict: Verdict) {
		if (!current || leaving) return;
		setLeaving(verdict);
		setTimeout(() => {
			const id = eventId(current);
			if (verdict === "save") saveEvent(id);
			else hideEvent(id);
			setHistory((h) => [...h, verdict]);
			setIndex((i) => i + 1);
			setDx(0);
			setLeaving(null);
		}, FLY_MS);
	}

	function undo() {
		if (index === 0 || leaving) return;
		const verdict = history[index - 1];
		const id = eventId(deck[index - 1]);
		if (verdict === "save") unsaveEvent(id);
		else unhideEvent(id);
		setHistory((h) => h.slice(0, -1));
		setIndex((i) => i - 1);
		setDx(0);
	}

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
			else if (e.key === "ArrowRight") fly("save");
			else if (e.key === "ArrowLeft") fly("skip");
			else if (e.key === "Backspace" || e.key === "z") undo();
		}
		document.addEventListener("keydown", onKeyDown);
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previous;
		};
	});

	function onPointerDown(e: React.PointerEvent) {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		origin.current = e.clientX;
		moved.current = false;
		setDragging(true);
	}
	function onPointerMove(e: React.PointerEvent) {
		if (origin.current === null) return;
		const next = e.clientX - origin.current;
		if (Math.abs(next) > TAP_PX) moved.current = true;
		setDx(next);
	}
	function onPointerUp() {
		if (origin.current === null) return;
		origin.current = null;
		setDragging(false);
		if (Math.abs(dx) >= COMMIT_PX) fly(dx > 0 ? "save" : "skip");
		else setDx(0);
	}

	const tx = leaving
		? (leaving === "save" ? 1 : -1) * window.innerWidth * 1.2
		: dx;
	const saved = history.filter((v) => v === "save").length;

	return (
		<div
			className="swipe-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label="Swipe through events"
		>
			<div className="swipe-top">
				<span className="swipe-progress">
					{Math.min(index + 1, deck.length)} / {deck.length}
				</span>
				<span className="swipe-hint">swipe right to save, left to skip</span>
				<button
					type="button"
					className="theme-btn"
					onClick={onClose}
					aria-label="Close swipe mode"
				>
					<X size={12} strokeWidth={2} />
				</button>
			</div>

			{when && (
				<p className="swipe-date" aria-live="polite">
					{when}
				</p>
			)}

			{/* Pointer handlers live on the whole stage so a drag that leaves the
			    card keeps tracking. A click after a drag is swallowed in the
			    capture phase, or letting go over a tag button would toggle it. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag surface; the buttons below are the keyboard path */}
			<div
				className="swipe-stage"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onClickCapture={(e) => {
					if (moved.current) {
						e.preventDefault();
						e.stopPropagation();
					}
				}}
				onDragStart={(e) => e.preventDefault()}
			>
				{current ? (
					<div
						key={eventId(current)}
						className="swipe-card"
						style={{
							transform: `translateX(${tx}px) rotate(${tx / 20}deg)`,
							transition: dragging ? "none" : undefined,
						}}
					>
						<span
							className="swipe-stamp swipe-stamp--save"
							style={{ opacity: Math.min(1, Math.max(0, tx / COMMIT_PX)) }}
						>
							Save
						</span>
						<span
							className="swipe-stamp swipe-stamp--skip"
							style={{ opacity: Math.min(1, Math.max(0, -tx / COMMIT_PX)) }}
						>
							Skip
						</span>
						<EventCard
							event={current}
							isTopPick={false}
							isPast={isEventPast(current)}
							isStarred={false}
							onStarClick={() => fly("save")}
						/>
					</div>
				) : (
					<div className="swipe-done">
						<p>That's everything.</p>
						<p>
							{saved} saved · {history.length - saved} skipped
						</p>
						<ExportSaved />
						<button type="button" className="filter-btn" onClick={onClose}>
							Back to the list
						</button>
					</div>
				)}
			</div>

			<div className="swipe-actions">
				<button
					type="button"
					onClick={() => fly("skip")}
					disabled={!current}
					aria-label="Skip this event"
				>
					<X size={20} strokeWidth={2} />
				</button>
				<button
					type="button"
					onClick={undo}
					disabled={index === 0}
					aria-label="Undo last swipe"
				>
					<RotateCcw size={16} strokeWidth={2} />
				</button>
				<button
					type="button"
					onClick={() => fly("save")}
					disabled={!current}
					aria-label="Save this event"
				>
					<Bookmark size={20} strokeWidth={2} />
				</button>
			</div>
		</div>
	);
}
