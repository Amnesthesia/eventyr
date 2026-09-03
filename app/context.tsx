import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { TOP_PICK_THRESHOLD } from "../src/shared.ts";
import { useColorTheme } from "./hooks/useColorTheme";
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
import { KEY_TO_SLUG } from "./utils/citySlug";
import { endOfMonth, parseEndDate, todayIso } from "./utils/dates";
import type { GroupBy } from "./utils/grouping";
import { matchesQuery, queryTokens } from "./utils/search";

interface EventsContextValue {
	cityData: CityData;
	filtered: Event[];
	cities: City[];
	cityKey: string;
	setCity: (key: string) => void;
	theme: "light" | "dark";
	toggleTheme: () => void;
	starred: Set<string>;
	toggleStar: (id: string) => void;
	activeCat: string;
	setActiveCat: (cat: string) => void;
	dateRange: DateRange | null;
	setDateRange: (range: DateRange | null) => void;
	activeTags: string[];
	toggleTag: (tag: string) => void;
	pastFilter: PastFilter;
	setPastFilter: (v: PastFilter) => void;
	vibeFilters: VibeFilters;
	groupBy: GroupBy;
	setGroupBy: (mode: GroupBy) => void;
	query: string;
	setQuery: (query: string) => void;
	/** Bounds for the date-range picker. Not the same as weekStart/weekEnd,
	 * which describe the coverage this digest actually has. */
	dateMin: string;
	dateMax: string;
	setVibe: (key: VibeKey, state: TriState) => void;
	resetVibes: () => void;
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

interface ProviderProps {
	children: ReactNode;
	initialData: CityData;
	allCities: City[];
}

export function EventsProvider({
	children,
	initialData,
	allCities,
}: ProviderProps) {
	const { theme, toggle: toggleTheme } = useColorTheme();
	const { starred, toggle: toggleStar } = useStarred();

	const cityData = initialData;
	const cities = allCities;
	const cityKey = initialData.city_key;

	function setCity(key: string) {
		const slug = KEY_TO_SLUG[key] ?? key;
		window.location.href = `/${slug}`;
	}

	const [activeCat, setActiveCat] = useState("All");
	const [dateRange, setDateRange] = useState<DateRange | null>(null);
	const [activeTags, setActiveTags] = useState<string[]>([]);
	const [pastFilter, setPastFilter] = useState<PastFilter>("no-past");
	const [groupBy, setGroupBy] = useState<GroupBy>("none");
	const [query, setQuery] = useState("");
	const [vibeFilters, setVibeFilters] = useState<VibeFilters>({
		intellectual: "any",
		creative: "any",
		hands_on: "any",
		social: "any",
	});

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

	// This is a static site rebuilt weekly, so "today" at server-render
	// (build) time almost never matches "today" at client (view) time —
	// computing it synchronously here would filter a different set of
	// events server vs. client and break hydration. Start with "" (an ISO
	// date always compares >= "", so nothing is treated as past) so the
	// first client render matches the server exactly, then correct it
	// client-side after mount.
	const [todayStr, setTodayStr] = useState("");
	useEffect(() => {
		setTodayStr(todayIso());
	}, []);

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
		// Tokenised once per query rather than once per event: normalising the
		// query 395 times a keystroke is pure waste.
		const tokens = queryTokens(query);
		return cityData.events.filter((event) => {
			if (!matchesQuery(event, tokens)) return false;
			const catOk = activeCat === "All" || event.category === activeCat;

			const dateOk = (() => {
				if (!dateRange) return true;
				if (!event.datetime_iso) return false;
				const eventStart = event.datetime_iso.slice(0, 10);
				// datetime_end_iso is the authoritative end, produced by both
				// collection paths. Re-deriving it from the human string
				// disagreed with it on real multi-day events (PyConAU's real
				// end 30 Aug was guessed as 26 Aug), so selecting the last two
				// days of a festival showed nothing. parseEndDate remains only
				// as a fallback for older data with no end field.
				const eventEnd =
					event.datetime_end_iso?.slice(0, 10) ||
					parseEndDate(event.datetime || "", event.datetime_iso) ||
					eventStart;
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
		query,
	]);

	const categories = useMemo(
		() => [...new Set(filtered.map((e) => e.category).filter(Boolean))],
		[filtered],
	);

	const { starredEvents, picks, rest } = useMemo(() => {
		const starredEvents: Event[] = [];
		const picks: Event[] = [];
		const rest: Event[] = [];
		// A pick has to START inside the selected dates, not merely overlap them.
		// The date filter itself is deliberately an overlap test — that is what
		// makes selecting the last two days of a festival work — but it also
		// admits a run that opened months ago, and "Picks" for Today showing an
		// exhibition dated 1 January reads as a bug even though the exhibition
		// is genuinely open today. Those stay in the list below, where grouping
		// by date files them under "Ongoing" and says so.
		const startsInRange = (e: Event): boolean => {
			if (!dateRange) return true;
			const start = (e.datetime_iso || "").slice(0, 10);
			return !!start && start >= dateRange.start && start <= dateRange.end;
		};
		filtered.forEach((e) => {
			const id = e.title + e.datetime_iso;
			if (starred.has(id)) {
				starredEvents.push(e);
			}
			if (
				(e.score || 0) >= TOP_PICK_THRESHOLD &&
				picks.length < 9 &&
				startsInRange(e)
			) {
				picks.push(e);
			} else {
				rest.push(e);
			}
		});
		return { starredEvents, picks, rest };
	}, [filtered, starred, dateRange]);

	/**
	 * The furthest date the picker lets you choose.
	 *
	 * The latest date any event actually runs to — but capped at the end of the
	 * month that the coverage ends in, because a single long-running exhibition
	 * (one here closes in April 2027) would otherwise stretch the picker across
	 * two years for the sake of one event.
	 */
	const dateMax = useMemo(() => {
		const ends = (cityData?.events ?? [])
			.map((e) => (e.datetime_end_iso || e.datetime_iso || "").slice(0, 10))
			.filter(Boolean)
			.sort();
		const latest = ends[ends.length - 1] ?? cityData?.week_end ?? "";
		if (!latest) return "";
		const cap = endOfMonth(cityData?.week_end || latest);
		return latest > cap ? cap : latest;
	}, [cityData]);

	/**
	 * The earliest. The digest week's Monday, not the earliest date in the data:
	 * that is a 2023 exhibition opening, and no one is picking 2023 — those
	 * events surface anyway, because the date filter is an overlap test.
	 */
	const dateMin = cityData?.week_start ?? "";

	const [coverageStart, coverageEnd] = useMemo(() => {
		const dates = (cityData?.events ?? [])
			.map((e) => (e.datetime_iso ?? "").slice(0, 10))
			.filter(Boolean)
			.sort();
		const start = cityData?.week_start ?? "";
		const end = cityData?.week_end ?? "";
		if (dates.length === 0) return [start, end];
		return [
			start && start < dates[0] ? start : dates[0],
			end && end > dates[dates.length - 1] ? end : dates[dates.length - 1],
		];
	}, [cityData]);

	const value: EventsContextValue = {
		cityData,
		filtered,
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
		groupBy,
		setGroupBy,
		query,
		setQuery,
		dateMin,
		dateMax,
		categories,
		starredEvents,
		picks,
		rest,
		// Derived from the events rather than taken straight from
		// week_start/week_end: the scrape pass now keeps next week's events too,
		// and clamping the date picker to the digest week would leave them in
		// the data but unreachable. Deriving can't desync, and week_start /
		// week_end keep their existing meaning for the pipeline's cache checks.
		weekStart: coverageStart,
		weekEnd: coverageEnd,
		isEventPast,
	};

	return (
		<EventsContext.Provider value={value}>{children}</EventsContext.Provider>
	);
}
