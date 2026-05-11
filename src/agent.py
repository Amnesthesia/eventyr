"""
Events Digest Agent
--------------------
Searches event sources for a given city using the Claude API (with web search),
curates and scores results against user interests, then sends a weekly
digest via WhatsApp Cloud API.

Run locally:  CITY=brisbane ... python src/agent.py
Run on CI:    triggered by .github/workflows/brisbane-weekly.yml (or any city-specific workflow)
"""

import os
import json
import re
from datetime import date, timedelta
from pathlib import Path

import anthropic
import httpx
import yaml


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
WA_TOKEN          = os.environ["WHATSAPP_TOKEN"]          # Meta permanent access token
WA_PHONE_ID       = os.environ["WHATSAPP_PHONE_ID"]       # Sending phone number ID
WA_TO             = [n.strip() for n in os.environ["WHATSAPP_RECIPIENT"].split(",") if n.strip()]
CITY              = os.environ["CITY"]                    # City slug matching a key in sources.yml

SEARCH_MODEL = "claude-sonnet-4-6" # web search + reasoning
FORMAT_MODEL = "claude-haiku-4-5-20251001" # curation, scoring, description writing
MAX_WEB_SEARCHES = 30

# Load city config from sources.yml
_sources_path = Path(__file__).parent.parent / "sources.yml"
with open(_sources_path) as _f:
    _all_sources = yaml.safe_load(_f)

if CITY not in _all_sources:
    raise SystemExit(f"Unknown city '{CITY}'. Add it to sources.yml via src/add_city.py.")

_city_cfg  = _all_sources[CITY]
CITY_NAME  = _city_cfg["name"]
SOURCES    = _city_cfg["sources"]

CATEGORIES = [
    "Public Lecture",
    "Workshop / Class",
    "Concert / Music",
    "Social / Meetup",
    "Arts / Exhibition",
    "Community / Other",
]

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


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------

def get_week_range() -> tuple[date, date]:
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


def fmt_date(d: date) -> str:
    return d.strftime("%-d %B %Y")  # e.g. "12 May 2025"


# ---------------------------------------------------------------------------
# Step 1: Search web for events (free-text output — no JSON constraint)
# ---------------------------------------------------------------------------

def build_search_prompt(monday: date, sunday: date) -> str:
    today = date.today()
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

FORMAT_SYSTEM = f"""You are a personal events curator for someone in Brisbane with these interests:
{INTERESTS}

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
        # Truncation may have cut off the closing bracket — try to recover
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
        # Output was truncated mid-object — recover all complete objects
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
    top = sum(1 for e in events if e.get("score", 0) >= 8)
    print(f"→ {top} top picks (score ≥ 8)")
    return events


def fetch_events(monday: date, sunday: date) -> list[dict]:
    raw_text, _ = search_events(monday, sunday)
    return parse_events(raw_text)


# ---------------------------------------------------------------------------
# Format digest for WhatsApp
# ---------------------------------------------------------------------------

CATEGORY_EMOJI = {
    "Public Lecture":    "🎓",
    "Workshop / Class":  "🛠️",
    "Concert / Music":   "🎵",
    "Social / Meetup":   "🤝",
    "Arts / Exhibition": "🎨",
    "Community / Other": "📌",
}

TOP_PICK_THRESHOLD = 8
MAX_CHARS = 4000  # WhatsApp hard limit is 4096; leave a safe margin


def _tags_line(tags: list) -> str:
    return "  🏷 " + " · ".join(str(t) for t in tags[:6]) + "\n"


def _entry_top_pick(e: dict) -> str:
    """Full entry for a top-pick event: datetime, cost, location, tags, why, description, link."""
    cat    = e.get("category", "Community / Other")
    emoji  = CATEGORY_EMOJI.get(cat, "📌")
    cost   = e.get("cost", "See link")
    cost_s = "Free ✓" if cost.lower() == "free" else cost
    tags   = e.get("tags", [])
    desc   = e.get("description", "")

    s  = f"• *{e.get('title', 'Untitled')}*\n"
    s += f"  {emoji} {e.get('datetime', '—')}  ·  💰 {cost_s}\n"
    s += f"  📍 {e.get('location', '—')}\n"
    if tags:
        s += _tags_line(tags)
    if desc:
        s += f"  {desc}\n"
    s += f"  🔗 {e.get('link', '')}\n\n"
    return s


def _entry_full(e: dict) -> str:
    """Compact entry for the full list: datetime, cost, location, tags, description, link."""
    cost   = e.get("cost", "See link")
    cost_s = "Free ✓" if cost.lower() == "free" else cost
    tags   = e.get("tags", [])
    desc   = e.get("description", "")

    s  = f"• *{e.get('title', 'Untitled')}*\n"
    s += f"  📆 {e.get('datetime', '—')}  ·  💰 {cost_s}\n"
    s += f"  📍 {e.get('location', '—')}\n"
    if tags:
        s += _tags_line(tags)
    if desc:
        s += f"  {desc}\n"
    s += f"  🔗 {e.get('link', '')}\n\n"
    return s


def _append(messages: list[str], current: str, entry: str, continuation_header: str) -> str:
    """Append entry to current message, flushing to messages if it would exceed MAX_CHARS."""
    if len(current) + len(entry) > MAX_CHARS:
        messages.append(current.strip())
        return continuation_header + entry
    return current + entry


def format_whatsapp(events: list[dict], monday: date, sunday: date) -> list[str]:
    """
    Returns a list of WhatsApp messages, each ≤ MAX_CHARS.

    First message(s): ⭐ Top Picks (score ≥ 8), all of them, split across messages if needed.
    Remaining message(s): full event list grouped by category.
    """
    if not events:
        return [
            f"📅 *{CITY_NAME} This Week* ({fmt_date(monday)} – {fmt_date(sunday)})\n\n"
            "No events found this week. Check back next Monday!"
        ]

    top_picks = [e for e in events if e.get("score", 0) >= TOP_PICK_THRESHOLD]
    remaining = [e for e in events if e.get("score", 0) < TOP_PICK_THRESHOLD]

    messages: list[str] = []

    # ── Top picks (all of them, split at event boundaries) ───────────────────
    header = (
        f"📅 *{CITY_NAME} This Week*\n"
        f"{fmt_date(monday)} – {fmt_date(sunday)}\n"
        f"⭐ {len(top_picks)} top picks  ·  {len(events)} events found\n"
        f"{'─' * 28}\n\n"
        f"⭐ *TOP PICKS*\n\n"
    )
    current = header

    for e in top_picks:
        current = _append(messages, current, _entry_top_pick(e), "⭐ *TOP PICKS (cont.)*\n\n")

    if current.strip():
        messages.append(current.strip())

    # ── Full list (grouped by category, split at event boundaries) ───────────
    if not remaining:
        return messages

    by_cat: dict[str, list[dict]] = {}
    for e in remaining:
        by_cat.setdefault(e.get("category", "Community / Other"), []).append(e)

    current = "📋 *All Events This Week*\n\n"

    for cat, cat_events in by_cat.items():
        emoji      = CATEGORY_EMOJI.get(cat, "📌")
        cat_header = f"*{emoji} {cat}*\n"

        if len(current) + len(cat_header) > MAX_CHARS:
            messages.append(current.strip())
            current = cat_header
        else:
            current += cat_header

        for e in cat_events:
            current = _append(messages, current, _entry_full(e), "")

    if current.strip():
        messages.append(current.strip())

    return messages


# ---------------------------------------------------------------------------
# Write markdown file
# ---------------------------------------------------------------------------

def write_markdown(events: list[dict], monday: date, sunday: date) -> Path:
    top_picks = [e for e in events if e.get("score", 0) >= TOP_PICK_THRESHOLD]
    remaining = [e for e in events if e.get("score", 0) < TOP_PICK_THRESHOLD]

    lines: list[str] = []

    lines.append(f"# {CITY_NAME} — This Week's Events")
    lines.append(f"**{fmt_date(monday)} – {fmt_date(sunday)}**  ")
    lines.append(f"*{len(top_picks)} top picks · {len(events)} events total*")
    lines.append("")

    if top_picks:
        lines.append("## ⭐ Top Picks")
        lines.append("")
        for e in top_picks:
            cat   = e.get("category", "Community / Other")
            emoji = CATEGORY_EMOJI.get(cat, "📌")
            cost  = e.get("cost", "See link")
            cost_s = "Free" if cost.lower() == "free" else cost
            tags  = e.get("tags", [])
            link  = e.get("link", "")

            title = e.get("title", "Untitled")
            lines.append(f"### {emoji} [{title}]({link})" if link else f"### {emoji} {title}")
            lines.append(f"📆 {e.get('datetime', '—')}  ")
            lines.append(f"📍 {e.get('location', '—')}  ")
            lines.append(f"💰 {cost_s}  ")
            if tags:
                lines.append("`" + "` `".join(tags[:6]) + "`")
            if desc := e.get("description", ""):
                lines.append("")
                lines.append(desc)
            lines.append("")

    if remaining:
        by_cat: dict[str, list[dict]] = {}
        for e in remaining:
            by_cat.setdefault(e.get("category", "Community / Other"), []).append(e)

        lines.append("## 📋 All Events")
        lines.append("")
        for cat, cat_events in by_cat.items():
            emoji = CATEGORY_EMOJI.get(cat, "📌")
            lines.append(f"### {emoji} {cat}")
            lines.append("")
            for e in cat_events:
                cost   = e.get("cost", "See link")
                cost_s = "Free" if cost.lower() == "free" else cost
                tags   = e.get("tags", [])
                link   = e.get("link", "")

                title = e.get("title", "Untitled")
                lines.append(f"#### [{title}]({link})" if link else f"#### {title}")
                lines.append(f"📆 {e.get('datetime', '—')}")
                lines.append(f"📍 {e.get('location', '—')}")
                lines.append(f"💰 {cost_s}")
                if tags:
                    lines.append("`" + "` `".join(tags[:6]) + "`")
                if desc := e.get("description", ""):
                    lines.append("")
                    lines.append(desc)
                lines.append("")

    out_path = Path(__file__).parent.parent / f"{CITY.upper()}.md"
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"→ Written {out_path.name} ({len(events)} events)")
    return out_path


def write_json(events: list[dict], monday: date, sunday: date) -> Path:
    payload = {
        "city": CITY_NAME,
        "city_key": CITY,
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "generated_at": date.today().isoformat(),
        "events": events,
    }
    out_dir = Path(__file__).parent.parent / "data"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{CITY}.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ Written {out_path} ({len(events)} events)")
    return out_path


# ---------------------------------------------------------------------------
# Send via WhatsApp Cloud API
# ---------------------------------------------------------------------------

def send_whatsapp(text: str, recipient: str) -> None:
    print(f"\n── Message preview ──\n{text}\n─────────────────────\n")

    url = f"https://graph.facebook.com/v19.0/{WA_PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": recipient,
        "type": "text",
        "text": {"body": text, "preview_url": False},
    }
    headers = {
        "Authorization": f"Bearer {WA_TOKEN}",
        "Content-Type": "application/json",
    }
    r = httpx.post(url, json=payload, headers=headers, timeout=30)
    print(f"→ WhatsApp API response: {r.status_code} — {r.text[:300]}")
    if r.status_code != 200:
        raise RuntimeError(f"WhatsApp API error {r.status_code}: {r.text}")
    print(f"→ WhatsApp message sent ({len(text)} chars)")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    monday, sunday = get_week_range()
    print(f"Events Agent — {CITY_NAME} — {fmt_date(monday)} to {fmt_date(sunday)}")
    print("=" * 50)

    events = fetch_events(monday, sunday)

    write_markdown(events, monday, sunday)
    write_json(events, monday, sunday)

    messages = format_whatsapp(events, monday, sunday)
    print(f"→ Digest split into {len(messages)} WhatsApp message(s)")
    print(f"→ Sending to {len(WA_TO)} recipient(s): {', '.join(WA_TO)}")

    for recipient in WA_TO:
        for i, msg in enumerate(messages, 1):
            print(f"→ [{recipient}] Sending message {i}/{len(messages)}…")
            send_whatsapp(msg, recipient)

    print("✓ Done.")


if __name__ == "__main__":
    main()
