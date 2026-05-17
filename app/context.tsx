import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useCity } from "./hooks/useCity";
import { useColorTheme } from "./hooks/useColorTheme";
import { useEvents } from "./hooks/useEvents";
import { useStarred } from "./hooks/useStarred";
import type {
	City,
	CityData,
	DateRange,
	Event,
	PastFilter,
	TriState,
	VibeFilters,
	VibeKey,
} from "./types";
import { parseEndDate, todayIso } from "./utils/dates";

interface EventsContextValue {
	// Raw data
	cityData: CityData | null;
	loading: boolean;
	error: string | null;
	filtered: Event[];
	// City
	cities: City[];
	cityKey: string;
	setCity: (key: string) => void;

	// Theme
	theme: "light" | "dark";
	toggleTheme: () => void;

	// Starred
	starred: Set<string>;
	toggleStar: (id: string) => void;

	// Filter state + setters
	activeCat: string;
	setActiveCat: (cat: string) => void;
	dateRange: DateRange | null;
	setDateRange: (range: DateRange | null) => void;
	activeTags: string[];
	toggleTag: (tag: string) => void;
	pastFilter: PastFilter;
	setPastFilter: (v: PastFilter) => void;
	vibeFilters: VibeFilters;
	setVibe: (key: VibeKey, state: TriState) => void;
	resetVibes: () => void;

	// Derived
	categories: string[];
	starredEvents: Event[];
	picks: Event[];
	rest: Event[];
	weekStart: string;
	weekEnd: string;
	isEventPast: (event: Event) => boolean;
}

const EventsContext = createContext<EventsContextValue | null>(null);

export function useEventsContext(): EventsContextValue {
	const ctx = useContext(EventsContext);
	if (!ctx)
		throw new Error("useEventsContext must be used within EventsProvider");
	return ctx;
}

export function EventsProvider({ children }: { children: ReactNode }) {
	const { theme, toggle: toggleTheme } = useColorTheme();
	const { cities, cityKey, setCity } = useCity();
	const { cityData, loading, error } = useEvents(cityKey);
	const { starred, toggle: toggleStar } = useStarred();

	const [activeCat, setActiveCat] = useState("All");
	const [dateRange, setDateRange] = useState<DateRange | null>(null);
	const [activeTags, setActiveTags] = useState<string[]>([]);
	const [pastFilter, setPastFilter] = useState<PastFilter>("no-past");
	const [vibeFilters, setVibeFilters] = useState<VibeFilters>({
		intellectual: "any",
		creative: "any",
		hands_on: "any",
		social: "any",
	});

	useEffect(() => {
		if (!cityKey) return;
		setActiveCat("All");
		setDateRange(null);
		setActiveTags([]);
		setPastFilter("no-past");
		setVibeFilters({
			intellectual: "any",
			creative: "any",
			hands_on: "any",
			social: "any",
		});
	}, [cityKey]);

	const toggleTag = useCallback((tag: string) => {
		setActiveTags((prev) =>
			prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
		);
	}, []);

	const setVibe = useCallback((key: VibeKey, state: TriState) => {
		setVibeFilters((prev) => ({ ...prev, [key]: state }));
	}, []);

	const resetVibes = useCallback(() => {
		setVibeFilters({
			intellectual: "any",
			creative: "any",
			hands_on: "any",
			social: "any",
		});
	}, []);

	const todayStr = todayIso();

	const isEventPast = useCallback(
		(event: Event): boolean => {
			const end = (event.datetime_end_iso || event.datetime_iso || "").slice(
				0,
				10,
			);
			return end ? end < todayStr : false;
		},
		[todayStr],
	);

	const filtered = useMemo(() => {
		if (!cityData) return [];
		return cityData.events.filter((event) => {
			const catOk = activeCat === "All" || event.category === activeCat;

			const dateOk = (() => {
				if (!dateRange) return true;
				if (!event.datetime_iso) return false;
				const eventStart = event.datetime_iso.slice(0, 10);
				const eventEnd =
					parseEndDate(event.datetime || "", event.datetime_iso) || eventStart;
				return eventStart <= dateRange.end && eventEnd >= dateRange.start;
			})();

			const tagsOk =
				activeTags.length === 0 ||
				activeTags.every((tag) => (event.tags || []).includes(tag));

			const endDate = (
				event.datetime_end_iso ||
				event.datetime_iso ||
				""
			).slice(0, 10);
			const isPast = endDate ? endDate < todayStr : false;
			if (pastFilter === "no-past" && isPast) return false;
			if (pastFilter === "only-past" && !isPast) return false;

			const vibeOk = (
				Object.entries(vibeFilters) as [VibeKey, TriState][]
			).every(([key, state]) => {
				if (state === "any") return true;
				return state === "yes" ? event[key] === true : event[key] !== true;
			});

			return catOk && dateOk && tagsOk && vibeOk;
		});
	}, [
		cityData,
		activeCat,
		dateRange,
		activeTags,
		pastFilter,
		vibeFilters,
		todayStr,
	]);

	const categories = useMemo(
		() => [...new Set(filtered.map((e) => e.category).filter(Boolean))],
		[filtered],
	);

	const { starredEvents, picks, rest } = useMemo(() => {
		const starredEvents: Event[] = [];
		const picks: Event[] = [];
		const rest: Event[] = [];
		filtered.forEach((e) => {
			const id = e.title + e.datetime_iso;
			if (starred.has(id)) {
				starredEvents.push(e);
			} else if ((e.score || 0) >= 8 && picks.length < 9) {
				picks.push(e);
			} else {
				rest.push(e);
			}
		});
		return { starredEvents, picks, rest };
	}, [filtered, starred]);

	const value: EventsContextValue = {
		cityData,
		filtered,
		loading,
		error,
		cities,
		cityKey,
		setCity,
		theme,
		toggleTheme,
		starred,
		toggleStar,
		activeCat,
		setActiveCat,
		dateRange,
		setDateRange,
		activeTags,
		toggleTag,
		pastFilter,
		setPastFilter,
		vibeFilters,
		setVibe,
		resetVibes,
		categories,
		starredEvents,
		picks,
		rest,
		weekStart: cityData?.week_start ?? "",
		weekEnd: cityData?.week_end ?? "",
		isEventPast,
	};

	return (
		<EventsContext.Provider value={value}>{children}</EventsContext.Provider>
	);
}
