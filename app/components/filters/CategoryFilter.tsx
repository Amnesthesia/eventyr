import { useEffect } from "react";
import { useEventsContext } from "../../context";
import { catToSlug } from "@react/utils/categorySlug";
import { KEY_TO_SLUG } from "@react/utils/citySlug";

export default function CategoryFilter() {
	const { categories, activeCat, setActiveCat, cityKey } = useEventsContext();

	useEffect(() => {
		if (categories.length === 1) {
			setActiveCat(categories[0]);
		}
	}, [categories, setActiveCat]);

	return (
		<span className="filters filters--cat">
			<a
				className={`filter-btn${activeCat === "All" || !activeCat ? " active" : ""}`}
				onClick={() => {
					setActiveCat("All");
				}}
				href={`/${cityKey}`}
			>
				All Categories
			</a>
			{categories.map((cat) => (
				<a
					key={cat}
					className={`filter-btn${activeCat === cat ? " active" : ""}`}
					onClick={() => setActiveCat(cat)}
					href={`/${KEY_TO_SLUG[cityKey]}/${catToSlug(cat)}`}
				>
					{cat}
				</a>
			))}
		</span>
	);
}
