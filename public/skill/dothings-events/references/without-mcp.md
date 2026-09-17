# No MCP connection

Use this only when there's no MCP client available. Requires a "fetch a URL" / web browsing tool.

1. `GET https://www.dothings.lol/ai/index.json` — lists every city with its `city_key`, IANA
   timezone, `data_as_of`, and the exact day/week file URLs currently published for it.
2. Fetch the smallest file that answers the question:
   - today/tomorrow → the matching day file, `.../ai/{city_key}/{YYYY-MM-DD}.json`
   - this weekend → the Saturday and Sunday day files, merged (no separate weekend file)
   - this week → the week file, `.../ai/{city_key}/week-{YYYY-MM-DD}.json`; if it's split by
     category, `index.json` lists those under `week_categories` — fetch only the one that's needed
   - next week → not available; the site only ever publishes the current week
3. A ChatGPT Custom GPT Action can call `https://www.dothings.lol/ai/openapi.yaml` instead
   (operations `getIndex`, `getDayEvents`, `getWeekEvents`).

Full field reference (event shape, refresh schedule, itinerary rules) lives at
`https://www.dothings.lol/llms.txt` — read it before the first fetch rather than guessing field
names. The same principles from SKILL.md still apply: read memory before choosing, write only on a
stated signal, pick 3–5, never invent an event.

One gap this path doesn't have a fix for: a day file's own default ordering is whatever the source
JSON has it in, not sorted for "what's actually on today" the way the MCP server's `get_events` is.
Sort locally by `start` and prefer events whose `start` date matches the day requested before
falling back to ones that merely span it.
