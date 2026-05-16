import { useEffect, useState } from "react";
import type { City } from "../types";
import { cacheBust } from "../utils/dates";

export function useCity() {
	const [cities, setCities] = useState<City[]>([]);
	const [cityKey, setCityKey] = useState<string>("");

	useEffect(() => {
		const params = new URLSearchParams(location.search);
		const cityParam = params.get("city");

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
	}, []);

	function setCity(key: string) {
		history.pushState({}, "", `?city=${key}`);
		setCityKey(key);
	}

	return { cities, cityKey, setCity };
}
