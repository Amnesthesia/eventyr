import EventGrid from "./components/EventGrid";
import FilterBar from "./components/FilterBar";
import Header from "./components/Header";
import { EventsProvider, useEventsContext } from "./context";

function AppShell() {
	const { loading, error, cityData, starredEvents, picks, rest } = useEventsContext();

	return (
		<>
			<Header />
			<main>
				{loading && (
					<div className="state">
						<h2>loading…</h2>
					</div>
				)}
				{error && (
					<div className="state">
						<h2>{error}</h2>
						<p>check back after the next monday run</p>
					</div>
				)}
				{!loading && !error && cityData && (
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

export default function App() {
	return (
		<EventsProvider>
			<AppShell />
		</EventsProvider>
	);
}
