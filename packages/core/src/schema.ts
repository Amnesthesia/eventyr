import { z } from "zod";

// The event and payload shapes, as zod schemas with the TypeScript types
// inferred from them, so the two cannot drift apart. In PR 1 only
// schema.data.test.ts runs these schemas (against every committed data/*.json);
// runtime validation starts in PR 2.

export const EventDataSchema = z.object({
	title: z.string(),
	datetime: z.string(),
	location: z.string(),
	/** Google Maps search link, written by geocode.ts; "" when there is no
	 * location. Absent until geocode has run. */
	location_url: z.string().optional(),
	link: z.string(),
	category: z.string(),
	cost: z.string(),
	source: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	/** 1–10 fit against INTERESTS. Null (or absent) before rank.ts has run;
	 * every published payload has a number, because rank defaults an unscored
	 * event to 5. */
	score: z.number().nullable(),
	datetime_iso: z.string(),
	/** Null when the event has no end time. The pipeline still writes "" for
	 * that today, so "" is accepted too. */
	datetime_end_iso: z.string().nullable(),
	image: z.string(),
	// The four vibes: annotate/curate always write all four.
	social: z.boolean(),
	intellectual: z.boolean(),
	hands_on: z.boolean(),
	creative: z.boolean(),
	/** Source tier (aggregator/institution/independent), not a place. */
	venue: z.string(),
	/** Canonical venue, from src/venues.ts. Null when the location names no
	 * venue ("Multiple locations", a bare suburb). Absent from a payload that
	 * venues.ts has not run over yet (byron's committed week predates it). */
	venue_name: z.string().nullable().optional(),
});
export type EventData = z.infer<typeof EventDataSchema>;

/** The shape of data/{city}.json. */
export const CityPayloadSchema = z.object({
	city: z.string(),
	city_key: z.string(),
	week_start: z.string(),
	week_end: z.string(),
	generated_at: z.string(),
	/** How this city's prices are written; curate copies these from
	 * sources/{city}.yml. Absent on older data, which falls back to
	 * DEFAULT_COST_LOCALE. */
	locale: z.string().optional(),
	currency: z.string().optional(),
	/** IANA zone the naive event times are in (sources/{city}.yml `timezone`,
	 * copied by curate). Always present: calendar links and schema.org offsets
	 * are built from it, and there is no zone it would be safe to assume. */
	timezone: z.string(),
	/** The Monday (YYYY-MM-DD) of the week rank.ts last scored, and the prompt
	 * version it scored under. Absent until rank has run. */
	ranked_at: z.string().optional(),
	rank_prompt_version: z.string().optional(),
	/** The Monday of the week geocode.ts last ran for. Absent until it has. */
	geocoded_at: z.string().optional(),
	events: z.array(EventDataSchema),
});
export type CityPayload = z.infer<typeof CityPayloadSchema>;
/** What the site reads from data/{city}.json. */
export type CityData = CityPayload;

export const CitySchema = z.object({
	key: z.string(),
	name: z.string(),
	week_start: z.string(),
	week_end: z.string(),
	event_count: z.number(),
	top_pick_count: z.number(),
});
export type City = z.infer<typeof CitySchema>;

/** The shape of data/index.json. */
export const CityIndexSchema = z.object({
	generated_at: z.string(),
	cities: z.array(CitySchema),
});
export type CityIndex = z.infer<typeof CityIndexSchema>;

export type VibeKey = "intellectual" | "creative" | "hands_on" | "social";
export type PastFilter = "no-past" | "all" | "only-past";

export interface DateRange {
	start: string;
	end: string;
}
