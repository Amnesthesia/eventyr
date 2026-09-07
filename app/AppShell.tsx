import { useMemo, useState } from "react";
import EventGrid from "./components/EventGrid";
import ExportSaved from "./components/ExportSaved";
import FilterBar from "./components/FilterBar";
import Header from "./components/Header";
import { Intro } from "./components/Intro";
import SwipeMode from "./components/SwipeMode";
import { useEventsContext } from "./context";
import { dateWindowFor, groupEvents } from "./utils/grouping";

export default function AppShell() {
	const { cityData, starredEvents, picks, rest, groupBy, todayStr } =
		useEventsContext();
	const [swiping, setSwiping] = useState(false);

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
		return groupEvents(rest, groupBy, window, today);
	}, [rest, groupBy, cityData?.week_start, cityData?.week_end, today]);

	return (
		<>
			<Header />

			<main>
				{cityData && (
					<>
						{cityData && <Intro city={cityData.city} />}
						<FilterBar onSwipe={() => setSwiping(true)} />
						{swiping && <SwipeMode onClose={() => setSwiping(false)} />}
						{starredEvents.length > 0 && (
							<div id="starred-section">
								<div className="section-head">
									<h2 className="section-label">saved</h2>
									<ExportSaved />
								</div>
								<EventGrid events={starredEvents} isTopPick={false} />
							</div>
						)}
						{picks.length > 0 && (
							<div id="top-picks-section">
								<h2 className="section-label">picks</h2>
								<EventGrid events={picks} isTopPick={true} />
							</div>
						)}
						<h2 className="section-label">all events</h2>
						<div className="separator" />
						{groups.map((group) => (
							<section key={group.key} className="event-group">
								{group.label && (
									<h3 className="group-label" data-cat={group.cat}>
										{group.label}
										<span className="group-count">{group.events.length}</span>
									</h3>
								)}
								<EventGrid events={group.events} isTopPick={false} />
							</section>
						))}
					</>
				)}
			</main>
		</>
	);
}
