import EventGrid from "./components/EventGrid";
import FilterBar from "./components/FilterBar";
import Header from "./components/Header";
import { Intro } from "./components/Intro";
import { useEventsContext } from "./context";

export default function AppShell() {
	const { cityData, starredEvents, picks, rest } = useEventsContext();

	return (
		<>
			{cityData && <Intro city={cityData.city} />}
			<Header />
			<main>
				{cityData && (
					<>
						<FilterBar />
						{starredEvents.length > 0 && (
							<div id="starred-section">
								<div className="section-label">saved</div>
								<EventGrid events={starredEvents} isTopPick={false} />
							</div>
						)}
						{picks.length > 0 && (
							<div id="top-picks-section">
								<div className="section-label">picks</div>
								<EventGrid events={picks} isTopPick={true} />
							</div>
						)}
						<div className="section-label">all events</div>
						<div className="separator" />
						<EventGrid events={rest} isTopPick={false} />
					</>
				)}
			</main>
		</>
	);
}
