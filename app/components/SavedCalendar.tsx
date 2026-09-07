// A week view of the saved events, and the ways to get them off this device.
//
// The grid answers a question the card list cannot: whether the things you
// saved actually fit into a week, or whether three of them are at 7pm on the
// same Thursday.
//
// The QR code is the point of the modal, though. A saved set lives in this
// browser's localStorage and nowhere else, so without a link there is no route
// from a laptop to a phone — or from one person to another — that does not
// involve emailing yourself a file.
import {
	BookmarkPlus,
	CalendarPlus,
	Check,
	ChevronLeft,
	ChevronRight,
	QrCode,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { eventPath } from "../../src/shared.ts";
import { eventId, useEventsContext } from "../context";
import { useModalDialog } from "../hooks/useModalDialog";
import type { Event } from "../types";
import { catToSlug } from "../utils/categorySlug";
import { addDays, shortDate, startOfWeek } from "../utils/dates";
import { buildIcs, downloadIcs } from "../utils/ics";
import { QR_EVENT_LIMIT, savedCalendarUrl } from "../utils/savedLink";
import { shareUrl } from "../utils/share";
import { offsetPercent, weekLayout } from "../utils/weekLayout";
import SavedCalendarQr from "./SavedCalendarQr";

interface Props {
	events: Event[];
	/** Set when the modal was opened from a shared link rather than from this
	 * browser's own saved list — the events are someone else's until kept. */
	shared?: boolean;
	onClose: () => void;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** HH:MM from minutes past midnight. */
function clock(minutes: number): string {
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
		minutes % 60,
	).padStart(2, "0")}`;
}

export default function SavedCalendar({ events, shared, onClose }: Props) {
	const { cityData, cityKey, starred, saveEvent, todayStr } =
		useEventsContext();

	// Always this week. Deriving it from the saved events instead was tried
	// twice and was wrong both times: the earliest start belongs to a long run
	// that opened years ago, and "the first week holding something" followed a
	// single February opening back to February. The arrows are right there, and
	// "this week" is the one answer that never surprises.
	const [weekStart, setWeekStart] = useState(() =>
		startOfWeek(todayStr || cityData.week_start),
	);
	const [copied, setCopied] = useState(false);
	// The QR panel starts open, which is what a desktop sidebar wants. On a
	// phone the sidebar becomes a strip under the grid, where a code plus its
	// caption costs a third of the visible height — and the grid is what the
	// modal is on screen for — so it starts collapsed there instead.
	const [qrOpen, setQrOpen] = useState(true);

	useEffect(() => {
		setQrOpen(!window.matchMedia("(max-width: 820px)").matches);
	}, []);

	const { ref, close } = useModalDialog(onClose);

	const { lanes, allDayBars, allDayLanes, firstHour, lastHour } = useMemo(
		() => weekLayout(events, weekStart),
		[events, weekStart],
	);
	const hours = Array.from(
		{ length: lastHour - firstHour },
		(_, i) => firstHour + i,
	);

	const url = savedCalendarUrl(events, cityKey);
	const unsaved = shared ? events.filter((e) => !starred.has(eventId(e))) : [];

	function exportIcs() {
		const ics = buildIcs(events, cityKey, {
			timezone: cityData.timezone,
			name: `Saved: do things in ${cityData.city.split(",")[0]}`,
		});
		if (ics) downloadIcs(ics, `saved-${cityKey}.ics`);
	}

	async function share() {
		if ((await shareUrl(url, "My saved events")) === "copied") {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}

	return (
		<dialog
			ref={ref}
			className="sheet-backdrop cal-modal-backdrop"
			aria-label="Saved events calendar"
		>
			<button
				type="button"
				className="sheet-scrim"
				aria-label="Close calendar"
				onClick={close}
			/>
			<div className="cal-modal">
				<div className="cal-modal-head">
					<div className="cal-week-nav">
						<button
							type="button"
							className="icon-btn"
							onClick={() => setWeekStart(addDays(weekStart, -7))}
							aria-label="Previous week"
						>
							<ChevronLeft size={16} />
						</button>
						<strong>
							{shortDate(weekStart)} – {shortDate(addDays(weekStart, 6))}
						</strong>
						<button
							type="button"
							className="icon-btn"
							onClick={() => setWeekStart(addDays(weekStart, 7))}
							aria-label="Next week"
						>
							<ChevronRight size={16} />
						</button>
					</div>
					<button
						type="button"
						className="icon-btn"
						onClick={close}
						aria-label="Close"
					>
						<X size={18} />
					</button>
				</div>

				<div className="cal-body">
					<div className="cal-grid-scroll">
						{/* Three stacked grids sharing one column template, rather than
						    one grid with explicit row spans: the all-day strip needs a
						    variable number of rows for its bars, and mixing that with the
						    header and hour rows in a single auto-placed grid put the day
						    names down the left-hand side. */}
						<div className="cal-grid">
							<div className="cal-row cal-row--head">
								<div className="cal-gutter" />
								{lanes.map((lane, index) => (
									<div key={lane.day} className="cal-day-head">
										<span>{DAY_NAMES[index]}</span>
										<small>{lane.day.slice(8)}</small>
									</div>
								))}
							</div>

							<div
								className="cal-row cal-row--allday"
								style={
									{ "--cal-allday-rows": allDayLanes } as React.CSSProperties
								}
							>
								<div className="cal-gutter cal-allday-label">all day</div>
								{/* Empty cells draw the column rules; the bars sit over them,
								    one per run rather than the same chip repeated in seven
								    cells — three long exhibitions filled the whole strip. */}
								{lanes.map((lane) => (
									<div key={lane.day} className="cal-allday" />
								))}
								{allDayBars.map((bar) => (
									<a
										key={eventId(bar.event)}
										className="cal-chip cal-chip--allday"
										data-cat={catToSlug(bar.event.category)}
										href={eventPath(cityKey, bar.event)}
										title={`${bar.event.title} — ${bar.event.datetime}`}
										style={{
											gridColumn: `${bar.startCol} / ${bar.endCol}`,
											gridRow: bar.lane,
										}}
									>
										{bar.event.title}
									</a>
								))}
							</div>

							<div
								className="cal-row cal-row--time"
								style={{ "--cal-rows": hours.length } as React.CSSProperties}
							>
								<div className="cal-gutter cal-hours">
									{hours.map((hour) => (
										<span key={hour}>{String(hour).padStart(2, "0")}:00</span>
									))}
								</div>
								{lanes.map((lane) => (
									<div key={lane.day} className="cal-lane">
										{lane.timed.map(({ event, minutes }) => (
											<a
												key={eventId(event)}
												className="cal-chip cal-chip--timed"
												data-cat={catToSlug(event.category)}
												href={eventPath(cityKey, event)}
												style={{
													top: `${offsetPercent(minutes, firstHour, lastHour)}%`,
												}}
												title={`${event.title} — ${event.datetime}`}
											>
												<time>{clock(minutes)}</time>
												<span className="cal-chip-title">{event.title}</span>
											</a>
										))}
									</div>
								))}
							</div>
						</div>
					</div>

					<aside className="cal-side">
						{/* Only rendered where the panel collapses; the sidebar shows the
						    code outright. */}
						<button
							type="button"
							className="filter-btn cal-qr-toggle"
							onClick={() => setQrOpen((open) => !open)}
							aria-expanded={qrOpen}
						>
							<QrCode size={12} strokeWidth={2.2} />
							<span>{qrOpen ? "Hide QR code" : "Show QR code"}</span>
						</button>
						{qrOpen && (
							<div className="cal-qr">
								{events.length === 0 ? (
									<p className="cal-note">Nothing saved yet.</p>
								) : events.length > QR_EVENT_LIMIT ? (
									// Past this many, the code needs more modules than a phone
									// camera reliably resolves off a screen. The link still
									// works, so offer that and the file instead of an
									// unscannable square.
									<p className="cal-note">
										{events.length} saved — too many for a QR code. Copy the
										link or export the calendar instead.
									</p>
								) : (
									<>
										<SavedCalendarQr url={url} />
										<p className="cal-note">
											Scan to open these {events.length} events on your phone.
										</p>
									</>
								)}
							</div>
						)}
						<div className="cal-modal-actions">
							{/* Only on a shared link, and only while something is still
							    unsaved — the primary action for someone who arrived on
							    someone else's QR code and has none of it bookmarked. It
							    disappears once every event is saved, which is also the
							    confirmation that it worked. */}
							{shared && unsaved.length > 0 && (
								<button
									type="button"
									className="filter-btn cal-save-all"
									onClick={() => {
										for (const event of unsaved) saveEvent(eventId(event));
									}}
									title="Bookmark every event on this calendar"
								>
									<BookmarkPlus size={12} strokeWidth={2.2} />
									Save all ({unsaved.length})
								</button>
							)}
							<button
								type="button"
								className="filter-btn"
								onClick={share}
								disabled={events.length === 0}
							>
								{copied ? <Check size={12} /> : null}
								{copied ? "Link copied" : "Share link"}
							</button>
							<button
								type="button"
								className="filter-btn"
								onClick={exportIcs}
								disabled={events.length === 0}
							>
								<CalendarPlus size={12} strokeWidth={2.2} />
								Export to calendar
							</button>
						</div>
					</aside>
				</div>
			</div>
		</dialog>
	);
}
