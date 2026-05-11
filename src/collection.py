"""
Events collection — Step 1 of the digest pipeline.

Searches event sources for a given city using the Claude API (with web search),
curates and scores results, then writes data/{city}.json as the source of truth
for all downstream steps (markdown, pages, messaging).

Run: CITY=brisbane ANTHROPIC_API_KEY=... python src/collection.py
"""

import json
import os
import re
from datetime import date
from pathlib import Path

import anthropic

from common import (
    CATEGORIES,
    TOP_PICK_THRESHOLD,
    fmt_date,
    get_week_range,
    load_city_config,
)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
CITY              = os.environ["CITY"]

SEARCH_MODEL     = "claude-sonnet-4-6"
FORMAT_MODEL     = "claude-haiku-4-5-20251001"
MAX_WEB_SEARCHES = 30

_city_cfg = load_city_config(CITY)
CITY_NAME = _city_cfg["name"]
SOURCES   = _city_cfg["sources"]

INTERESTS = """
WANT:
  - Intellectually stimulating talks, lectures, panels, and debates (science, philosophy, tech, history, culture)
  - Creative workshops and classes (art, writing, music, craft)
  - Social events to meet interesting people (meetups, community dinners, book clubs, open mics)
  - Live music, comedy, theatre, and immersive art experiences

PREFER:
  - Smaller events over massive crowds
  - Creative or hands-on workshops
  - Events where conversation between strangers is natural
  - Events with recurring communities or regular attendees
  - Authentic subcultures over polished corporate experiences
  - Mixed-age crowds with thoughtful or interesting people
  - Events that feel exploratory, creative, intellectually alive, or inspiring

SKIP entirely — do not include:
  - Spectator sports of any kind (rugby, cricket, football, racing, etc.)
  - Any event involving a "business opportunity", network marketing, or multi-level marketing
  - Paid seminars that are actually sales pitches or upsell funnels
  - Corporate networking or recruitment events
  - Online-only events (unless hosted by a Brisbane organisation for a Brisbane audience)
  - Generic nightclub events or heavy drinking culture
  - Generic corporate networking events
  - Recruitment events or career expos
  - "Business opportunity" seminars, MLMs, hustle culture, crypto hype, or sales funnels
"""

INTERESTS_VERBOSE = """
WANT:
  - Intellectually stimulating talks, lectures, salons, workshops, panels, and debates focused on science, philosophy, psychology, technology, systems thinking, futurism, culture, design, history, AI, human behavior, or creativity
  - Events that attract curious, thoughtful, open-minded, creative, adventurous, or intellectually engaged people rather than purely corporate audiences
  - Community-oriented recurring events where people naturally talk before/after: book clubs, philosophy groups, writing circles, language exchanges, discussion salons, coworking socials, maker spaces, creative communities
  - Creative or hands-on workshops: photography, writing, pottery, drawing, music, woodworking, craft, electronics, robotics, fermentation, gardening, maker/hacker culture
  - Live experiences with strong atmosphere or artistic value: indie music, jazz, folk, intimate gigs, immersive theatre, art exhibitions, experimental performances, film screenings, comedy
  - Outdoor and adventure-oriented social events like hiking groups, trail running, climbing, scuba/freediving, paragliding, camping, adventure travel, nature excursions
  - Wellness-oriented events only if grounded and socially authentic: yoga, breathwork, meditation, sauna, movement workshops, but avoid overly commercial or cult-like spirituality
  - Free or low-cost local community events preferred

PREFER:
  - Smaller events over massive crowds
  - Events where conversation between strangers is natural
  - Events with recurring communities or regular attendees
  - Authentic subcultures over polished corporate experiences
  - Mixed-age crowds with thoughtful or interesting people
  - Events that feel exploratory, creative, intellectually alive, or inspiring

SKIP ENTIRELY - do not include:
  - Spectator sports of any kind
  - Generic corporate networking events
  - Recruitment events or career expos
  - "Business opportunity" seminars, MLMs, hustle culture, crypto hype, or sales funnels
  - Ultra-touristy events designed mainly for Instagram/photos
  - Generic nightclub events or heavy drinking culture
  - Influencer-style wellness events with little substance
  - Online-only events unless strongly tied to the Brisbane local community
"""

FORMAT_SYSTEM = f"""You are a personal events curator for someone in Brisbane with these interests:
{INTERESTS_VERBOSE}

The user will give you a list of Brisbane events described in free text from a web search.

Your job:
1. FILTER: Remove any remaining sports, MLM, sales-pitch, or duplicate events.
   For duplicates (same event from multiple sources), keep only the entry with the best direct URL.
2. CURATE: For each remaining event, produce the following fields:
   - title:       event name (string)
   - datetime:    date and time as a short string, e.g. "Sat 14 Jun, 7:00 PM"
   - location:    venue name and/or suburb (string)
   - link:        direct URL to the event page (string; use "" if unknown)
   - category:    exactly one of {CATEGORIES}
   - cost:        "Free" or the price, e.g. "$25" (string)
   - source:      website or organisation name (string)
   - description: 2–3 sentences describing what the event actually is — what happens,
                  who runs it, what to expect. Be specific, not generic.
   - tags:        3–6 short lowercase topic tags reflecting subject matter, format, and cost,
                  e.g. ["philosophy", "lecture", "free", "q&a"] or ["art", "workshop", "beginners"]
   - score:       integer 1–10 rating fit with the user's interests (10 = perfect match,
                  1 = barely relevant). Be honest — not everything deserves an 8.
   - why:         ONE concrete sentence on why THIS specific event is worth attending.
                  Be specific: mention the speaker, the format, the crowd, what makes it
                  stand out. Do NOT write generic phrases like "a great opportunity to learn".
   - image:       direct URL to a preview/hero image for the event (e.g. from the event page
                  or venue website). Use "" if none is available. Must be a full https:// URL.

3. OUTPUT: A valid JSON array sorted by score descending. No markdown, no explanation, no code fences.

Example element:
{{
  "title": "Philosophy of Mind: AI and Consciousness",
  "datetime": "Mon 12 May, 7:00 PM",
  "location": "UQ St Lucia, Building 9",
  "link": "https://events.uq.edu.au/...",
  "category": "Public Lecture",
  "cost": "Free",
  "source": "UQ Events",
  "description": "UQ's Professor of Philosophy presents her latest research on the hard problem of consciousness and what AI systems can and cannot tell us about subjective experience. Aimed at a general audience; no background in philosophy required. Followed by 30-minute open Q&A.",
  "tags": ["philosophy", "consciousness", "ai", "lecture", "free", "q&a"],
  "score": 9,
  "why": "One of UQ's leading philosophers speaking publicly on a genuinely hard topic — the Q&A format means you can actually engage with her.",
  "image": "https://events.uq.edu.au/images/philosophy-lecture.jpg"
}}"""


# ---------------------------------------------------------------------------
# Step 1: Search web for events (free-text output — no JSON constraint)
# ---------------------------------------------------------------------------

def build_search_prompt(monday: date, sunday: date) -> str:
    from datetime import date as _date
    today = _date.today()
    return f"""You are an events researcher for {CITY_NAME}. Today is {today.strftime('%A, %-d %B %Y')}.
Your job is to find in-person events happening THIS WEEK in {CITY_NAME}:
{fmt_date(monday)} to {fmt_date(sunday)}.

The person receiving this digest has the following interests:
{INTERESTS}

Search these sources thoroughly using web search:

{chr(10).join(f"  {i+1}. {s}" for i, s in enumerate(SOURCES))}

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
  - Only include events within {fmt_date(monday)} – {fmt_date(sunday)}.
  - Apply the SKIP rules above — do not list sports, MLM, or sales-pitch events.
  - Aim for at least 20 events across different categories and suburbs.
  - Search multiple sources — don't stop after the first few results.
  - Include the direct URL for every event you list.
"""


def search_events(monday: date, sunday: date) -> tuple[str, int]:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print(f"→ Step 1: Searching web for {CITY_NAME} events…")
    response = client.messages.create(
        model=SEARCH_MODEL,
        max_tokens=8000,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": MAX_WEB_SEARCHES}],
        tool_choice={"type": "any"},
        system=build_search_prompt(monday, sunday),
        messages=[{
            "role": "user",
            "content": (
                f"Search for {CITY_NAME} events this week ({fmt_date(monday)} to {fmt_date(sunday)}). "
                "Use web search on the sources listed in your instructions. "
                "Skip anything matching the SKIP criteria. "
                "List every relevant event you find with full details and a direct URL."
            )
        }],
    )

    search_calls = sum(1 for b in response.content if b.type == "tool_use")
    print(f"→ Agent performed {search_calls} web search(es)")

    raw = "".join(b.text for b in response.content if b.type == "text")
    return raw, search_calls


# ---------------------------------------------------------------------------
# Step 2: Curate, score, enrich, and format as JSON
# ---------------------------------------------------------------------------

def parse_events(raw_text: str) -> list[dict]:
    if not raw_text.strip():
        return []

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print("→ Step 2: Curating and enriching events…")
    response = client.messages.create(
        model=FORMAT_MODEL,
        max_tokens=8192,
        system=FORMAT_SYSTEM,
        messages=[{
            "role": "user",
            "content": raw_text,
        }],
    )

    if response.stop_reason == "max_tokens":
        print("⚠ Curator response was truncated — will attempt partial recovery")

    raw = "".join(b.text for b in response.content if b.type == "text")
    raw = re.sub(r"```json|```", "", raw).strip()

    match = re.search(r"\[[\s\S]*\]", raw)
    if not match:
        start = raw.find("[")
        if start != -1:
            match = re.search(r"\[[\s\S]*", raw[start:])
            raw = raw[start:]
        if not match:
            print("✗ No JSON array found in curator response. Raw output:")
            print(raw[:500])
            return []

    json_str = match.group()
    try:
        events = json.loads(json_str)
    except json.JSONDecodeError:
        last_complete = json_str.rfind("},")
        if last_complete == -1:
            print("✗ JSONDecodeError and no recovery point found")
            return []
        json_str = json_str[:last_complete + 1] + "]"
        try:
            events = json.loads(json_str)
            print(f"⚠ Recovered {len(events)} events from truncated response")
        except json.JSONDecodeError:
            print("✗ Could not recover from truncated JSON")
            return []

    print(f"→ {len(events)} events after curation")
    top = sum(1 for e in events if e.get("score", 0) >= TOP_PICK_THRESHOLD)
    print(f"→ {top} top picks (score ≥ {TOP_PICK_THRESHOLD})")
    return events


def fetch_events(monday: date, sunday: date) -> list[dict]:
    raw_text, _ = search_events(monday, sunday)
    return parse_events(raw_text)


# ---------------------------------------------------------------------------
# Write data/{city}.json — source of truth for all downstream steps
# ---------------------------------------------------------------------------

def write_json(events: list[dict], monday: date, sunday: date) -> Path:
    payload = {
        "city":         CITY_NAME,
        "city_key":     CITY,
        "week_start":   monday.isoformat(),
        "week_end":     sunday.isoformat(),
        "generated_at": date.today().isoformat(),
        "events":       events,
    }
    out_dir = Path(__file__).parent.parent / "data"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{CITY}.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ Written {out_path} ({len(events)} events)")
    return out_path


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    monday, sunday = get_week_range()
    print(f"Collection — {CITY_NAME} — {fmt_date(monday)} to {fmt_date(sunday)}")
    print("=" * 50)

    events = fetch_events(monday, sunday)
    write_json(events, monday, sunday)

    print("✓ Collection complete.")


if __name__ == "__main__":
    main()
