import { useEffect, useState } from "react";
import { TOP_PICK_THRESHOLD } from "../constants";
import type { CityData, Event } from "../types";
import { KEY_TO_SLUG } from "../utils/citySlug";
import { cacheBust } from "../utils/dates";

const BASE_URL = "https://www.dothings.lol";
const SCHEMA_ID = "dothings-event-schema";

function setMeta(selector: string, content: string) {
	const el = document.querySelector(selector);
	if (el) el.setAttribute("content", content);
}

function injectEventSchema(events: Event[], cityName: string) {
	document.getElementById(SCHEMA_ID)?.remove();
	const schema = {
		"@context": "https://schema.org",
		"@type": "ItemList",
		name: `Events in ${cityName} this week`,
		itemListElement: events.slice(0, 20).map((event, index) => ({
			"@type": "ListItem",
			position: index + 1,
			item: {
				"@type": "Event",
				name: event.title,
				description: event.description,
				startDate: event.datetime_iso,
				endDate: event.datetime_end_iso || undefined,
				location: { "@type": "Place", name: event.location },
				url: event.link || undefined,
				eventStatus: "https://schema.org/EventScheduled",
				organizer: { "@type": "Organization", name: event.source },
				offers: event.cost
					? { "@type": "Offer", description: event.cost }
					: undefined,
			},
		})),
	};
	const script = document.createElement("script");
	script.id = SCHEMA_ID;
	script.type = "application/ld+json";
	script.text = JSON.stringify(schema);
	document.head.appendChild(script);
}

export function useEvents(cityKey: string) {
	const [cityData, setCityData] = useState<CityData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!cityKey) return;
		setLoading(true);
		setError(null);
		setCityData(null);

		fetch(`data/${cityKey}.json?v=${cacheBust()}`)
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
			)
			.then((data: CityData) => {
				data.events.sort((a, b) => (b.score || 0) - (a.score || 0));
				setCityData(data);

				const cityUrl = `${BASE_URL}/${KEY_TO_SLUG[data.city_key] ?? data.city_key}`;
				const desc = `This week in ${data.city} (${data.week_start} to ${data.week_end}): ${data.events.length} curated events — talks, workshops, live music, art, and more. AI-curated using Claude, Gemini, Perplexity and ChatGPT.`;
				const ogTitle = `${data.city} — do things`;

				document.title = ogTitle;
				setMeta('meta[name="description"]', desc);
				setMeta('meta[property="og:title"]', ogTitle);
				setMeta('meta[property="og:description"]', desc);
				setMeta('meta[property="og:url"]', cityUrl);
				setMeta('meta[name="twitter:title"]', ogTitle);
				setMeta('meta[name="twitter:description"]', desc);
				const canonical = document.querySelector('link[rel="canonical"]');
				if (canonical) canonical.setAttribute("href", cityUrl);

				injectEventSchema(data.events, data.city);
				setLoading(false);
			})
			.catch((err: Error) => {
				setError(`could not load events for "${cityKey}": ${err.message}`);
				setLoading(false);
			});

		return () => {
			document.getElementById(SCHEMA_ID)?.remove();
		};
	}, [cityKey]);

	const picks = cityData
		? cityData.events.filter(
				(e, i) => (e.score || 0) >= TOP_PICK_THRESHOLD && i < 9,
			)
		: [];
	const rest = cityData
		? cityData.events.filter(
				(e, i) => (e.score || 0) < TOP_PICK_THRESHOLD || i >= 9,
			)
		: [];

	return { cityData, picks, rest, loading, error };
}
