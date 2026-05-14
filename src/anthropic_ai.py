"""
Anthropic provider — event search and source discovery.
Called by collection.py and add_city.py.
"""

import json
import os
import re
from datetime import date

import anthropic

from common import CATEGORIES, fmt_date

SEARCH_MODEL     = "claude-sonnet-4-6"
DISCOVERY_MODEL  = "claude-opus-4-7"
MAX_WEB_SEARCHES = 12

_REFUSAL_RE = re.compile(r"\bNO_EVENTS_FOUND\b")

INTERESTS = """
WANT:
  - Intellectually stimulating talks, lectures, salons, workshops, panels, and debates focused on science, philosophy, psychology, technology, systems thinking, futurism, culture, design, history, AI, human behavior, or creativity
  - Events that attract curious, thoughtful, open-minded, creative, adventurous, or intellectually engaged people rather than purely corporate audiences
  - Community-oriented recurring events where people naturally talk before/after: book clubs, philosophy groups, writing circles, language exchanges, discussion salons, coworking socials, maker spaces, creative communities
  - Creative or hands-on workshops: photography, writing, pottery, drawing, music, woodworking, craft, electronics, robotics, fermentation, gardening, maker/hacker culture
  - Live experiences with strong atmosphere or artistic value: indie music, jazz, folk, intimate gigs, theatre (fringe, immersive, experimental, and mainstream), art exhibitions, experimental performances, film screenings, comedy nights and stand-up
  - Outdoor and adventure-oriented social events like hiking groups, trail running, climbing, scuba/freediving, paragliding, camping, adventure travel, nature excursions
  - Wellness-oriented events only if grounded and socially authentic: yoga, breathwork, meditation, sauna, movement workshops — avoid overly commercial or cult-like spirituality
  - Free or low-cost local community events preferred

PREFER:
  - Smaller events over massive crowds
  - Events where conversation between strangers is natural
  - Events with recurring communities or regular attendees
  - Authentic subcultures over polished corporate experiences
  - Mixed-age crowds with thoughtful or interesting people
  - Events that feel exploratory, creative, intellectually alive, or inspiring

SKIP ENTIRELY — do not include:
  - Spectator sports of any kind (rugby, cricket, football, racing, etc.)
  - Generic corporate networking events or recruitment / career expos
  - "Business opportunity" seminars, MLMs, hustle culture, crypto hype, or sales funnels
  - Ultra-touristy events designed mainly for Instagram/photos
  - Generic nightclub events or heavy drinking culture
  - Influencer-style wellness events with little substance
  - Online-only events unless strongly tied to the local community
"""

_TIER_INSTRUCTIONS = {
    "aggregators": (
        "These sources often list the same events as each other. "
        "Batch them into 1–2 broad `site:A OR site:B` queries — "
        "you do not need to search every source individually."
    ),
    "institutions": (
        "Each institution runs its own independent programme. "
        "Check every source. Batch by type where sensible "
        "(e.g. universities together, major venues together)."
    ),
    "independents": (
        "These are niche venues whose events rarely appear in aggregators. "
        "Check every source. Small `site:A OR site:B` batches are fine "
        "where sources are closely related, but don't skip any."
    ),
}


def search_events(city_cfg: dict, tier: str, week_start: date, week_end: date) -> str:
    """Search for events using Claude Sonnet with web search. Returns free-form event text."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    city_name = city_cfg["name"]
    sources = city_cfg["sources"][tier]
    tier_instruction = _TIER_INSTRUCTIONS[tier]
    source_list = "\n".join(f"  - {s}" for s in sources)
    today = date.today()

    system_prompt = f"""You are an events researcher for {city_name}. Today is {today.strftime('%A, %-d %B %Y')}.
Your job is to find in-person events happening THIS WEEK in {city_name}:
{fmt_date(week_start)} to {fmt_date(week_end)}.

The person receiving this digest has the following interests:
{INTERESTS}

Sources to search ({tier.upper()}):
{tier_instruction}

{source_list}

Search strategy — you have a budget of {MAX_WEB_SEARCHES} web searches, so use
`site:` operators and boolean OR to batch related sources. For example:
  site:eventbrite.com.au OR site:eventfinda.com.au Brisbane events {fmt_date(week_start)} to {fmt_date(week_end)}

For each event you find, note:
  - Event name
  - Date and time
  - Venue / location (suburb)
  - Ticket link or event page URL
  - Cost (free or price)
  - Category: one of {CATEGORIES}
  - Source website
  - Brief description of what the event is

Rules:
  - Only include events within {fmt_date(week_start)} – {fmt_date(week_end)}.
  - Apply the SKIP rules above — do not list sports, MLM, or sales-pitch events.
  - Aim for at least 15 events.
  - Include the direct URL for every event you list.
"""

    client = anthropic.Anthropic(api_key=api_key)
    print(f"  [anthropic] Searching {tier} sources…")
    response = client.messages.create(
        model=SEARCH_MODEL,
        max_tokens=8000,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": MAX_WEB_SEARCHES}],
        tool_choice={"type": "any"},
        system=system_prompt,
        messages=[{
            "role": "user",
            "content": (
                f"Search for {city_name} events this week ({fmt_date(week_start)} to {fmt_date(week_end)}). "
                "Use web search on the sources listed in your instructions. "
                "Skip anything matching the SKIP criteria. "
                "List every relevant event you find with full details and a direct URL. "
                "If you genuinely cannot find any relevant events after searching, respond only with: NO_EVENTS_FOUND"
            )
        }],
    )

    search_calls = sum(1 for b in response.content if b.type == "server_tool_use")
    print(f"  [anthropic/{tier}] {search_calls} web search(es)")

    raw = "".join(b.text for b in response.content if b.type == "text")
    if _REFUSAL_RE.search(raw):
        raise RuntimeError(f"[anthropic/{tier}] Provider found no events")
    if len(raw) < 100:
        raise RuntimeError(
            f"[anthropic/{tier}] Response too short ({len(raw)} chars) — "
            "model likely did not search the web."
        )
    return raw


def find_sources(city_name: str) -> dict:
    """Discover event sources for a city using Claude Opus. Returns tier dict."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    system_prompt = f"""You are helping set up an automated weekly events digest for {city_name}.

Find the best websites to search for local in-person events in this city and
sort them into three tiers:

AGGREGATORS — platforms that index events from many sources (duplicates across
  aggregators are expected). Examples: Eventbrite, Eventfinda, Meetup, Humanitix,
  local event guides (Broadsheet, Urban List, WeekendNotes, Must Do, Fever), tourism
  portals (Visit X), local community diary sites.

INSTITUTIONS — organisations that run their own independent event programmes; each
  has unique events not listed elsewhere. Examples: city/council events pages,
  state libraries, universities, major museums, galleries, concert halls, theatres,
  performing arts companies.

INDEPENDENTS — niche, community-facing venues and groups whose events rarely appear
  in aggregators. Examples: independent bookshops with events, small music venues,
  indie galleries, hackerspaces/makerspaces, board-game communities, philosophy
  groups, language exchange groups, creative spaces, bars/cafes with regular events.

Return ONLY a JSON object with exactly three keys: "aggregators", "institutions",
"independents". Each key maps to an array of source description strings in the format
"Source Name (url)" or "Source Name — description" if no URL is known.

Example shape:
{{
  "aggregators":  ["Eventbrite Sydney (eventbrite.com.au)", ...],
  "institutions": ["City of Sydney (cityofsydney.nsw.gov.au/events)", ...],
  "independents": ["Gleebooks bookshop events (gleebooks.com.au/events)", ...]
}}

No markdown, no explanation — just the JSON object."""

    client = anthropic.Anthropic(api_key=api_key)
    print(f"[anthropic] Discovering event sources for {city_name}…")
    response = client.messages.create(
        model=DISCOVERY_MODEL,
        max_tokens=4000,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 20}],
        system=system_prompt,
        messages=[{
            "role": "user",
            "content": (
                f"Find all the best event sources for {city_name}, sorted into the three "
                "tiers described in your instructions. Search the web to find accurate, "
                "current URLs. Return a JSON object with aggregators, institutions, and independents."
            )
        }],
    )

    searches = sum(1 for b in response.content if b.type == "server_tool_use")
    print(f"[anthropic] {searches} web search(es)")

    raw = "".join(b.text for b in response.content if b.type == "text")
    raw = re.sub(r"```json|```", "", raw).strip()
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise RuntimeError(
            f"[anthropic] No JSON in source discovery response. Raw: {raw[:300]}"
        )

    sources = json.loads(match.group())
    for tier in ("aggregators", "institutions", "independents"):
        print(f"[anthropic] Found {len(sources.get(tier, []))} {tier}")
    return sources
