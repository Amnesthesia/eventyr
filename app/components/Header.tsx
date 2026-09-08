import { CalendarDays, Layers, Minus, Moon, Plus, Sun } from "lucide-react";
import { useId, useState } from "react";
import { eventId, useEventsContext } from "../context";
import { KEY_TO_SLUG } from "../utils/citySlug";
import ActiveFilterStrip from "./filters/ActiveFilterStrip";
import CategoryFilter from "./filters/CategoryFilter";
import MoreFilters from "./filters/MoreFilters";
import WhenFilter from "./filters/WhenFilter";
import PreferencesPane from "./PreferencesPane";
import SearchBar from "./SearchBar";

interface Props {
	onSwipe: () => void;
	onOpenCalendar: () => void;
}

/**
 * Two tiers and a disclosure, sticky over the list.
 *
 * Row 1 is scope (where, what text, this browser's own stuff), row 2 is the
 * two filters people actually reach for (when, category), and everything else
 * is behind MORE FILTERS. The five equal-weight rows this replaced put ~350px
 * of chrome above the first event and gave the reader nothing to read first.
 */
export default function Header({ onSwipe, onOpenCalendar }: Props) {
	const { cities, cityKey, cityData, starred, theme, toggleTheme } =
		useEventsContext();
	// Against the whole city, not the filtered list: "my saved events" means all
	// of them, not the ones the current category happens to leave visible.
	const savedCount = cityData.events.filter((e) =>
		starred.has(eventId(e)),
	).length;
	// Closed on both sides of hydration — the server has no way to know, and a
	// disclosure that pops open after mount is worse than one press.
	const [moreOpen, setMoreOpen] = useState(false);
	const moreId = useId();

	return (
		<header className="app-header">
			<div className="hdr-row hdr-row--scope">
				<h1 className="site-name">
					<a href="/">&gt;&nbsp;do things</a> <span className="vague">in</span>
				</h1>
				{cities.length > 1 ? (
					<select
						className="city-select"
						aria-label="City"
						value={cityKey}
						onChange={(e) => {
							const slug = KEY_TO_SLUG[e.target.value] ?? e.target.value;
							window.location.href = `/${slug}/`;
						}}
					>
						{cities.map((c) => (
							<option key={c.key} value={c.key}>
								{c.name.split(",")[0]}
							</option>
						))}
					</select>
				) : (
					<span className="city-static">{cityData?.city?.split(",")[0]}</span>
				)}
				<div className="hdr-tools">
					<SearchBar />
					{/* Opens the saved week; the .ics download lives inside that view,
					    which is the only place it is worth offering — exporting from a
					    corner button meant downloading a file to find out what was in
					    it. */}
					<button
						type="button"
						className="theme-btn saved-count"
						onClick={onOpenCalendar}
						disabled={savedCount === 0}
						title="See your saved events on a week calendar"
					>
						<CalendarDays size={12} strokeWidth={2} />
						Saved {savedCount}
					</button>
					{/* Neither of these narrows the list, so neither belongs in the
					    filter disclosure: one opens a different mode, the other is a
					    settings pane. No .ics link here any more — exporting 600+
					    events is nobody's intent, and the saved section has its own
					    export for the set that is worth subscribing to. */}
					<button
						type="button"
						className="theme-btn swipe-btn"
						onClick={onSwipe}
						aria-label="Swipe through events"
						title="Swipe through events one at a time"
					>
						<Layers size={12} strokeWidth={2} />
					</button>
					<button
						type="button"
						className="theme-btn"
						aria-label="Toggle dark mode"
						onClick={toggleTheme}
					>
						{theme === "dark" ? (
							<Sun size={12} strokeWidth={2} />
						) : (
							<Moon size={12} strokeWidth={2} />
						)}
					</button>
					<PreferencesPane compact />
				</div>
			</div>

			<div className="hdr-row hdr-row--refine">
				<WhenFilter />
				<span className="hdr-divider" aria-hidden="true" />
				<CategoryFilter />
				<button
					type="button"
					className="more-toggle"
					onClick={() => setMoreOpen((open) => !open)}
					aria-expanded={moreOpen}
					aria-controls={moreId}
				>
					{moreOpen ? "Fewer filters" : "More filters"}
					{moreOpen ? (
						<Minus size={11} strokeWidth={2.4} />
					) : (
						<Plus size={11} strokeWidth={2.4} />
					)}
				</button>
			</div>

			<div id={moreId} hidden={!moreOpen}>
				{moreOpen && <MoreFilters />}
			</div>

			<ActiveFilterStrip />
		</header>
	);
}
