import { useEffect, useMemo, useState } from "react";
import EventGrid from "./components/EventGrid";
import Header from "./components/Header";
import { Intro } from "./components/Intro";
import NotificationPrompt from "./components/NotificationPrompt";
import ResultsHeader from "./components/ResultsHeader";
import SavedCalendar from "./components/SavedCalendar";
import SwipeMode from "./components/SwipeMode";
import { eventId, useEventsContext } from "./context";
import { dateWindowFor, groupEvents } from "./utils/grouping";
import { eventsFromIds, parseSavedIds } from "./utils/savedLink";

export default function AppShell() {
	const {
		cityData,
		cityKey,
		starredEvents,
		picks,
		rest,
		groupBy,
		todayStr,
		starred,
		hasActiveFilters,
		clearAllFilters,
		tagPrefs,
	} = useEventsContext();
	const [swiping, setSwiping] = useState(false);
	// null = closed. A non-null value is the set the calendar is showing, which
	// is either this browser's saved events or the ones a shared link named.
	const [calendar, setCalendar] = useState<{
		events: typeof starredEvents;
		shared: boolean;
	} | null>(null);

	// A #cal= link opens straight into the calendar with the sender's events.
	// Read after mount, never during render: the fragment is not part of the
	// static HTML and reading it earlier would mismatch hydration. No new route
	// is needed because this page already ships the whole city's events.
	useEffect(() => {
		const ids = parseSavedIds(window.location.hash);
		if (!ids) return;
		const events = eventsFromIds(ids, cityData.events, cityKey);
		setCalendar({ events, shared: true });
		// Cleared so a reload, or a later "share link", does not reopen someone
		// else's set over the viewer's own.
		history.replaceState(null, "", window.location.pathname);
	}, [cityData.events, cityKey]);

	// Only the long "all events" list is grouped. Saved and picks are already
	// short and already labelled, and splitting a nine-card section further
	// makes the page harder to scan, not easier.
	//
	// today is threaded through from context rather than left to
	// dateWindowFor/groupEvents's own todayIso() default: that default is
	// called once at build time (server) and once at mount (client), which
	// disagree on a site rebuilt weekly and would hydration-mismatch the
	// "Today" heading. todayStr is "" until corrected post-mount (see
	// context.tsx); fall back to week_start meanwhile — a value that's
	// identical server- and client-side, same as weekStart's own fallback in
	// context.tsx — so the pre-mount render matches SSR exactly and the real
	// "today" only ever arrives as a post-hydration update, not a mismatch.
	const today = todayStr || cityData?.week_start || "";

	const groups = useMemo(() => {
		const window = dateWindowFor(
			cityData?.week_start ?? "",
			cityData?.week_end ?? "",
			today,
		);
		return groupEvents(rest, groupBy, window, today, tagPrefs);
	}, [
		rest,
		groupBy,
		cityData?.week_start,
		cityData?.week_end,
		today,
		tagPrefs,
	]);

	return (
		<>
			<Header
				onSwipe={() => setSwiping(true)}
				onOpenCalendar={() =>
					setCalendar({
						events: cityData.events.filter((e) => starred.has(eventId(e))),
						shared: false,
					})
				}
			/>

			<main id="main">
				{cityData && (
					<>
						{cityData && <Intro city={cityData.city} />}
						<ResultsHeader />
						{swiping && <SwipeMode onClose={() => setSwiping(false)} />}
						{starredEvents.length > 0 && (
							<div id="starred-section">
								<div className="section-head">
									<h2 className="section-label">saved</h2>
									<div className="section-head-actions">
										<NotificationPrompt />
									</div>
								</div>
								<EventGrid events={starredEvents} isTopPick={false} />
							</div>
						)}
						{picks.length > 0 && (
							<div id="top-picks-section">
								<h2 className="section-label">picks</h2>
								<p className="section-note">
									Scored 1–10 against a fixed interest profile — see the FAQ
									below for what it weighs.
								</p>
								<EventGrid events={picks} isTopPick={true} />
							</div>
						)}
						{rest.length === 0 &&
						picks.length === 0 &&
						starredEvents.length === 0 ? (
							<div className="state">
								<h2>Nothing matches</h2>
								<p>
									{hasActiveFilters
										? "No events fit the current filters and search."
										: "No events are scheduled for this view."}
								</p>
								{hasActiveFilters && (
									<button
										type="button"
										className="filter-btn"
										onClick={clearAllFilters}
									>
										Clear filters
									</button>
								)}
							</div>
						) : (
							<>
								<h2 className="section-label">all events</h2>
								<div className="separator" />
								{groups.map((group) => (
									<section key={group.key} className="event-group">
										{group.label && (
											<h3 className="group-label" data-cat={group.cat}>
												{group.label}
												<span className="group-count">
													{group.events.length}
												</span>
											</h3>
										)}
										<EventGrid events={group.events} isTopPick={false} />
									</section>
								))}
							</>
						)}
					</>
				)}
			</main>

			{calendar && (
				<SavedCalendar
					events={calendar.events}
					shared={calendar.shared}
					onClose={() => setCalendar(null)}
				/>
			)}
		</>
	);
}
