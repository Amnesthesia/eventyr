import { Calendar, Moon, Sun } from "lucide-react";
import { useEventsContext } from "../context";
import { KEY_TO_SLUG } from "../utils/citySlug";
import { fmtRange } from "../utils/dates";
import ExportSaved from "./ExportSaved";
import SearchBar from "./SearchBar";

export default function Header() {
	const {
		filtered,
		cities,
		cityKey,
		cityData,
		theme,
		toggleTheme,
		weekStart,
		weekEnd,
	} = useEventsContext();

	const meta = cityData
		? `${fmtRange(weekStart, weekEnd)} · ${filtered.length} events`
		: "loading…";

	return (
		<header>
			<h1 className="site-name">
				<a href="/">&gt;&nbsp;do things</a>{" "}
				<span className="vague">in {cityData?.city?.split(",")[0]}</span>
			</h1>
			<span className="header-meta">{meta}</span>
			<div className="header-controls">
				<SearchBar />
				{cities.length > 1 && (
					<>
						<nav className="city-nav" aria-label="City pages">
							{cities.map((c) => {
								const slug = KEY_TO_SLUG[c.key] ?? c.key;
								return (
									<a
										key={c.key}
										href={`/${slug}`}
										className={`filter-btn${c.key === cityKey ? " active" : ""}`}
									>
										{c.name.split(",")[0]}
									</a>
								);
							})}
						</nav>
						<select
							className="city-select city-select--mobile"
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
					</>
				)}
				<ExportSaved compact />
				{cityKey && (
					<a
						className="theme-btn"
						href={`/${cityKey}.ics`}
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
