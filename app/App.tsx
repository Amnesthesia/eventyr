import { useEffect, useState } from "react";
import EventGrid from "./components/EventGrid";
import FilterBar from "./components/FilterBar";
import Header from "./components/Header";
import { EventsProvider, useEventsContext } from "./context";

function CityIntro({ city }: { city: string }) {
	const [hidden, setHidden] = useState(false);
	useEffect(() => {
		if (localStorage.getItem("hideCityIntro") === "true") {
			setHidden(true);
		}
	}, []);

	useEffect(() => {
		localStorage.setItem("hideCityIntro", hidden ? "true" : "false");
	}, [hidden]);

	if (hidden) return null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: this is a non-interactive element that can be dismissed with a click, not a button or link
		<article
			className="city-intro"
			onClick={() => setHidden(true)}
			title="click to hide"
		>
			Looking for genuinely interesting things to do in <strong>{city}</strong>?{" "}
			dothings.lol is a curated event discovery platform that aggregates events
			from dozens of local sources and uses multiple AI models to filter and
			rank them — highlighting workshops, meetups, live music, community events,
			art classes, outdoor activities, talks, markets, and unique experiences
			worth leaving the house for, without the clutter or spam found on most
			event websites. Whether you're searching for things to do in Brisbane this
			weekend, creative events on the Gold Coast, or social activities on the
			Sunshine Coast, dothings.lol helps you discover high-signal local events
			in one clean, minimal interface without ads.
		</article>
	);
}

function AppShell() {
	const { loading, error, cityData, starredEvents, picks, rest } =
		useEventsContext();

	return (
		<>
			{cityData && <CityIntro city={cityData.city} />}
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
