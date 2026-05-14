"""
Google Gemini provider — event search and source discovery.
Called by collection.py and add_city.py.

Uses Google Search grounding for native web search.
"""

import json
import os
import re
from datetime import date

from google import genai
from google.genai import types

from common import fmt_date

SEARCH_MODEL    = "gemini-2.0-flash"
DISCOVERY_MODEL = "gemini-2.0-flash"

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


def _client() -> genai.Client:
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY not set")
    return genai.Client(api_key=api_key)


def _generate(system: str, prompt: str, max_output_tokens: int = 8000) -> str:
    response = _client().models.generate_content(
        model=SEARCH_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=system,
            tools=[types.Tool(google_search=types.GoogleSearch())],
            max_output_tokens=max_output_tokens,
        ),
    )
    return response.text or ""


def _names(sources: list[str]) -> str:
    """Extract readable names from source strings like 'Name (domain.com)'."""
    return ", ".join(s.split("(")[0].strip().rstrip("—").strip() for s in sources)


def _build_messages(
    city_name: str,
    tier: str | None,
    sources: list[str],
    week_start: date,
    week_end: date,
) -> tuple[str, str]:
    date_range = f"{fmt_date(week_start)} to {fmt_date(week_end)}"
    output_rules = (
        "For each event include: title, date and time, venue/location, "
        "direct URL to the event page, cost (Free or ticket price), organiser. "
        "Only include events with confirmed dates in that range. "
        "Skip spectator sports, MLM events, corporate sales pitches, and online-only events."
    )
    no_events_note = (
        "If you genuinely cannot find any relevant events after searching, "
        "respond only with: NO_EVENTS_FOUND"
    )

    if tier == "aggregators":
        names = _names(sources)
        return (
            f"You are an events researcher for {city_name}, Australia. "
            f"Find in-person events listed on event platforms for {date_range}. "
            f"{output_rules}",

            f"What events are on in {city_name} from {date_range}? "
            f"Search these event listing platforms: {names}. "
            f"List as many specific confirmed events as you can find. {no_events_note}",
        )

    if tier == "institutions":
        top_names = _names(sources[:8])
        return (
            f"You are an events researcher for {city_name}, Australia. "
            f"Find publicly announced in-person events at {city_name}'s cultural institutions for {date_range}. "
            "These venues publish individual event announcements, Eventbrite listings, and press releases — "
            "search for those rather than trying to navigate calendar pages. "
            f"{output_rules}",

            f"What events have been announced at {city_name} cultural venues for {date_range}? "
            f"Focus on theatres, galleries, museums, libraries, and universities. "
            f"Key venues include: {top_names}. "
            "Search for publicly announced performances, exhibitions, lectures, and public programmes. "
            f"List every event you find. {no_events_note}",
        )

    if tier == "independents":
        names = _names(sources)
        return (
            f"You are an events researcher for {city_name}, Australia. "
            f"Find events at small, independent venues and community groups for {date_range}. "
            "These niche venues rarely appear on aggregators. "
            "Search broadly for independent bookshops, small music venues, indie galleries, "
            "makerspaces, philosophy groups, language exchanges, community bars and cafes with events. "
            f"{output_rules}",

            f"What events are happening at small, independent {city_name} venues and community groups from {date_range}? "
            f"Known venues to check include: {names} — but also search for other independent venues and community events not on that list. "
            f"List every event you can find. {no_events_note}",
        )

    # open / unconstrained
    return (
        f"You are an events researcher for {city_name}, Australia. "
        f"Find in-person events for {date_range} matching these interests:\n{INTERESTS}\n"
        "Search Eventbrite, Meetup, Humanitix, venue websites, community platforms, Facebook Events, and local guides. "
        f"{output_rules}",

        f"What interesting in-person events are happening in {city_name} from {date_range}? "
        "Search broadly and focus on intellectually stimulating, creative, and community-oriented events. "
        f"List every relevant confirmed event with full details and a direct URL. {no_events_note}",
    )


def search_events(city_cfg: dict, tier: str | None, week_start: date, week_end: date) -> str:
    """Search for events using Gemini with Google Search grounding.

    tier=None runs an unconstrained interest-led search.
    tier="aggregators"|"institutions"|"independents" uses a strategy optimised for that source type.
    """
    city_name = city_cfg["name"]
    label = tier if tier else "open"
    sources = city_cfg["sources"].get(tier, []) if tier else []

    system_msg, user_msg = _build_messages(city_name, tier, sources, week_start, week_end)

    print(f"  [gemini/{label}] Searching…")
    raw = _generate(system_msg, user_msg)

    if _REFUSAL_RE.search(raw):
        raise RuntimeError(f"[gemini/{label}] Provider found no events")
    if len(raw) < 100:
        raise RuntimeError(f"[gemini/{label}] Response too short ({len(raw)} chars)")

    print(f"  [gemini/{label}] {len(raw)} chars received")
    return raw


def find_sources(city_name: str) -> dict:
    """Discover event sources for a city using Gemini. Returns tier dict."""
    system_msg = (
        f"You are helping set up an automated weekly events digest for {city_name}. "
        "Find the best websites for local in-person events and sort them into three tiers: "
        "AGGREGATORS (Eventbrite/Meetup-type platforms that index many events), "
        "INSTITUTIONS (universities, libraries, museums, galleries, theatres — each with unique programmes), "
        "INDEPENDENTS (small venues, bookshops, makerspaces, community groups rarely listed by aggregators). "
        'Return ONLY a JSON object: {"aggregators": [...], "institutions": [...], "independents": [...]}. '
        'Each entry format: "Source Name (domain.com)". No markdown, no explanation.'
    )
    user_msg = (
        f"Find the best event discovery sources in {city_name}. "
        "Search for current, active websites. "
        "Return JSON with aggregators, institutions, and independents arrays."
    )

    print(f"[gemini] Discovering event sources for {city_name}…")
    raw = _generate(system_msg, user_msg, max_output_tokens=4000)
    raw = re.sub(r"```json|```", "", raw).strip()
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise RuntimeError(
            f"[gemini] No JSON in source discovery response. Raw: {raw[:300]}"
        )

    sources = json.loads(match.group())
    for tier in ("aggregators", "institutions", "independents"):
        print(f"[gemini] Found {len(sources.get(tier, []))} {tier}")
    return sources
