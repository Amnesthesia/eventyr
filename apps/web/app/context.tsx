import { todayIso } from "@dothingslol/core/dates";
import {
	applyFilters,
	hiddenCount as countHidden,
	coverage,
	DEFAULT_FILTERS,
	dateBounds,
	type FilterState,
	facetCounts,
	hasActiveFilters as filtersActive,
	isPast,
	splitSections,
} from "@dothingslol/core/filters";
import type { GroupBy } from "@dothingslol/core/grouping";
import { eventId } from "@dothingslol/core/identity";
import type {
	City,
	CityData,
	DateRange,
	EventData,
	PastFilter,
	VibeKey,
} from "@dothingslol/core/schema";
import {
	type CostLocale,
	DEFAULT_COST_LOCALE,
	KEY_TO_SLUG,
} from "@dothingslol/core/shared";
import { STORAGE_KEYS } from "@dothingslol/core/storageKeys";
import { cycleTagPref, type TagPrefs } from "@dothingslol/core/tagPrefs";
import { tagWeights } from "@dothingslol/core/tagSpecificity";
import {
	bumpDislike,
	bumpTaste,
	logTasteProfile,
	type TasteProfile,
} from "@dothingslol/core/taste";
import type { TimeBand } from "@dothingslol/core/timeOfDay";
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
import { useColorTheme } from "./hooks/useColorTheme";
import { useStoredSet } from "./hooks/useStoredSet";
import {
	cancel1hReminder,
	checkAndNotifyMorningDigest,
	schedule1hReminder,
	syncAllStarredEvents,
} from "./utils/notifications";
import { loadTagPrefs, saveTagPrefs } from "./utils/tagPrefsStore";
import { loadTaste, onTasteChange, saveTaste } from "./utils/tasteStore";

interface EventsContextValue {
	cityData: CityData;
	filtered: EventData[];
	/** Events that pass every filter except the score floor. */
	lowScored: EventData[];
	cities: City[];
	cityKey: string;
	setCity: (key: string) => void;
	theme: "light" | "dark";
	toggleTheme: () => void;
	starred: Set<string>;
	toggleStar: (id: string) => void;
	saveEvent: (id: string) => void;
	unsaveEvent: (id: string) => void;
	/** Swiped-left/disliked events. Excluded from `filtered` until unhidden. */
	hidden: Set<string>;
	hiddenCount: number;
	hideEvent: (id: string) => void;
	unhideEvent: (id: string) => void;
	clearHidden: () => void;
	/** "Not interested": hides the event and weights it into the taste
	 * profile by tag specificity, so a dislike moves the ordering the way a
	 * bookmark does, in reverse. */
	dislikeEvent: (id: string) => void;
	/** Which hidden ids were counted as a dislike, vs. a plain swipe-left. */
	disliked: Set<string>;
	/** Lowest score an event may have and still show. 0 shows everything. */
	minScore: number;
	setMinScore: (v: number) => void;
	activeCat: string;
	setActiveCat: (cat: string) => void;
	/** Canonical venue_name to narrow to (src/venues.ts). Null = any venue. */
	activeVenue: string | null;
	setActiveVenue: (venue: string | null) => void;
	/** Every named venue in the city with its event count, alphabetical. */
	venues: { name: string; count: number }[];
	dateRange: DateRange | null;
	setDateRange: (range: DateRange | null) => void;
	activeTags: string[];
	toggleTag: (tag: string) => void;
	clearTags: () => void;
	/** Stated tag preferences: 1 wanted, -1 unwanted. See tagPrefs.ts. */
	tagPrefs: TagPrefs;
	cycleTagPreference: (tag: string) => void;
	clearTagPrefs: () => void;
	pastFilter: PastFilter;
	setPastFilter: (v: PastFilter) => void;
	/** Selected time-of-day bands. Empty = any time. */
	timeBands: TimeBand[];
	toggleTimeBand: (band: TimeBand) => void;
	clearTimeBands: () => void;
	/** Selected vibes. Empty = any vibe. ANDed, like tags. */
	vibes: VibeKey[];
	toggleVibe: (key: VibeKey) => void;
	clearVibes: () => void;
	/** True when anything at all narrows the list. Drives the FILTERING BY
	 * strip and the empty state's "clear filters" offer, from one definition
	 * rather than two that drift. */
	hasActiveFilters: boolean;
	clearAllFilters: () => void;
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
	categories: string[];
	/** Bookmark/share/calendar counts per tag, vibe and category. Exposed so
	 * the swipe deck can order itself the same way the picks row does. */
	taste: TasteProfile;
	starredEvents: EventData[];
	picks: EventData[];
	rest: EventData[];
	weekStart: string;
	weekEnd: string;
	isEventPast: (event: EventData) => boolean;
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
	} = useStoredSet(STORAGE_KEYS.starred);
	const {
		set: hidden,
		add: baseHideEvent,
		remove: baseUnhideEvent,
		clear: baseClearHidden,
	} = useStoredSet(STORAGE_KEYS.hidden);
	// Which hidden ids were counted as a dislike (as opposed to a plain swipe-
	// left from before this feature existed), so unhiding one reverses exactly
	// the weight it added and nothing it didn't.
	const {
		set: disliked,
		add: markDisliked,
		remove: unmarkDisliked,
		clear: clearDislikedMarks,
	} = useStoredSet(STORAGE_KEYS.disliked);
	// What this browser tends to single out, used to order Top Picks and the
	// swipe deck. Empty until MIN_SIGNAL interactions, at which point they
	// start leaning personal.
	const [taste, setTaste] = useState<TasteProfile>(loadTaste);
	// How specific each tag is (rare tag -> high weight), so disliking one
	// event doesn't punish every event sharing its broadest tag. See
	// tagSpecificity.ts's header for why this is computed here, not in the
	// pipeline.
	const tagSpecificity = useMemo(
		() => tagWeights(cityData.events),
		[cityData.events],
	);
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
	const [minScore, setMinScore] = useState<number>(DEFAULT_FILTERS.minScore);

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

	/** Weight this event's tags into or out of the taste profile by specificity.
	 * Same "missing event changes nothing" rule as bumpTasteFor: an id whose
	 * event has aged out of the data just loses a decrement. */
	const bumpDislikeFor = useCallback(
		(id: string, delta: -1 | 1) => {
			const ev = cityData.events.find((e) => eventId(e) === id);
			if (!ev) return;
			setTaste((prev) => {
				const next = bumpDislike(prev, ev, tagSpecificity, delta);
				saveTaste(next);
				return next;
			});
		},
		[cityData.events, tagSpecificity],
	);

	/** "Not interested": hides the event, same as a plain swipe-left, and also
	 * weights it into the taste profile — the signal a bare hide never gave.
	 * A starred event is unstarred first, so an event cannot be both liked and
	 * disliked at once. */
	const dislikeEvent = useCallback(
		(id: string) => {
			if (starred.has(id)) unsaveEvent(id);
			baseHideEvent(id);
			markDisliked(id);
			bumpDislikeFor(id, -1);
		},
		[starred, unsaveEvent, baseHideEvent, markDisliked, bumpDislikeFor],
	);

	/** Reverses dislikeEvent's weighting, but only if this id was actually
	 * counted as a dislike — an id hidden by a plain swipe-left before this
	 * feature existed was never weighted, so there is nothing to undo. */
	const unhideEvent = useCallback(
		(id: string) => {
			baseUnhideEvent(id);
			if (disliked.has(id)) {
				unmarkDisliked(id);
				bumpDislikeFor(id, 1);
			}
		},
		[baseUnhideEvent, disliked, unmarkDisliked, bumpDislikeFor],
	);

	/** hideEvent alone, with no dislike weighting — used where a plain "skip"
	 * with no taste signal is wanted. Not currently exposed; hiding always
	 * goes through dislikeEvent so the profile learns from every hide. */
	const hideEvent = baseHideEvent;

	const clearHidden = useCallback(() => {
		// Reverse every id that was actually counted, not just cleared —
		// otherwise "Unhide N" would leave the negative weights behind.
		for (const id of disliked) bumpDislikeFor(id, 1);
		baseClearHidden();
		clearDislikedMarks();
	}, [disliked, bumpDislikeFor, baseClearHidden, clearDislikedMarks]);

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

	const [activeCat, setActiveCat] = useState(DEFAULT_FILTERS.category);
	const [activeVenue, setActiveVenue] = useState(DEFAULT_FILTERS.venue);
	const [dateRange, setDateRange] = useState<DateRange | null>(
		initialDateRange,
	);
	const [activeTags, setActiveTags] = useState<string[]>([]);
	// Stated preferences, unlike the inferred taste profile, are the reader's
	// own settings — they persist across sessions from the first click.
	const [tagPrefs, setTagPrefs] = useState<TagPrefs>(loadTagPrefs);
	const cycleTagPreference = useCallback((tag: string) => {
		setTagPrefs((prev) => {
			const next = cycleTagPref(prev, tag);
			saveTagPrefs(next);
			return next;
		});
	}, []);
	const clearTags = useCallback(() => setActiveTags([]), []);
	const clearTagPrefs = useCallback(() => {
		setTagPrefs({});
		saveTagPrefs({});
	}, []);
	const [pastFilter, setPastFilter] = useState<PastFilter>(
		DEFAULT_FILTERS.past,
	);
	const [timeBands, setTimeBands] = useState<TimeBand[]>([]);
	const toggleTimeBand = useCallback((band: TimeBand) => {
		setTimeBands((prev) =>
			prev.includes(band) ? prev.filter((b) => b !== band) : [...prev, band],
		);
	}, []);
	const clearTimeBands = useCallback(() => setTimeBands([]), []);
	// "date" by default so the "Today"/"Tomorrow" section headings render
	// without the reader having to find the grouping toggle first.
	const [groupBy, setGroupBy] = useState<GroupBy>("date");
	const [query, setQuery] = useState("");
	const [vibes, setVibes] = useState<VibeKey[]>([]);

	const toggleTag = useCallback((tag: string) => {
		setActiveTags((prev) =>
			prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
		);
	}, []);

	const toggleVibe = useCallback((key: VibeKey) => {
		setVibes((prev) =>
			prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
		);
	}, []);

	const clearVibes = useCallback(() => setVibes([]), []);

	const filters = useMemo<FilterState>(
		() => ({
			category: activeCat,
			venue: activeVenue,
			range: dateRange,
			tags: activeTags,
			vibes,
			timeBands,
			query,
			minScore,
			past: pastFilter,
		}),
		[
			activeCat,
			activeVenue,
			dateRange,
			activeTags,
			vibes,
			timeBands,
			query,
			minScore,
			pastFilter,
		],
	);
	// One definition of "something is filtering" (core/filters), read by the
	// FILTERING BY strip, the empty state and CLEAR ALL alike.
	const hasActiveFilters = filtersActive(filters);

	// Back to DEFAULT_FILTERS, whose score floor is LOW_SCORE_THRESHOLD, not
	// 0: "clear the filters" means the view a first-time visitor gets.
	const clearAllFilters = useCallback(() => {
		const d = DEFAULT_FILTERS;
		setActiveCat(d.category);
		setActiveVenue(d.venue);
		setDateRange(d.range);
		setActiveTags(d.tags);
		setVibes(d.vibes);
		setTimeBands(d.timeBands);
		setQuery(d.query);
		setMinScore(d.minScore);
		setPastFilter(d.past);
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
		(event: EventData) => isPast(event, todayStr),
		[todayStr],
	);

	const { filtered, lowScored } = useMemo(
		() =>
			applyFilters(cityData.events, filters, {
				today: todayStr,
				hidden,
				keyOf: eventId,
			}),
		[cityData.events, filters, todayStr, hidden],
	);

	const hiddenCount = useMemo(
		() => countHidden(cityData.events, hidden, eventId),
		[cityData.events, hidden],
	);

	// From every event, not `filtered`, so the category pills and the venue
	// picker don't shrink to the one option just selected (see facetCounts).
	const { categories, venues } = useMemo(
		() => facetCounts(cityData.events),
		[cityData.events],
	);

	const {
		saved: starredEvents,
		picks,
		rest,
	} = useMemo(
		() =>
			splitSections(filtered, {
				starred,
				keyOf: eventId,
				taste,
				tagPrefs,
				range: dateRange,
				weekStart: cityData.week_start,
				weekEnd: cityData.week_end,
			}),
		[
			filtered,
			starred,
			taste,
			tagPrefs,
			dateRange,
			cityData.week_start,
			cityData.week_end,
		],
	);

	const { dateMin, dateMax } = useMemo(() => dateBounds(cityData), [cityData]);

	const costLocale: CostLocale = {
		locale: cityData?.locale ?? DEFAULT_COST_LOCALE.locale,
		currency: cityData?.currency ?? DEFAULT_COST_LOCALE.currency,
	};

	// The header range (see core/filters coverage): derived from the events,
	// never before this week's Monday, and the digest's Monday until today is
	// known client-side, so server and first client render agree.
	const { weekStart, weekEnd } = useMemo(
		() => coverage(cityData, todayStr),
		[cityData, todayStr],
	);

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
		lowScored,
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
		dislikeEvent,
		disliked,
		minScore,
		setMinScore,
		activeCat,
		setActiveCat,
		activeVenue,
		setActiveVenue,
		venues,
		dateRange,
		setDateRange,
		activeTags,
		toggleTag,
		clearTags,
		tagPrefs,
		cycleTagPreference,
		clearTagPrefs,
		pastFilter,
		setPastFilter,
		timeBands,
		toggleTimeBand,
		clearTimeBands,
		vibes,
		toggleVibe,
		clearVibes,
		hasActiveFilters,
		clearAllFilters,
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
		weekEnd,
		isEventPast,
		todayStr,
	};

	return (
		<EventsContext.Provider value={value}>{children}</EventsContext.Provider>
	);
}
