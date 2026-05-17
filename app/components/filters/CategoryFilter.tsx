import { useEventsContext } from "../../context";

export default function CategoryFilter() {
	const { categories, activeCat, setActiveCat } = useEventsContext();

	return (
		<span className="filters filters--cat">
			<button
				type="button"
				className={`filter-btn${activeCat === "All" || !activeCat ? " active" : ""}`}
				onClick={() => setActiveCat("All")}
			>
				All Categories
			</button>
			{categories.map((cat) => (
				<button
					type="button"
					key={cat}
					className={`filter-btn${activeCat === cat ? " active" : ""}`}
					onClick={() => setActiveCat(cat)}
				>
					{cat}
				</button>
			))}
		</span>
	);
}
