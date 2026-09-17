// Tool surface: deliberately just two tools. No third "plan_itinerary" tool —
// this server has no access to the calling assistant's knowledge of the
// user's preferences, so ranking/itinerary reasoning has to stay the calling
// model's job; the same recommendation text llms.txt gives static-fetch
// clients is instead baked into get_events' own description below, so the
// calling model gets it for free on every call rather than needing it
// pasted into a prompt.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES } from "../../../src/shared.ts";
import { cityTodayFor, fetchIndex, findCity } from "./dothingsClient.ts";
import { gatherEvents } from "./events.ts";
import { TIMEFRAMES } from "./resolveTimeframe.ts";

const RECOMMENDATION_GUIDANCE = `
Recommending events / planning an itinerary:
- Use what you already know about the person's interests, not a generic
  "popular events" list — this data has no personalization built in.
- For an itinerary: never suggest two events whose start/end overlap, allow
  realistic travel time between venues in different parts of the city, and
  don't overpack one evening — two or three well-chosen events beats a
  back-to-back schedule.
- Always link to the event's own url so the person can check details and buy
  tickets themselves.
- Never invent an event that is not in the returned list. If nothing fits,
  say so instead of padding the answer.
- Every file is already curated: venue promotion and low-quality listings are
  excluded before you ever see them, so a short or empty result is a real
  signal, not missing data.`.trim();

function textResult(value: unknown, isError = false) {
	return {
		isError,
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	};
}

export function registerTools(server: McpServer): void {
	server.registerTool(
		"list_cities",
		{
			title: "List cities",
			description:
				"List every city dothings.lol publishes curated local events for, " +
				"with each city's IANA timezone and the date its data was last refreshed. " +
				"Call this first to find the right `city` value for get_events.",
			inputSchema: {},
		},
		async () => {
			const index = await fetchIndex();
			return textResult({
				data_as_of: index.data_as_of,
				cities: index.cities.map((c) => ({
					city: c.city,
					city_key: c.city_key,
					timezone: c.timezone,
					data_as_of: c.data_as_of,
				})),
			});
		},
	);

	server.registerTool(
		"get_events",
		{
			title: "Get events",
			description:
				`Get curated local events for one city from dothings.lol. Pass exactly ` +
				`one of \`timeframe\` (for a relative ask like "today", "this weekend") ` +
				`or \`date\` (for a specific day the user names, e.g. "March 15th" -> ` +
				`"2026-03-15"). A date before today or past the currently published week ` +
				`comes back as a structured "not available" result, not an error — say so ` +
				`rather than guessing at other dates. "next_week" is always unavailable: ` +
				`this feed only ever publishes the current week.\n\n${RECOMMENDATION_GUIDANCE}`,
			inputSchema: {
				city: z
					.string()
					.describe('A city name or key from list_cities, e.g. "brisbane".'),
				timeframe: z
					.enum(TIMEFRAMES)
					.optional()
					.describe(
						"Relative timeframe: today | tomorrow | this_weekend | this_week | next_week.",
					),
				date: z
					.string()
					.optional()
					.describe(
						"A specific day as YYYY-MM-DD. Mutually exclusive with timeframe.",
					),
				category: z
					.enum(CATEGORIES)
					.optional()
					.describe("Restrict results to one category."),
				max_results: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Cap on returned events (default 30)."),
			},
		},
		async ({ city, timeframe, date, category, max_results }) => {
			if (Boolean(timeframe) === Boolean(date)) {
				return textResult(
					{ error: "Pass exactly one of `timeframe` or `date`." },
					true,
				);
			}

			const index = await fetchIndex();
			const entry = findCity(index, city);
			if (!entry) {
				return textResult(
					{
						error: `Unknown city "${city}".`,
						available_cities: index.cities.map((c) => c.city_key),
					},
					true,
				);
			}

			const cityToday = cityTodayFor(entry.timezone);
			const result = await gatherEvents(entry, cityToday, {
				timeframe,
				date,
				category,
				maxResults: max_results,
			});
			return textResult(result);
		},
	);
}
