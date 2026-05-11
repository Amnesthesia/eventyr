"""
Events curation — Step 2 of the digest pipeline.

Reads the three raw-search JSON files written by collection.py (one per tier),
combines them, deduplicates, curates, and scores using Haiku, then writes
data/{city}.json as the source of truth for all downstream steps.

Run:  CITY=brisbane ANTHROPIC_API_KEY=... python src/curate.py
Force re-run: FORCE=true CITY=brisbane ANTHROPIC_API_KEY=... python src/curate.py
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

FORMAT_MODEL = "claude-haiku-4-5-20251001"

_city_cfg = load_city_config(CITY)
CITY_NAME = _city_cfg["name"]

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

FORMAT_SYSTEM = f"""You are a personal events curator for someone in Brisbane with these interests:
{INTERESTS}

The user will give you a combined list of Brisbane events from three source tiers
(AGGREGATORS, INSTITUTIONS, INDEPENDENTS). The same event may appear more than once
(especially from aggregators).

Your job:
1. DEDUPLICATE: For the same event appearing multiple times, keep only the entry
   with the most direct URL and best description.
2. FILTER: Remove any remaining sports, MLM, sales-pitch, or clearly irrelevant events.
3. CURATE: For each remaining event, produce the following fields:
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
   - image:       direct URL to a preview/hero image for the event (e.g. from the event page
                  or venue website). Use "" if none is available. Must be a full https:// URL.

4. OUTPUT: A valid JSON array sorted by score descending. No markdown, no explanation, no code fences.

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
  "image": "https://events.uq.edu.au/images/philosophy-lecture.jpg"
}}"""


# ---------------------------------------------------------------------------
# Skip logic
# ---------------------------------------------------------------------------

def already_curated_this_week() -> bool:
    json_path = Path(__file__).parent.parent / "data" / f"{CITY}.json"
    if not json_path.exists():
        return False
    try:
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        monday, _ = get_week_range()
        return payload.get("week_start") == monday.isoformat()
    except (json.JSONDecodeError, KeyError):
        return False


# ---------------------------------------------------------------------------
# Load and combine raw text from all three tier files
# ---------------------------------------------------------------------------

def load_raw_texts() -> tuple[str, date, date]:
    """Return (combined_raw_text, monday, sunday) from the tier raw files."""
    data_dir = Path(__file__).parent.parent / "data"
    monday, sunday = get_week_range()
    combined: list[str] = []

    for tier in ("aggregators", "institutions", "independents"):
        raw_path = data_dir / f"{CITY}_{tier}_raw.json"
        if not raw_path.exists():
            print(f"  ⚠ Missing {raw_path.name} — skipping tier")
            continue
        payload = json.loads(raw_path.read_text(encoding="utf-8"))
        combined.append(f"=== {tier.upper()} ===\n{payload['raw_text']}")

    if not combined:
        raise SystemExit("✗ No raw tier files found. Run collection.py for each tier first.")

    return "\n\n".join(combined), monday, sunday


# ---------------------------------------------------------------------------
# Curate, score, and format as JSON (Haiku)
# ---------------------------------------------------------------------------

def parse_events(raw_text: str) -> list[dict]:
    if not raw_text.strip():
        return []

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print("→ Curating and deduplicating events…")
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

    start = raw.find("[")
    if start == -1:
        print("✗ No JSON array found in curator response. Raw output:")
        print(raw[:500])
        return []

    json_str = raw[start:]
    end = json_str.rfind("]")
    if end != -1:
        json_str = json_str[:end + 1]

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
    force = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
    if not force and already_curated_this_week():
        print("→ Already curated for this week — skipping. Set FORCE=true to re-curate.")
        return

    monday, sunday = get_week_range()
    print(f"Curation — {CITY_NAME} — {fmt_date(monday)} to {fmt_date(sunday)}")
    print("=" * 50)

    raw_text, monday, sunday = load_raw_texts()
    events = parse_events(raw_text)
    write_json(events, monday, sunday)

    print("✓ Curation complete.")


if __name__ == "__main__":
    main()
