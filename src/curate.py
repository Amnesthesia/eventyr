"""
Events curation — Step 2 of the digest pipeline.

Reads each data/{city}/{provider}/raw/{tier}.json written by collection.py,
curates each independently with Haiku, then merges and deduplicates in pure
Python (difflib) to produce data/{city}.json.

Run:  CITY=brisbane ANTHROPIC_API_KEY=... python src/curate.py
Force re-run: FORCE=true CITY=brisbane ANTHROPIC_API_KEY=... python src/curate.py
"""

import difflib
import json
import os
import re
from datetime import date
from pathlib import Path

import anthropic

from common import (
    CATEGORIES,
    DATA_ROOT,
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
FORCE             = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
FORMAT_MODEL      = "claude-haiku-4-5-20251001"

_city_cfg = load_city_config(CITY)
CITY_NAME = _city_cfg["name"]

_PROJECT_ROOT = Path(__file__).parent.parent
_REFUSAL_RE   = re.compile(r"\bNO_EVENTS_FOUND\b")

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

FORMAT_SYSTEM = f"""You are a personal events curator for someone in {CITY_NAME} with these interests:
{INTERESTS}

The user will give you raw event listings from a single search source.

Your job:
1. FILTER: Remove any sports, MLM, sales-pitch, or clearly irrelevant events.
2. CURATE: For each remaining event, produce the following fields:
   - title:       event name (string)
   - datetime:    date and time as a short string, e.g. "Sat 14 Jun, 7:00 PM"
   - location:    venue name and/or suburb (string)
   - link:        direct URL to the event page (string; use "" if unknown)
   - category:    exactly one of {CATEGORIES}
   - cost:        "Free" or the price, e.g. "$25" (string)
   - source:      website or organisation name (string)
   - description: 1–2 sentences describing what the event actually is — what happens,
                  who runs it, what to expect. Be specific, not generic.
   - tags:        3–4 short lowercase topic tags reflecting subject matter, format, and cost,
                  e.g. ["philosophy", "lecture", "free"] or ["art", "workshop", "beginners"]
   - score:       integer 1–10 rating fit with the user's interests (10 = perfect match,
                  1 = barely relevant). Be honest — not everything deserves an 8.
   - datetime_iso: ISO 8601 start datetime, e.g. "2026-06-14T19:00:00". Use the event's
                  actual date and time. Date-only "YYYY-MM-DD" if no time is known.
                  Use "" if completely unknown.
   - datetime_end_iso: ISO 8601 end datetime, e.g. "2026-06-14T21:00:00". Use the event's
                  actual end date and time. Date-only "YYYY-MM-DD" if no time is known.
                  Use "" if completely unknown.
   - image:       direct URL to a preview/hero image for the event (e.g. from the event page
                  or venue website). Use "" if none is available. Must be a full https:// URL.

3. OUTPUT: A valid JSON array sorted by score descending. Include EVERY event that passes the filter — do not stop early or truncate the list. No markdown, no explanation, no code fences.

Example element:
{{
  "title": "Philosophy of Mind: AI and Consciousness",
  "datetime": "Mon 12 May, 7:00 PM",
  "location": "UQ St Lucia, Building 9",
  "link": "https://events.uq.edu.au/...",
  "category": "Public Lecture",
  "cost": "Free",
  "source": "UQ Events",
  "description": "UQ's Professor of Philosophy presents her latest research on consciousness and what AI can and cannot tell us about subjective experience — aimed at a general audience, followed by open Q&A.",
  "tags": ["philosophy", "ai", "lecture", "free"],
  "score": 9,
  "datetime_iso": "2026-05-12T19:00:00",
  "datetime_end_iso": "2026-05-12T21:00:00",
  "image": "https://events.uq.edu.au/images/philosophy-lecture.jpg"
}}"""


# ---------------------------------------------------------------------------
# Skip logic
# ---------------------------------------------------------------------------

def already_curated_this_week() -> bool:
    json_path = DATA_ROOT / f"{CITY}.json"
    if not json_path.exists():
        return False
    try:
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        monday, _ = get_week_range()
        return payload.get("week_start") == monday.isoformat()
    except (json.JSONDecodeError, KeyError):
        return False


# ---------------------------------------------------------------------------
# Curate a single raw file with Haiku
# ---------------------------------------------------------------------------

def _parse_events(raw_text: str, label: str) -> list[dict]:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    response = client.messages.create(
        model=FORMAT_MODEL,
        max_tokens=16000,
        system=FORMAT_SYSTEM,
        messages=[{"role": "user", "content": raw_text}],
    )

    if response.stop_reason == "max_tokens":
        print(f"  ⚠ [{label}] Curator response truncated — attempting partial recovery")

    raw = "".join(b.text for b in response.content if b.type == "text")
    raw = re.sub(r"```json|```", "", raw).strip()

    start = raw.find("[")
    if start == -1:
        print(f"  ✗ [{label}] No JSON array found in curator response")
        return []

    json_str = raw[start:]
    end = json_str.rfind("]")
    if end != -1:
        json_str = json_str[:end + 1]

    try:
        return json.loads(json_str)
    except json.JSONDecodeError:
        last_complete = json_str.rfind("},")
        if last_complete == -1:
            print(f"  ✗ [{label}] JSONDecodeError and no recovery point found")
            return []
        json_str = json_str[:last_complete + 1] + "]"
        try:
            events = json.loads(json_str)
            print(f"  ⚠ [{label}] Recovered {len(events)} events from truncated response")
            return events
        except json.JSONDecodeError:
            print(f"  ✗ [{label}] Could not recover from truncated JSON")
            return []


def curate_single_file(raw_file: Path) -> Path | None:
    payload = json.loads(raw_file.read_text(encoding="utf-8"))
    raw_text      = payload.get("raw_text", "")
    week_start_str = payload.get("week_start", "")
    week_end_str   = payload.get("week_end", "")

    # data/{city}/{provider}/raw/{tier}.json
    provider = raw_file.parent.parent.name
    tier     = raw_file.stem
    label    = f"{provider}/{tier}"

    out_path = DATA_ROOT / CITY / provider / "curated" / f"{tier}.json"

    if not FORCE and out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
            if existing.get("week_start") == week_start_str:
                print(f"  → [{label}] Already curated — skipping")
                return out_path
        except (json.JSONDecodeError, KeyError):
            pass

    if _REFUSAL_RE.search(raw_text):
        print(f"  ⚠ [{label}] Skipping — provider reported no events")
        return None
    if len(raw_text) < 200:
        print(f"  ⚠ [{label}] Skipping — too short ({len(raw_text)} chars)")
        return None

    print(f"→ Curating [{label}]…")
    events = _parse_events(raw_text, label)
    print(f"  → [{label}] {len(events)} events curated")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "city_key":   CITY,
        "provider":   provider,
        "tier":       tier,
        "week_start": week_start_str,
        "week_end":   week_end_str,
        "events":     events,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  → Written {out_path.relative_to(_PROJECT_ROOT)}")
    return out_path


# ---------------------------------------------------------------------------
# Merge + Python dedup
# ---------------------------------------------------------------------------

def _similar_title(a: str, b: str) -> bool:
    a, b = a.lower().strip(), b.lower().strip()
    return a == b or difflib.SequenceMatcher(None, a, b).ratio() > 0.85


def merge_and_deduplicate(monday: date) -> list[dict]:
    all_events: list[dict] = []
    city_dir = DATA_ROOT / CITY
    if not city_dir.exists():
        return []

    for curated_file in sorted(city_dir.glob("*/curated/*.json")):
        try:
            payload = json.loads(curated_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if payload.get("week_start") == monday.isoformat():
            all_events.extend(payload.get("events", []))

    # Highest score wins when deduplicating
    all_events.sort(key=lambda e: e.get("score", 0), reverse=True)

    unique: list[dict] = []
    for event in all_events:
        title = event.get("title", "")
        if not any(_similar_title(title, u["title"]) for u in unique):
            unique.append(event)

    return unique


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
    out_path = DATA_ROOT / f"{CITY}.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ Written {out_path.relative_to(_PROJECT_ROOT)} ({len(events)} events)")
    return out_path


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    if not FORCE and already_curated_this_week():
        print("→ Already curated for this week — skipping. Set FORCE=true to re-curate.")
        return

    monday, sunday = get_week_range()
    print(f"Curation — {CITY_NAME} — {fmt_date(monday)} to {fmt_date(sunday)}")
    print("=" * 50)

    city_dir  = DATA_ROOT / CITY
    raw_files = sorted(city_dir.glob("*/raw/*.json")) if city_dir.exists() else []
    if not raw_files:
        raise SystemExit("✗ No raw files found. Run collection.py for each tier first.")

    for raw_file in raw_files:
        curate_single_file(raw_file)

    print("→ Merging and deduplicating…")
    events = merge_and_deduplicate(monday)

    if not events:
        raise SystemExit("✗ No events found after merging curated files.")

    top = sum(1 for e in events if e.get("score", 0) >= TOP_PICK_THRESHOLD)
    print(f"→ {len(events)} events total, {top} top picks (score ≥ {TOP_PICK_THRESHOLD})")

    write_json(events, monday, sunday)
    print("✓ Curation complete.")


if __name__ == "__main__":
    main()
