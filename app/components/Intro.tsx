import { useEffect } from "react";

/** Matches the key the blocking script in Base.astro's head reads. */
const STORAGE_KEY = "hideCityIntro";
/** Long enough to read, short enough not to be a barrier for someone who just
 * wants the events. */
const AUTO_HIDE_MS = 10000;

/**
 * Hidden by a CSS class, not by React state.
 *
 * The previous version held a `visible` state and returned null once
 * localStorage said to hide it — but that check ran in an effect, after
 * hydration, so a returning visitor watched the intro render and then
 * disappear. A blocking script in Base.astro's head now adds
 * `.intro-hidden` to <html> before the body paints, and CSS does the rest.
 * The storage mechanism was never the problem: a cookie is read from JS at
 * exactly the same late moment, so switching to one would not have helped.
 *
 * Note that the element remains in the HTML when hidden, which is what keeps
 * this text visible to crawlers after a reader has dismissed it. That is
 * cloaking in Google's terms — text served to their crawler that a returning
 * user does not see — and it is a documented spam-policy risk to the ranking
 * it is meant to help. Rendering it collapsed for everyone, with the full text
 * in the DOM, would read the same to a crawler without the risk.
 */
function hide() {
	try {
		localStorage.setItem(STORAGE_KEY, "true");
	} catch {
		// Private mode or storage disabled: hiding for this view is still fine,
		// it just will not be remembered.
	}
	document.documentElement.classList.add("intro-hidden");
}

export function Intro({ city }: { city: string }) {
	useEffect(() => {
		const timeout = setTimeout(hide, AUTO_HIDE_MS);
		return () => clearTimeout(timeout);
	}, []);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: dismissable decoration, not a control — the text stays reachable in the DOM
		<article
			className="container city-intro"
			onClick={hide}
			title="click to hide"
		>
			Looking for genuinely interesting things to do in <strong>{city}</strong>?{" "}
			dothings.lol is a curated event discovery platform that aggregates events
			from dozens of local sources and uses multiple AI models to filter and
			rank them — highlighting workshops, meetups, live music, community events,
			art classes, outdoor activities, talks, markets, and unique experiences
			worth leaving the house for, without the clutter or spam found on most
			event websites. Whether you're searching for things to do in{" "}
			<a href="/brisbane/">Brisbane</a> this weekend, creative events on the{" "}
			<a href="/gold-coast/">Gold Coast</a>, or social activities on the{" "}
			<a href="/sunshine-coast/">Sunshine Coast</a>, dothings.lol helps you
			discover high-signal local events in one clean, minimal interface without
			ads.
		</article>
	);
}
