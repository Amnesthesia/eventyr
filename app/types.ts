export interface Event {
	title: string;
	datetime: string;
	location: string;
	location_url?: string;
	link: string;
	category: string;
	cost: string;
	source: string;
	description: string;
	tags: string[];
	score: number;
	datetime_iso: string;
	datetime_end_iso: string;
	image: string;
	social?: boolean;
	intellectual?: boolean;
	hands_on?: boolean;
	creative?: boolean;
	venue?: string;
}

export type TriState = "yes" | "no" | "any";
export type VibeKey = "intellectual" | "creative" | "hands_on" | "social";
export type VibeFilters = Record<VibeKey, TriState>;
export type PastFilter = "no-past" | "all" | "only-past";

export interface City {
	key: string;
	name: string;
	week_start: string;
	week_end: string;
	event_count: number;
	top_pick_count: number;
}

export interface CityIndex {
	generated_at: string;
	cities: City[];
}

export interface DateRange {
	start: string;
	end: string;
}

export interface CityData {
	city: string;
	city_key: string;
	week_start: string;
	week_end: string;
	generated_at: string;
	/** How this city's prices are written; curate copies these from
	 * sources/{city}.yml. Absent on older data, which falls back to
	 * DEFAULT_COST_LOCALE. */
	locale?: string;
	currency?: string;
	/** IANA zone the naive event times are in; used for schema.org offsets. */
	timezone?: string;
	events: Event[];
}
