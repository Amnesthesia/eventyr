"""
Events collection — Step 1 of the digest pipeline.

Searches one tier of event sources for a given city using the Claude API (with web
search) and writes a raw-text JSON file for that tier. Run three times in parallel
(one per tier); curate.py then combines and scores the results.

Run:
  CITY=brisbane ANTHROPIC_API_KEY=... python src/collection.py aggregators
  CITY=brisbane ANTHROPIC_API_KEY=... python src/collection.py institutions
  CITY=brisbane ANTHROPIC_API_KEY=... python src/collection.py independents

Force re-run:
  FORCE=true CITY=brisbane ANTHROPIC_API_KEY=... python src/collection.py aggregators
"""

import json
import os
import sys
from datetime import date
from pathlib import Path

import anthropic

from common import (
    CATEGORIES,
    fmt_date,
    get_week_range,
    load_city_config,
)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
CITY              = os.environ["CITY"]

TIER = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TIER", "")
if TIER not in ("aggregators", "institutions", "independents"):
    raise SystemExit(
        "Usage: collection.py <aggregators|institutions|independents>\n"
        "       (or set TIER env var)"
    )

SEARCH_MODEL     = "claude-sonnet-4-6"
MAX_WEB_SEARCHES = 12

_city_cfg = load_city_config(CITY)
CITY_NAME = _city_cfg["name"]
SOURCES   = _city_cfg["sources"][TIER]

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

_TIER_INSTRUCTIONS = {
    "aggregators": (
        "These sources often list the same events as each other. "
        f"Batch them into 1–2 broad `site:A OR site:B` queries — "
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


# ---------------------------------------------------------------------------
# Skip logic
# ---------------------------------------------------------------------------

def already_collected_this_week() -> bool:
    raw_path = Path(__file__).parent.parent / "data" / f"{CITY}_{TIER}_raw.json"
    if not raw_path.exists():
        return False
    try:
        payload = json.loads(raw_path.read_text(encoding="utf-8"))
        monday, _ = get_week_range()
        return payload.get("week_start") == monday.isoformat()
    except (json.JSONDecodeError, KeyError):
        return False


# ---------------------------------------------------------------------------
# Step 1: Search web for events (free-text output)
# ---------------------------------------------------------------------------

def build_search_prompt(monday: date, sunday: date) -> str:
    today = date.today()
    tier_instruction = _TIER_INSTRUCTIONS[TIER]
    source_list = "\n".join(f"  - {s}" for s in SOURCES)

    return f"""You are an events researcher for {CITY_NAME}. Today is {today.strftime('%A, %-d %B %Y')}.
Your job is to find in-person events happening THIS WEEK in {CITY_NAME}:
{fmt_date(monday)} to {fmt_date(sunday)}.

The person receiving this digest has the following interests:
{INTERESTS}

Sources to search ({TIER.upper()}):
{tier_instruction}

{source_list}

Search strategy — you have a budget of {MAX_WEB_SEARCHES} web searches, so use
`site:` operators and boolean OR to batch related sources. For example:
  site:eventbrite.com.au OR site:eventfinda.com.au Brisbane events {fmt_date(monday)} to {fmt_date(sunday)}

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
  - Aim for at least 15 events.
  - Include the direct URL for every event you list.
"""


def search_events(monday: date, sunday: date) -> str:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print(f"  → Searching {TIER} sources…")
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

    search_calls = sum(1 for b in response.content if b.type == "server_tool_use")
    print(f"  → [{TIER}] {search_calls} web search(es)")

    raw = "".join(b.text for b in response.content if b.type == "text")

    if len(raw) < 500:
        raise RuntimeError(
            f"[{TIER}] Search output too short ({len(raw)} chars) — model likely did not "
            "search the web. Check ANTHROPIC_API_KEY and web_search tool availability."
        )

    return raw


# ---------------------------------------------------------------------------
# Write data/{city}_{tier}_raw.json
# ---------------------------------------------------------------------------

def write_raw_json(raw_text: str, monday: date, sunday: date) -> Path:
    payload = {
        "city_key":   CITY,
        "tier":       TIER,
        "week_start": monday.isoformat(),
        "week_end":   sunday.isoformat(),
        "raw_text":   raw_text,
    }
    out_dir = Path(__file__).parent.parent / "data"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{CITY}_{TIER}_raw.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  → Written {out_path.name}")
    return out_path


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    force = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
    if not force and already_collected_this_week():
        print(f"  → [{TIER}] Already collected for this week — skipping. Set FORCE=true to re-collect.")
        return

    monday, sunday = get_week_range()
    print(f"[{TIER}] {CITY_NAME} — {fmt_date(monday)} to {fmt_date(sunday)}")

    raw_text = search_events(monday, sunday)
    write_raw_json(raw_text, monday, sunday)

    print(f"  ✓ [{TIER}] Collection complete.")


if __name__ == "__main__":
    main()
