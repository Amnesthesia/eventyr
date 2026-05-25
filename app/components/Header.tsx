import { Calendar, Moon, Sun } from "lucide-react";
import { useEventsContext } from "../context";
import { KEY_TO_SLUG } from "../utils/citySlug";
import { fmtRange } from "../utils/dates";

export default function Header() {
	const { filtered, cities, cityKey, setCity, cityData, theme, toggleTheme } =
		useEventsContext();

	const meta = cityData
		? `${fmtRange(cityData.week_start, cityData.week_end)} · ${filtered.length} events this week`
		: "loading…";

	return (
		<header>
			<span className="site-name">&gt;&nbsp;do things</span>
			<span className="header-meta">{meta}</span>
			<div className="header-controls">
				{cities.length > 1 && (
					<select
						className="city-select"
						value={cityKey}
						onChange={(e) => {
							const slug = KEY_TO_SLUG[e.target.value] ?? e.target.value;
							window.location.href = `/${slug}`;
						}}
					>
						{cities.map((c) => (
							<option key={c.key} value={c.key}>
								{c.name.split(",")[0]}
							</option>
						))}
					</select>
				)}
				{cityKey && (
					<a
						className="theme-btn"
						href={`${cityKey}.ics`}
						download
						aria-label="Subscribe to calendar"
						title="Download calendar (.ics)"
					>
						<Calendar size={12} strokeWidth={2} />
					</a>
				)}
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
			</div>
		</header>
	);
}
