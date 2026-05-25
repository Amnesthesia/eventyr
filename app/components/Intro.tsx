import { useEffect, useState } from "react";

export function Intro({ city }: { city: string }) {
	const [visible, setVisible] = useState(true);
	useEffect(() => {
		if (localStorage.getItem("hideCityIntro") === "true") {
			setVisible(false);
		}
	}, []);

	// Auto-hide the intro after 10 seconds, since it's not critical information and can be a bit of a barrier for users who just want to see the events
	useEffect(() => {
		const timeout = setTimeout(() => {
			localStorage.setItem("hideCityIntro", "true");
			setVisible(false);
		}, 10000);
		return () => clearTimeout(timeout);
	}, []);

	if (!visible) return null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: this is a non-interactive element that can be dismissed with a click, not a button or link
		<article
			className="container city-intro"
			onClick={() => {
				localStorage.setItem("hideCityIntro", "true");
				setVisible(false);
			}}
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
