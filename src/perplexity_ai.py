"""
Perplexity provider — event search and source discovery.
Called by collection.py and add_city.py.

Uses the OpenAI SDK pointed at Perplexity's API (they are compatible).
Sonar models include native web search — no tool configuration needed.
"""

import json
import os
import re
from datetime import date

from openai import OpenAI

from common import fmt_date

SEARCH_MODEL        = "sonar"
DISCOVERY_MODEL     = "sonar-pro"
PERPLEXITY_BASE_URL = "https://api.perplexity.ai"

INTERESTS = """
WANT:
  - Intellectually stimulating talks, lectures, salons, workshops, panels, and debates focused on science, philosophy, psychology, technology, systems thinking, futurism, culture, design, history, AI, human behavior, or creativity
  - Events that attract curious, thoughtful, open-minded, creative, adventurous, or intellectually engaged people rather than purely corporate audiences
  - Community-oriented recurring events where people naturally talk before/after: book clubs, philosophy groups, writing circles, language exchanges, discussion salons, coworking socials, maker spaces, creative communities
  - Creative or hands-on workshops: photography, writing, pottery, drawing, music, woodworking, craft, electronics, robotics, fermentation, gardening, maker/hacker culture
  - Live experiences with strong atmosphere or artistic value: indie music, jazz, folk, intimate gigs, immersive theatre, art exhibitions, experimental performances, film screenings, comedy
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


def _client() -> OpenAI:
    api_key = os.environ.get("PERPLEXITY_API_KEY")
    if not api_key:
        raise RuntimeError("PERPLEXITY_API_KEY not set")
    return OpenAI(api_key=api_key, base_url=PERPLEXITY_BASE_URL)


def search_events(city_cfg: dict, tier: str | None, week_start: date, week_end: date) -> str:
    """Search for events using Perplexity Sonar.

    tier=None runs an unconstrained open-web search.
    tier="aggregators" etc. focuses the search on that tier's known sources.
    """
    city_name = city_cfg["name"]
    label = tier if tier else "open"

    if tier is not None:
        sources = city_cfg["sources"][tier]
        source_list = ", ".join(sources)
        system_msg = (
            f"You are an events researcher for {city_name}. "
            f"Find in-person events from {fmt_date(week_start)} to {fmt_date(week_end)}. "
            f"Search these specific sources: {source_list}. "
            "For each event list: event name, date and time, venue/location, direct URL, "
            "cost (Free or price), organiser/source website. "
            "Skip spectator sports, MLM events, corporate sales pitches, and online-only events."
        )
        user_msg = (
            f"Find events in {city_name} from {fmt_date(week_start)} to {fmt_date(week_end)} "
            f"by searching: {source_list}. "
            "List every event you find with full details and a direct URL."
        )
    else:
        system_msg = (
            f"You are an events researcher for {city_name}. "
            f"Find in-person events from {fmt_date(week_start)} to {fmt_date(week_end)} "
            f"matching these interests:\n{INTERESTS}\n"
            "Search broadly: event listing sites, venue websites, community platforms, local guides. "
            "For each event list: event name, date and time, venue/location, direct URL, "
            "cost (Free or price), organiser/source. "
            "Skip spectator sports, MLM events, corporate sales pitches, and online-only events."
        )
        user_msg = (
            f"What interesting events are happening in {city_name} from "
            f"{fmt_date(week_start)} to {fmt_date(week_end)}? "
            "Search broadly and list every relevant event with full details and a direct URL."
        )

    print(f"  [perplexity/{label}] Searching…")
    response = _client().chat.completions.create(
        model=SEARCH_MODEL,
        max_tokens=8000,
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
    )

    raw = response.choices[0].message.content or ""
    if len(raw) < 200:
        raise RuntimeError(
            f"[perplexity/{label}] Response too short ({len(raw)} chars)."
        )
    print(f"  [perplexity/{label}] {len(raw)} chars received")
    return raw


def find_sources(city_name: str) -> dict:
    """Discover event sources for a city using Perplexity sonar-pro. Returns tier dict."""
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

    print(f"[perplexity] Discovering event sources for {city_name}…")
    response = _client().chat.completions.create(
        model=DISCOVERY_MODEL,
        max_tokens=4000,
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
    )

    raw = response.choices[0].message.content or ""
    raw = re.sub(r"```json|```", "", raw).strip()
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise RuntimeError(
            f"[perplexity] No JSON in source discovery response. Raw: {raw[:300]}"
        )

    sources = json.loads(match.group())
    for tier in ("aggregators", "institutions", "independents"):
        print(f"[perplexity] Found {len(sources.get(tier, []))} {tier}")
    return sources
