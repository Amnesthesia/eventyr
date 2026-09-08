// Tinder-style pass over the current list: right saves, left hides.
//
// The deck is derived live from `filtered` minus saved events, so the category
// and vibe filters shown at the top narrow it in place. It is ordered the same
// way the Top Picks row is — score plus how well the event matches what this
// browser saves, shares and calendars — so the cards worth swiping right on
// come first instead of being buried a hundred deep. It re-orders as you go:
// each save feeds the profile, so the deck learns during the session.
//
// Committing a swipe saves or hides the event, which removes it from the deck,
// and the next one is simply the new front. Undo reverses the write and pins
// the undone event to the front until the next swipe — it would otherwise
// reappear at its sorted position, possibly hundreds of cards deep.
import { Bookmark, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { eventId, useEventsContext } from "../context";
import type { Event } from "../types";
import { catShortName, catToSlug } from "../utils/categorySlug";
import { todayIso } from "../utils/dates";
import { dateLabel } from "../utils/grouping";
import { rankByTaste } from "../utils/taste";
import { VIBE_KEYS, VIBE_LABELS } from "../utils/vibes";
import EventCard from "./EventCard";

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
		cityData,
		filtered,
		starred,
		saveEvent,
		unsaveEvent,
		hideEvent,
		unhideEvent,
		isEventPast,
		activeCat,
		setActiveCat,
		vibes,
		toggleVibe,
		taste,
	} = useEventsContext();
	const deck = useMemo(
		() =>
			rankByTaste(
				filtered.filter((e) => !starred.has(eventId(e))),
				taste,
			),
		[filtered, starred, taste],
	);
	// Every category in the city, not the ones left in `filtered`: once one is
	// picked the filtered list holds only that one, and the row must still
	// offer the way back out.
	const categories = useMemo(
		() => [...new Set(cityData.events.map((e) => e.category))].sort(),
		[cityData],
	);
	const [history, setHistory] = useState<{ event: Event; verdict: Verdict }[]>(
		[],
	);
	const [restored, setRestored] = useState<Event | null>(null);
	const [dx, setDx] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [leaving, setLeaving] = useState<Verdict | null>(null);
	const origin = useRef<number | null>(null);
	const moved = useRef(false);

	const current: Event | undefined =
		restored && deck.includes(restored) ? restored : deck[0];

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
			setHistory((h) => [...h, { event: current, verdict }]);
			setRestored(null);
			setDx(0);
			setLeaving(null);
		}, FLY_MS);
	}

	function undo() {
		const last = history[history.length - 1];
		if (!last || leaving) return;
		const id = eventId(last.event);
		if (last.verdict === "save") unsaveEvent(id);
		else unhideEvent(id);
		setHistory((h) => h.slice(0, -1));
		setRestored(last.event);
		setDx(0);
	}

	// The handler closes over fly/undo/onClose, which are new functions on
	// every render, so it lives in a ref and the effect below can run once.
	//
	// Plain div + manual handling here, not the <dialog>/showModal() pattern
	// used by the other two overlays: this component's entire interaction is a
	// hand-rolled pointer drag, and WebKit's top-layer handling for an open
	// <dialog> is known to interfere with custom touch/pointer gestures inside
	// it on iOS — swiping stopped working on mobile the one time this was
	// tried as a <dialog>. The focus-trap/Escape convenience isn't worth that
	// risk for the component where a broken gesture breaks the whole feature.
	const onKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {});
	onKeyDownRef.current = (e: KeyboardEvent) => {
		if (e.key === "Escape") onClose();
		else if (e.key === "ArrowRight") fly("save");
		else if (e.key === "ArrowLeft") fly("skip");
		else if (e.key === "Backspace" || e.key === "z") undo();
	};

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => onKeyDownRef.current(e);
		document.addEventListener("keydown", onKeyDown);
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previous;
		};
	}, []);

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
	const saved = history.filter((h) => h.verdict === "save").length;
	const total = history.length + deck.length;

	return (
		<div
			className="swipe-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label="Swipe through events"
		>
			<div className="swipe-top">
				<span className="swipe-progress">
					{Math.min(history.length + 1, total)} / {total}
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

			{/* Same rule as the header: no "all" pill, deselect by pressing the
			    lit chip, and nothing is coloured until it is chosen. */}
			<div className="swipe-filters">
				<span className="chips">
					{categories.map((cat) => {
						const on = activeCat === cat;
						return (
							<button
								type="button"
								key={cat}
								data-cat={catToSlug(cat)}
								className={`chip${on ? " chip--on" : ""}`}
								onClick={() => setActiveCat(on ? "All" : cat)}
								aria-pressed={on}
							>
								{catShortName(cat)}
							</button>
						);
					})}
				</span>
				<span className="chips">
					{VIBE_KEYS.map((key) => {
						const on = vibes.includes(key);
						return (
							<button
								type="button"
								key={key}
								data-vibe={key}
								className={`chip chip--vibe${on ? " chip--on" : ""}`}
								onClick={() => toggleVibe(key)}
								aria-pressed={on}
							>
								{VIBE_LABELS[key]}
							</button>
						);
					})}
				</span>
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
					disabled={history.length === 0}
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
