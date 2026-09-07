import { catToSlug } from "@react/utils/categorySlug";
import { KEY_TO_SLUG } from "@react/utils/citySlug";
import { useEffect } from "react";
import { useEventsContext } from "../../context";

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
				href={`/${KEY_TO_SLUG[cityKey] ?? cityKey}/`}
			>
				All Categories
			</a>
			{categories.map((cat) => (
				<a
					key={cat}
					className={`filter-btn${activeCat === cat ? " active" : ""}`}
					data-cat={catToSlug(cat)}
					onClick={() => setActiveCat(cat)}
					href={`/${KEY_TO_SLUG[cityKey] ?? cityKey}/${catToSlug(cat)}/`}
				>
					{cat}
				</a>
			))}
		</span>
	);
}
