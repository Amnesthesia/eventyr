"""
Brisbane Events Agent
---------------------
Searches Brisbane event sources using the Claude API (with web search),
formats the results, and sends them via WhatsApp Cloud API.

Run locally:  python src/agent.py
Run on CI:    triggered by GitHub Actions every Monday 8am AEST
"""

import os
import json
import re
import sys
from datetime import date, timedelta

import anthropic
import httpx


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
WA_TOKEN          = os.environ["WHATSAPP_TOKEN"]          # Meta permanent access token
WA_PHONE_ID       = os.environ["WHATSAPP_PHONE_ID"]       # Sending phone number ID
WA_TO             = os.environ["WHATSAPP_RECIPIENT"]      # Your number, e.g. 61412345678

MODEL = "claude-sonnet-4-20250514"

SOURCES = [
    "Queensland State Library (slq.qld.gov.au)",
    "Brisbane City Council events (brisbane.qld.gov.au/whats-on)",
    "Eventbrite Brisbane (eventbrite.com.au)",
    "Meetup Brisbane groups (meetup.com)",
    "QUT public events (qut.edu.au/events)",
    "UQ public events (events.uq.edu.au)",
    "Griffith University events (griffith.edu.au/events)",
    "John Mills Himself café events",
    "Echo & Bonce café events",
    "Brisbane Powerhouse (brisbanepowerhouse.org)",
    "QAGOMA events (qagoma.qld.gov.au)",
]

CATEGORIES = [
    "Public Lecture",
    "Workshop / Class",
    "Concert / Music",
    "Social / Meetup",
    "Arts / Exhibition",
    "Community / Other",
]


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
# Agent: search for events
# ---------------------------------------------------------------------------

def build_system_prompt(monday: date, sunday: date) -> str:
    today = date.today()
    return f"""You are a Brisbane events researcher. Today is {today.strftime('%A, %-d %B %Y')}.
You are searching for events happening THIS WEEK: {fmt_date(monday)} to {fmt_date(sunday)}.

Search each of these sources for social events, workshops, classes, public lectures,
local concerts, meetups, and community events in Brisbane, Queensland, Australia:

{chr(10).join(f"  {i+1}. {s}" for i, s in enumerate(SOURCES))}

For EACH event found, extract:
  - title:    event name
  - datetime: date and time (e.g. "Sat 14 Jun, 7:00 PM")
  - location: venue name and/or suburb in Brisbane
  - link:     direct URL to the event page (must be a real URL from search results)
  - category: exactly one of {CATEGORIES}
  - cost:     "Free" or the price (e.g. "$25")
  - source:   the website or organisation name

Rules:
  - Only include events that fall within {fmt_date(monday)} to {fmt_date(sunday)}.
  - Do not include online-only events unless they are hosted by a Brisbane organisation.
  - If cost is unclear, write "See link".
  - Search broadly — aim to find at least 15 events across different categories.
  - ONLY output a valid JSON array. No markdown, no explanation, no code fences.

Example output:
[
  {{
    "title": "Introduction to Watercolour",
    "datetime": "Sat 14 Jun, 10:00 AM",
    "location": "South Bank Community Centre",
    "link": "https://eventbrite.com.au/e/...",
    "category": "Workshop / Class",
    "cost": "$35",
    "source": "Eventbrite"
  }}
]"""


def fetch_events(monday: date, sunday: date) -> list[dict]:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print("→ Calling Claude agent with web search…")
    response = client.messages.create(
        model=MODEL,
        max_tokens=8000,
        tools=[{"type": "web_search_20250305", "name": "web_search"}],
        system=build_system_prompt(monday, sunday),
        messages=[{
            "role": "user",
            "content": (
                f"Find all Brisbane events this week ({fmt_date(monday)} to {fmt_date(sunday)}). "
                "Search all sources in your instructions thoroughly. Return only a JSON array."
            )
        }],
    )

    # Count searches performed
    search_calls = sum(1 for b in response.content if b.type == "tool_use")
    print(f"→ Agent performed {search_calls} web search(es)")

    # Extract text blocks
    raw = "".join(b.text for b in response.content if b.type == "text")

    # Strip any accidental markdown fences
    raw = re.sub(r"```json|```", "", raw).strip()

    # Find the JSON array
    match = re.search(r"\[[\s\S]*\]", raw)
    if not match:
        print("✗ No JSON array in response. Raw output:")
        print(raw[:500])
        return []

    events = json.loads(match.group())
    print(f"→ Parsed {len(events)} events")
    return events


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


def format_whatsapp(events: list[dict], monday: date, sunday: date) -> list[str]:
    """
    Returns a list of WhatsApp message strings.
    WhatsApp messages have a ~4096 char limit; we split by category if needed.
    """
    if not events:
        return [f"📅 *Brisbane This Week* ({fmt_date(monday)} – {fmt_date(sunday)})\n\nNo events found this week. Check back next Monday!"]

    # Group by category
    by_cat: dict[str, list[dict]] = {}
    for e in events:
        by_cat.setdefault(e.get("category", "Community / Other"), []).append(e)

    header = (
        f"📅 *Brisbane This Week*\n"
        f"{fmt_date(monday)} – {fmt_date(sunday)}\n"
        f"{len(events)} events found\n"
        f"{'─' * 28}"
    )

    messages = []
    current = header + "\n\n"

    for cat, cat_events in by_cat.items():
        emoji = CATEGORY_EMOJI.get(cat, "📌")
        section = f"*{emoji} {cat}*\n"

        for e in cat_events:
            cost_str = e.get("cost", "See link")
            cost_tag = "Free ✓" if cost_str.lower() == "free" else cost_str
            link = e.get("link", "")
            entry = (
                f"• *{e.get('title', 'Untitled')}*\n"
                f"  📆 {e.get('datetime', '—')}\n"
                f"  📍 {e.get('location', '—')}\n"
                f"  💰 {cost_tag}\n"
                f"  🔗 {link}\n\n"
            )
            section += entry

        # Split into a new message if this section would exceed 3800 chars
        if len(current) + len(section) > 3800:
            messages.append(current.strip())
            current = section
        else:
            current += section

    if current.strip():
        messages.append(current.strip())

    return messages


# ---------------------------------------------------------------------------
# Send via WhatsApp Cloud API
# ---------------------------------------------------------------------------

def send_whatsapp(text: str) -> None:
    url = f"https://graph.facebook.com/v19.0/{WA_PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": WA_TO,
        "type": "text",
        "text": {"body": text, "preview_url": False},
    }
    headers = {
        "Authorization": f"Bearer {WA_TOKEN}",
        "Content-Type": "application/json",
    }
    r = httpx.post(url, json=payload, headers=headers, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"WhatsApp API error {r.status_code}: {r.text}")
    print(f"→ WhatsApp message sent ({len(text)} chars)")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    monday, sunday = get_week_range()
    print(f"Brisbane Events Agent — {fmt_date(monday)} to {fmt_date(sunday)}")
    print("=" * 50)

    events = fetch_events(monday, sunday)

    messages = format_whatsapp(events, monday, sunday)
    print(f"→ Digest split into {len(messages)} WhatsApp message(s)")

    for i, msg in enumerate(messages, 1):
        print(f"→ Sending message {i}/{len(messages)}…")
        send_whatsapp(msg)

    print("✓ Done.")


if __name__ == "__main__":
    main()
