import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { City } from "../types";
import { KEY_TO_SLUG, SLUG_TO_KEY } from "../utils/citySlug";
import { cacheBust } from "../utils/dates";

export function useCity() {
	const [cities, setCities] = useState<City[]>([]);
	const [cityKey, setCityKey] = useState<string>("");
	const location = useLocation();
	const navigate = useNavigate();

	useEffect(() => {
		// Path like /brisbane or /gold-coast takes priority; fall back to ?city=
		const pathSlug = location.pathname.replace(/^\//, "");
		const queryParam = new URLSearchParams(location.search).get("city");
		const cityParam = SLUG_TO_KEY[pathSlug] ?? queryParam ?? null;

		fetch(`data/index.json?v=${cacheBust()}`)
			.then((r) => (r.ok ? r.json() : Promise.reject()))
			.then((idx) => {
				const list: City[] = idx.cities || [];
				setCities(list);
				const keys = list.map((c) => c.key);
				const initial =
					cityParam && keys.includes(cityParam)
						? cityParam
						: keys[0] || "brisbane";
				setCityKey(initial);
			})
			.catch(() => {
				setCityKey(cityParam || "brisbane");
			});
	}, [location.pathname, location.search]);

	function setCity(key: string) {
		const slug = KEY_TO_SLUG[key] ?? key;
		navigate(`/${slug}`);
		setCityKey(key);
	}

	return { cities, cityKey, setCity };
}
