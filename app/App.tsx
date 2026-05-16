import { useEffect, useState } from "react";
import EventGrid from "./components/EventGrid";
import FilterBar from "./components/FilterBar";
import Header from "./components/Header";
import { useCity } from "./hooks/useCity";
import { useColorTheme } from "./hooks/useColorTheme";
import { useEvents } from "./hooks/useEvents";
import type { DateRange } from "./types";
import { parseEndDate } from "./utils/dates";

export default function App() {
	const { theme, toggle: toggleTheme } = useColorTheme();
	const { cities, cityKey, setCity } = useCity();
	const { cityData, loading, error } = useEvents(cityKey);

	const [activeCat, setActiveCat] = useState<string>("All");
	const [dateRange, setDateRange] = useState<DateRange | null>(null);
	const [activeTags, setActiveTags] = useState<string[]>([]);

	// Reset filters when city changes
	useEffect(() => {
		setActiveCat("All");
		setDateRange(null);
		setActiveTags([]);
	}, []);

	function toggleTag(tag: string) {
		setActiveTags((prev) =>
			prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
		);
	}

	const filtered = cityData?.events.filter((event) => {
		const catOk = activeCat === "All" || event.category === activeCat;

		const dateOk = (() => {
			if (!dateRange) return true;
			if (!event.datetime_iso) return false;
			const eventStart = event.datetime_iso.slice(0, 10);
			const eventEnd =
				parseEndDate(event.datetime || "", event.datetime_iso) || eventStart;
			return eventStart <= dateRange.end && eventEnd >= dateRange.start;
		})();

		const tagsOk =
			activeTags.length === 0 ||
			activeTags.every((tag) => (event.tags || []).includes(tag));

		return catOk && dateOk && tagsOk;
	});
	const picks: typeof filtered = [];
	const rest: typeof filtered = [];
	filtered?.forEach((e) => {
		if ((e.score || 0) >= 8 && picks.length < 9) {
			picks.push(e);
		} else {
			rest.push(e);
		}
	});
	const categories = [
		...new Set(filtered?.map((e) => e.category).filter(Boolean)),
	];

	return (
		<>
			<Header
				cities={cities}
				cityKey={cityKey}
				cityData={cityData}
				theme={theme}
				onCityChange={setCity}
				onThemeToggle={toggleTheme}
			/>
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
						<FilterBar
							categories={categories}
							activeCat={activeCat}
							dateRange={dateRange}
							activeTags={activeTags}
							weekStart={cityData.week_start}
							weekEnd={cityData.week_end}
							onCatChange={setActiveCat}
							onDateChange={setDateRange}
							onTagRemove={toggleTag}
						/>
						{picks.length > 0 && (
							<div id="top-picks-section">
								<div className="section-label">picks</div>
								<EventGrid
									events={picks}
									isTopPick={true}
									dateRange={dateRange}
									activeTags={activeTags}
									onTagClick={toggleTag}
								/>
							</div>
						)}
						<div className="section-label">all events</div>
						<div className="separator" />
						<EventGrid
							events={rest}
							isTopPick={false}
							dateRange={dateRange}
							activeTags={activeTags}
							onTagClick={toggleTag}
						/>
					</>
				)}
			</main>
		</>
	);
}
