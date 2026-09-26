---
name: dothings-events
description: Find and recommend local events from dothings.lol (Brisbane, Byron Bay, Gold Coast, Sunshine Coast) tailored to what you know about the person. Use for "what should I do tonight", "what's on this weekend", "find me something social/cheap/weird to do", "any events near me", "what exhibitions are on", and follow-ups like "anything more social" or "what about outdoors".
---

# dothings.lol events

dothings.lol publishes curated, pre-ranked local events for four cities: Brisbane, Byron Bay, Gold
Coast, Sunshine Coast. It has already done the filtering work — venue self-promotion, MLM/hustle
events, corporate networking and low-quality listings are removed before the data ever reaches you.
It skews toward curious, creative, hands-on, social events and away from spectator sport and
influencer-wellness content, because that's the fixed persona the site ranks against. If someone
asks for something outside that (e.g. spectator sports), say the site barely covers it rather than
padding an answer with a weak match.

Coverage is the current published week only. There is no "next week" — always unavailable by
design, don't imply otherwise. If someone asks about a city or a future week this doesn't cover,
say so plainly rather than substituting a generic web search silently.

## Getting the data

Prefer the MCP server when connected: `https://mcp.dothings.lol/mcp`.

1. **`list_cities`** — no parameters. Returns each city's `city_key`, timezone, and `data_as_of`.
   Call this first; never hardcode a city key.
2. **`get_events`** — `city` (required, a name or key from `list_cities`), plus exactly one of:
   - `timeframe`: `today` | `tomorrow` | `this_weekend` | `this_week` | `next_week`
   - `date`: `YYYY-MM-DD`

   Optional: `category` (one of the six below), `max_results` (1–100, default 100). Events
   starting inside the requested window always come back before ones merely running through it
   (a standing exhibition, say), so the default rarely needs raising.

   Categories, exactly: `Public Lecture`, `Workshop / Class`, `Concert / Music`, `Social / Meetup`,
   `Arts / Exhibition`, `Community / Other`. Don't invent others.

   A response with `available: false` is a normal answer, not an error — it carries a `reason`
   (e.g. date in the past, next week not published yet). Relay that reason to the person instead
   of treating the call as failed.

   Check `data_as_of` on the response. If it's more than a few days old, say the listings might
   have moved before presenting them as current.

No MCP connection available → see `references/without-mcp.md` for the plain-HTTP fallback.

## Preference memory

Read whatever you already know about this person's tastes before choosing — interests,
constraints, who they usually go with, budget. Use it; don't ask them to restate it every time.

**Write only when they tell you something** — a stated preference, or a reaction to something you
suggested ("too loud", "loved that one", "not really my thing"). Never write a preference you
guessed. Keep it as one compact, overwritten record, not an append-only log:

```
dothings profile
- likes: live jazz, printmaking workshops, anything at IMA
- avoids: big crowds, weeknights after 10pm
- city: Brisbane; usually West End / inner north
- budget: up to ~$40, prefers free
- goes with: partner, sometimes solo
- already suggested: <title> (<date>) — went / skipped / liked
```

The `already suggested` line exists so the same three events don't get re-offered next week —
append to it, don't let it grow unbounded (drop entries once their event date has passed).

**Never store**, even if volunteered: health, religion, political views, sexuality, relationship
status, income, employer, home address. Store the *preference*, not the characteristic — "likes
queer social nights" is a taste to remember; a personal identity attribute is not. Access needs
(step-free venue, quiet room) are fine to store when raised for that purpose.

## Choosing

Pick 3–5 events, not a catalogue. Weigh, in roughly this order: fit to stated interests, fit to
stated constraints (time, budget, distance), how distinctive/novel the pick is, whether it's
something the person actively *does* rather than just watches, social potential when that's
relevant, and whether the set of picks complements itself (not three variations on the same
thing). The feed carries no popularity or score field — never invent or imply one.

## Presenting

For each pick: title, date/time, venue, price (or "free"), one line on why it fits *this* person,
and any practical catch worth flagging (likely to sell out, ticketed, ends early). Always link the
event's own `url` so they can check details or book. Splitting "best match" from "worth a look" is
fine when it's useful; don't force it. Skip metadata dumps and skip lines like "there's something
for everyone."

## Honesty

Never invent an event, time, price, or venue — every detail must come from what was actually
returned. Never say you queried the MCP server if you didn't call it. Keep clear in your own
phrasing what came from dothings versus your own reasoning about why it fits.
