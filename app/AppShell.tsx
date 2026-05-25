import EventGrid from "./components/EventGrid";
import FilterBar from "./components/FilterBar";
import Header from "./components/Header";
import { Intro } from "./components/Intro";
import { useEventsContext } from "./context";

export default function AppShell() {
	const { cityData, starredEvents, picks, rest } = useEventsContext();

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
						<EventGrid events={rest} isTopPick={false} />
					</>
				)}
			</main>
		</>
	);
}
