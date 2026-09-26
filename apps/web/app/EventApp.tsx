import type { City, CityData, DateRange } from "@dothingslol/core/schema";
import { StrictMode } from "react";
import AppShell from "./AppShell";
import { EventsProvider } from "./context";

interface Props {
	cityData: CityData;
	allCities: City[];
	/** Set by /today/, /tomorrow/, /this-weekend/ — see EventsProvider. */
	initialDateRange?: DateRange | null;
}

export default function EventApp({
	cityData,
	allCities,
	initialDateRange,
}: Props) {
	return (
		<StrictMode>
			<EventsProvider
				initialData={cityData}
				allCities={allCities}
				initialDateRange={initialDateRange}
			>
				<AppShell />
			</EventsProvider>
		</StrictMode>
	);
}
