import { useMemo } from "react";
import EventGrid from "./components/EventGrid";
import FilterBar from "./components/FilterBar";
import Header from "./components/Header";
import { Intro } from "./components/Intro";
import { useEventsContext } from "./context";
import { dateWindowFor, groupEvents } from "./utils/grouping";

export default function AppShell() {
	const { cityData, starredEvents, picks, rest, groupBy } = useEventsContext();

	// Only the long "all events" list is grouped. Saved and picks are already
	// short and already labelled, and splitting a nine-card section further
	// makes the page harder to scan, not easier.
	const groups = useMemo(() => {
		const window = dateWindowFor(
			cityData?.week_start ?? "",
			cityData?.week_end ?? "",
		);
		return groupEvents(rest, groupBy, window);
	}, [rest, groupBy, cityData?.week_start, cityData?.week_end]);

	return (
		<>
			<Header />

			<main>
				{cityData && (
					<>
						{cityData && <Intro city={cityData.city} />}
						<FilterBar />
						{starredEvents.length > 0 && (
							<div id="starred-section">
								<h2 className="section-label">saved</h2>
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
