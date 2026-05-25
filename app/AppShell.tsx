import { useEffect, useState } from "react";
import EventGrid from "./components/EventGrid";
import FilterBar from "./components/FilterBar";
import Header from "./components/Header";
import { useEventsContext } from "./context";

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
		// biome-ignore lint/a11y/useKeyWithClickEvents: dismissible info block, not a focusable control
		<article
			className="city-intro"
			onClick={() => setHidden(true)}
			title="click to hide"
		>
			Looking for genuinely interesting things to do in <strong>{city}</strong>?{" "}
			dothings.lol is a curated event discovery platform that aggregates events
			from dozens of local sources and uses multiple AI models to filter and rank
			them — highlighting workshops, meetups, live music, community events, art
			classes, outdoor activities, talks, markets, and unique experiences worth
			leaving the house for, without the clutter or spam found on most event
			websites. Whether you're searching for things to do in Brisbane this
			weekend, creative events on the Gold Coast, or social activities on the
			Sunshine Coast, dothings.lol helps you discover high-signal local events in
			one clean, minimal interface without ads.
		</article>
	);
}

export default function AppShell() {
	const { cityData, starredEvents, picks, rest } = useEventsContext();

	return (
		<>
			{cityData && <CityIntro city={cityData.city} />}
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
