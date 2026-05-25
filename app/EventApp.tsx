import { StrictMode } from "react";
import AppShell from "./AppShell";
import { EventsProvider } from "./context";
import type { City, CityData } from "./types";

interface Props {
	cityData: CityData;
	allCities: City[];
}

export default function EventApp({ cityData, allCities }: Props) {
	return (
		<StrictMode>
			<EventsProvider initialData={cityData} allCities={allCities}>
				<AppShell />
			</EventsProvider>
		</StrictMode>
	);
}
