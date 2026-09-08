import { catShortName, catToSlug } from "@react/utils/categorySlug";
import { KEY_TO_SLUG } from "@react/utils/citySlug";
import { useEffect } from "react";
import { useEventsContext } from "../../context";

export default function CategoryFilter() {
	const { categories, activeCat, setActiveCat, cityKey } = useEventsContext();
	const citySlug = KEY_TO_SLUG[cityKey] ?? cityKey;

	// Marks the one chip a per-category static page carries as active on load.
	// Safe (unlike the effect this replaced): `categories` comes from
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

	return (
		<div className="chips chips--cat">
			{categories.map((cat) => {
				const on = activeCat === cat;
				// Deselecting is a click on the lit chip: there is no "all
				// categories" pill any more, because a black pill for "no filter"
				// was the loudest thing on the page saying nothing.
				const href = on ? `/${citySlug}/` : `/${citySlug}/${catToSlug(cat)}/`;
				return (
					<a
						key={cat}
						className={`chip${on ? " chip--on" : ""}`}
						data-cat={catToSlug(cat)}
						href={href}
						aria-current={on ? "true" : undefined}
						onClick={(e) => {
							if (!canFilterInPlace) return;
							e.preventDefault();
							setActiveCat(on ? "All" : cat);
						}}
					>
						{catShortName(cat)}
					</a>
				);
			})}
		</div>
	);
}
