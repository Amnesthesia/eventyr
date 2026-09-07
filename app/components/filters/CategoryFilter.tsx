import { catToSlug } from "@react/utils/categorySlug";
import { KEY_TO_SLUG } from "@react/utils/citySlug";
import { useEffect } from "react";
import { useEventsContext } from "../../context";

export default function CategoryFilter() {
	const { categories, activeCat, setActiveCat, cityKey } = useEventsContext();
	const citySlug = KEY_TO_SLUG[cityKey] ?? cityKey;

	// Marks the one pill a per-category static page carries as active on load.
	// Safe now (unlike the effect this replaced): `categories` comes from
	// cityData.events, not from the activeCat-dependent `filtered` list, so it
	// cannot change as a result of this running and cannot re-trigger itself.
	useEffect(() => {
		if (categories.length === 1 && activeCat === "All") {
			setActiveCat(categories[0]);
		}
	}, [categories, activeCat, setActiveCat]);

	// A per-category static page (src/pages/[city]/[category].astro) ships only
	// that one category's events, so `categories` here is a single entry and
	// there is no other category's data to switch to without a real navigation.
	// The full city page carries every category, and there the click should
	// filter in place — a real navigation used to reload the ~3MB page and
	// discard the very state change the click just made.
	const canFilterInPlace = categories.length > 1;

	function selectCat(cat: string, e: React.MouseEvent) {
		if (!canFilterInPlace) return;
		e.preventDefault();
		setActiveCat(cat);
	}

	return (
		<span className="filters filters--cat">
			<a
				className={`filter-btn${activeCat === "All" || !activeCat ? " active" : ""}`}
				onClick={(e) => selectCat("All", e)}
				href={`/${citySlug}/`}
			>
				All Categories
			</a>
			{categories.map((cat) => (
				<a
					key={cat}
					className={`filter-btn${activeCat === cat ? " active" : ""}`}
					data-cat={catToSlug(cat)}
					onClick={(e) => selectCat(cat, e)}
					href={`/${citySlug}/${catToSlug(cat)}/`}
				>
					{cat}
				</a>
			))}
		</span>
	);
}
