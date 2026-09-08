import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type CostLocale,
	DEFAULT_COST_LOCALE,
	isTopPick,
	LOW_SCORE_THRESHOLD,
	TOP_PICK_THRESHOLD,
} from "../src/shared.ts";
import { useColorTheme } from "./hooks/useColorTheme";
import { useStoredSet } from "./hooks/useStoredSet";
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
import {
	endOfMonth,
	eventOverlapsRange,
	startOfWeek,
	todayIso,
} from "./utils/dates";
import type { GroupBy } from "./utils/grouping";
import {
	cancel1hReminder,
	checkAndNotifyMorningDigest,
	schedule1hReminder,
	syncAllStarredEvents,
} from "./utils/notifications";
import { matchesQuery, queryTokens } from "./utils/search";
import {
	bumpTaste,
	loadTaste,
	logTasteProfile,
	onTasteChange,
	rankByTaste,
	saveTaste,
	type TasteProfile,
} from "./utils/taste";

/** The identity saved/hidden sets are keyed by. Not eventHash: stars already
 * in people's localStorage use this basis, and changing it would lose them. */
export function eventId(event: Event): string {
	return event.title + event.datetime_iso;
}

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
	saveEvent: (id: string) => void;
	unsaveEvent: (id: string) => void;
	/** Swiped-left events. Excluded from `filtered` until unhidden. */
	hidden: Set<string>;
	hiddenCount: number;
	hideEvent: (id: string) => void;
	unhideEvent: (id: string) => void;
	clearHidden: () => void;
	/** Lowest score an event may have and still show. 0 shows everything. */
	minScore: number;
	setMinScore: (v: number) => void;
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
	/** Locale and currency for rendering prices, from the city's data file. */
	costLocale: CostLocale;
	/** Bounds for the date-range picker. Not the same as weekStart/weekEnd,
	 * which describe the coverage this digest actually has. */
	dateMin: string;
	dateMax: string;
	setVibe: (key: VibeKey, state: TriState) => void;
	resetVibes: () => void;
	categories: string[];
	/** Bookmark/share/calendar counts per tag, vibe and category. Exposed so
	 * the swipe deck can order itself the same way the picks row does. */
	taste: TasteProfile;
	starredEvents: Event[];
	picks: Event[];
	rest: Event[];
	weekStart: string;
	weekEnd: string;
	isEventPast: (event: Event) => boolean;
	/** "" until corrected client-side post-mount (see isEventPast above) — a
	 * grouping/window calculation that needs "today" must use this rather than
	 * calling todayIso() itself, or it disagrees between the build-time and
	 * client-mount value and hydration mismatches. */
	todayStr: string;
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
	/** Set by /today/, /tomorrow/, /this-weekend/ (src/pages/[city]/[timeframe].astro).
	 * cityData.events is already restricted to that window server-side, but
	 * without this the date-range state itself defaults to null — leaving the
	 * "Today"/"Tomorrow" toggle buttons unpressed and, more importantly,
	 * disabling the startsInRange check below that keeps a months-long-running
	 * event out of "picks" just because it happens to overlap today. */
	initialDateRange?: DateRange | null;
}

export function EventsProvider({
	children,
	initialData,
	allCities,
	initialDateRange = null,
}: ProviderProps) {
	const { theme, toggle: toggleTheme } = useColorTheme();
	const cityData = initialData;
	const cities = allCities;
	const cityKey = initialData.city_key;

	const {
		set: starred,
		add: baseSaveEvent,
		remove: baseUnsaveEvent,
	} = useStoredSet("eventyr:starred");
	const {
		set: hidden,
		add: hideEvent,
		remove: unhideEvent,
		clear: clearHidden,
	} = useStoredSet("eventyr:hidden");
	// What this browser tends to single out, used to order Top Picks and the
	// swipe deck. Empty until MIN_SIGNAL interactions, at which point they
	// start leaning personal.
	const [taste, setTaste] = useState<TasteProfile>(loadTaste);
	// Shares and calendar adds are counted by noteInterest, which writes
	// straight to localStorage from components that may not have this context.
	// Without this the state here would go stale and the next bookmark would
	// overwrite those counts.
	useEffect(() => onTasteChange(setTaste), []);
	// Defaults to LOW_SCORE_THRESHOLD, which is where it has always effectively
	// sat: below 4 is mostly venue promotion — happy hours, "$13 Lunch
	// Special", schnitzel nights — which the ranker scores 1–3 and which nobody
	// opened this site to read.
	//
	// A threshold rather than the old on/off toggle because the scrape path now
	// returns enough events that "hide the junk" and "show me only the good
	// ones" are different asks: Brisbane went from 462 to 751 in one run. The
	// select in the filter bar reaches every value including 0, so nothing is
	// unreachable.
	const [minScore, setMinScore] = useState<number>(LOW_SCORE_THRESHOLD);

	/** Count this event's tags, vibes and category in or out of the taste
	 * profile. An id with no matching event (starred in an earlier week, now
	 * aged out of the data) changes nothing: the facets to count are gone. That
	 * only ever loses a decrement, and bumpTaste clamps at zero. */
	const bumpTasteFor = useCallback(
		(id: string, delta: number) => {
			const ev = cityData.events.find((e) => eventId(e) === id);
			if (!ev) return;
			setTaste((prev) => {
				const next = bumpTaste(prev, ev, delta);
				saveTaste(next);
				return next;
			});
		},
		[cityData.events],
	);

	const saveEvent = useCallback(
		(id: string) => {
			baseSaveEvent(id);
			bumpTasteFor(id, 1);
			const ev = cityData.events.find((e) => eventId(e) === id);
			if (ev) {
				schedule1hReminder(ev, cityKey, true);
			}
		},
		[baseSaveEvent, bumpTasteFor, cityData.events, cityKey],
	);

	const unsaveEvent = useCallback(
		(id: string) => {
			baseUnsaveEvent(id);
			bumpTasteFor(id, -1);
			cancel1hReminder(id);
		},
		[baseUnsaveEvent, bumpTasteFor],
	);

	const toggleStar = useCallback(
		(id: string) => {
			if (starred.has(id)) {
				unsaveEvent(id);
			} else {
				saveEvent(id);
			}
		},
		[starred, saveEvent, unsaveEvent],
	);

	useEffect(() => {
		if (cityData?.events) {
			syncAllStarredEvents(cityData.events, starred, cityKey);
		}

		function onVisibilityChange() {
			if (document.visibilityState === "visible") {
				checkAndNotifyMorningDigest(cityData.events, starred, cityKey);
			}
		}

		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("focus", onVisibilityChange);
		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("focus", onVisibilityChange);
		};
	}, [cityData.events, starred, cityKey]);

	function setCity(key: string) {
		const slug = KEY_TO_SLUG[key] ?? key;
		window.location.href = `/${slug}`;
	}

	const [activeCat, setActiveCat] = useState("All");
	const [dateRange, setDateRange] = useState<DateRange | null>(
		initialDateRange,
	);
	const [activeTags, setActiveTags] = useState<string[]>([]);
	const [pastFilter, setPastFilter] = useState<PastFilter>("no-past");
	// "date" by default so the "Today"/"Tomorrow" section headings render
	// without the reader having to find the grouping toggle first.
	const [groupBy, setGroupBy] = useState<GroupBy>("date");
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
			if (hidden.has(eventId(event))) return false;
			// An unscored event is never hidden by this filter — ranking can be
			// absent (a fresh scrape, a failed rank pass) and a missing score is
			// not a low one. Same rule meetsScoreFloor applies for the feeds.
			if (typeof event.score === "number" && event.score < minScore) {
				return false;
			}
			if (!matchesQuery(event, tokens)) return false;
			const catOk = activeCat === "All" || event.category === activeCat;

			const dateOk =
				!dateRange || eventOverlapsRange(event, dateRange.start, dateRange.end);

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
		hidden,
		minScore,
	]);

	// Counted against the whole city, not `filtered`: hidden events are by
	// definition not in `filtered`, and the count is the only thing that tells
	// a reader they have hidden anything at all.
	const hiddenCount = useMemo(
		() => cityData.events.filter((e) => hidden.has(eventId(e))).length,
		[cityData, hidden],
	);

	// From cityData.events, not `filtered`: this populates the category pills
	// themselves, and deriving it from the filtered list made it depend on
	// activeCat — once a click narrowed the list to one category, the pill row
	// shrank to that one pill with no way back except the (also narrowed) "All"
	// link. A static per-category page (src/pages/[city]/[category].astro)
	// already ships only that category's events, so this still comes out to a
	// single pill there — which is exactly right, since there is no other
	// category's data on that page to switch to client-side.
	const categories = useMemo(
		() => [...new Set(cityData.events.map((e) => e.category).filter(Boolean))],
		[cityData],
	);

	const { starredEvents, picks, rest } = useMemo(() => {
		const starredEvents: Event[] = [];
		const eligible: Event[] = [];
		// A pick has to START inside the selected dates, not merely overlap them.
		// The date filter itself is deliberately an overlap test — that is what
		// makes selecting the last two days of a festival work — but it also
		// admits a run that opened months ago, and "Picks" for Today showing an
		// exhibition dated 1 January reads as a bug even though the exhibition
		// is genuinely open today. Those stay in the list below, where grouping
		// by date files them under "Ongoing" and says so.
		// The window picks are judged against: whatever the user has filtered to,
		// else the published week. It used to fall back to "no window at all"
		// when no filter was set, which is exactly when a months-long run could
		// sit in Picks every week.
		const pickWindow = {
			start: dateRange?.start ?? cityData?.week_start ?? "",
			end: dateRange?.end ?? cityData?.week_end ?? "",
		};
		const unstarred: Event[] = [];
		filtered.forEach((e) => {
			// A saved event lives only in the "saved" section once it's starred —
			// it used to fall through into picks/rest too, so the exact same card
			// rendered twice on any page with a save on it.
			if (starred.has(eventId(e))) {
				starredEvents.push(e);
				return;
			}
			unstarred.push(e);
			if (isTopPick(e, pickWindow.start, pickWindow.end)) {
				eligible.push(e);
			}
		});
		// Which nine of the eligible events surface is where personalisation
		// happens: rankByTaste reorders them by score plus how well they match
		// what this browser has bookmarked, so the row leans toward saved tags,
		// vibes and categories without anything dropping below the score
		// threshold. An empty profile leaves the pipeline's own order alone.
		const picks = rankByTaste(eligible, taste).slice(0, 9);
		const pickIds = new Set(picks.map(eventId));
		// Everything the picks row did not take, still in the incoming score
		// order — including eligible events beyond the nine.
		const rest = unstarred.filter((e) => !pickIds.has(eventId(e)));
		return { starredEvents, picks, rest };
	}, [
		filtered,
		starred,
		dateRange,
		taste,
		// Picks fall back to the published week when no date filter is set, so
		// the window is a real input to this memo.
		cityData?.week_start,
		cityData?.week_end,
	]);

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
	 * The earliest. The day the digest was generated (a Sunday, the day before
	 * its week starts — the same rule Base.astro uses for coverage), not the
	 * earliest date in the data: that is a 2023 exhibition opening, and no one
	 * is picking 2023 — those events surface anyway, because the date filter is
	 * an overlap test.
	 */
	const dateMin = cityData?.generated_at || cityData?.week_start || "";

	const costLocale: CostLocale = {
		locale: cityData?.locale ?? DEFAULT_COST_LOCALE.locale,
		currency: cityData?.currency ?? DEFAULT_COST_LOCALE.currency,
	};

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

	// The header range never starts before this week's Monday. The earliest
	// event is an exhibition that opened in February, and "19 Feb – 13 Sep"
	// on the masthead read as stale rather than as coverage. Falls back to the
	// digest's own Monday until today is known client-side (see todayStr), so
	// server and first client render agree.
	const weekStart = useMemo(() => {
		const floor = todayStr
			? startOfWeek(todayStr)
			: (cityData?.week_start ?? "");
		const clamped = coverageStart < floor ? floor : coverageStart;
		return coverageEnd && clamped > coverageEnd ? coverageEnd : clamped;
	}, [coverageStart, coverageEnd, todayStr, cityData?.week_start]);

	// Printed once per load, after picks exist. The feature is invisible by
	// design — a reordered row looks like no feature at all — so this is the
	// only way to see what the profile is doing.
	const logged = useRef(false);
	useEffect(() => {
		if (logged.current) return;
		logged.current = true;
		logTasteProfile(taste, picks);
	}, [taste, picks]);

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
		saveEvent,
		unsaveEvent,
		hidden,
		hiddenCount,
		hideEvent,
		unhideEvent,
		clearHidden,
		minScore,
		setMinScore,
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
		costLocale,
		dateMin,
		dateMax,
		categories,
		starredEvents,
		taste,
		picks,
		rest,
		// Derived from the events rather than taken straight from
		// week_start/week_end: the scrape pass now keeps next week's events too,
		// and clamping the date picker to the digest week would leave them in
		// the data but unreachable. Deriving can't desync, and week_start /
		// week_end keep their existing meaning for the pipeline's cache checks.
		weekStart,
		weekEnd: coverageEnd,
		isEventPast,
		todayStr,
	};

	return (
		<EventsContext.Provider value={value}>{children}</EventsContext.Provider>
	);
}
