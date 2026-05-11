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

SEARCH_MODEL = "claude-opus-4-7"           # thorough web search + reasoning
FORMAT_MODEL = "claude-haiku-4-5-20251001" # fast + cheap JSON formatting

SOURCES = [
    # --- Event directories ---
    "Brisbane City Council events (brisbane.qld.gov.au/whats-on)",
    "Visit Brisbane (visit.brisbane.qld.au/whats-on)",
    "Eventbrite Brisbane (eventbrite.com.au)",
    "Eventfinda Brisbane (brisbane.eventfinda.com.au)",
    "Must Do Brisbane (mustdobrisbane.com/whats-on)",
    "The Urban List Brisbane (theurbanlist.com/brisbane)",
    "Broadsheet Brisbane (broadsheet.com.au/brisbane)",
    "Fever Brisbane (feverup.com/en/brisbane)",
    "WeekendNotes Brisbane (weekendnotes.com/brisbane)",
    "Meetup Brisbane groups (meetup.com)",

    # --- Universities & libraries ---
    "Queensland State Library (slq.qld.gov.au)",
    "QUT public events (qut.edu.au/events)",
    "UQ public events (events.uq.edu.au)",
    "Griffith University events (griffith.edu.au/events)",

    # --- Major venues & institutions ---
    "Brisbane Powerhouse (brisbanepowerhouse.org)",
    "QAGOMA & Gallery of Modern Art events (qagoma.qld.gov.au/whats-on)",
    "QPAC (qpac.com.au/whats-on)",
    "Queensland Museum Brisbane (museum.qld.gov.au/brisbane/queensland-museum)",
    "Museum of Brisbane (museumofbrisbane.com.au/whats-on)",
    "Judith Wright Centre (judithwrightcentre.com)",
    "Institute of Modern Art Brisbane (ima.org.au)",
    "South Bank Parklands events (visitsouthbank.com.au)",
    "Queensland Theatre (queenslandtheatre.com.au/whats-on)",
    "La Boite Theatre (laboite.com.au/whats-on)",
    "Queensland Symphony Orchestra (qso.com.au/whats-on)",
    "Queensland Ballet (queenslandballet.com.au/whats-on)",

    # --- Cafes, bars & small venues ---
    "Avid Reader bookshop & café West End (avidreader.com.au/events)",
    "BY.ARTISANS West End (workshops, art classes, social events)",
    "Black Bear Lodge Fortitude Valley (blackbearlodge.bar)",
    "The Boundary Hotel West End (theboundary.com.au)",
    "Come to Daddy West End — drag, open mic, social events",
    "Lightspace gallery & events Fortitude Valley (lightspace.net.au)",
    "Archive bar West End — open mic nights",
    "Newmarket Hotel — open mic comedy",
    "John Mills Himself café events",
    "Echo & Bounce café events",

    # --- Community ---
    "Open Sessions Brisbane open mic circuit (theopensessions.com)",
    "Creative Mornings Brisbane (creativemornings.com/cities/bne)",
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
# Step 1: Search web for events (free-text output — no JSON constraint)
# ---------------------------------------------------------------------------

def build_search_prompt(monday: date, sunday: date) -> str:
    today = date.today()
    return f"""You are a Brisbane events researcher. Today is {today.strftime('%A, %-d %B %Y')}.
Your job is to find in-person events happening THIS WEEK in Brisbane, Queensland, Australia:
{fmt_date(monday)} to {fmt_date(sunday)}.

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

Rules:
  - Only include events within {fmt_date(monday)} – {fmt_date(sunday)}.
  - Skip online-only events unless hosted by a Brisbane organisation.
  - Aim for at least 20 events across different categories and suburbs.
  - Search multiple sources — don't stop after the first few results.
  - Include the direct URL for every event you list.
"""


def search_events(monday: date, sunday: date) -> tuple[str, int]:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print("→ Step 1: Searching web for Brisbane events…")
    response = client.messages.create(
        model=SEARCH_MODEL,
        max_tokens=8000,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 30}],
        system=build_search_prompt(monday, sunday),
        messages=[{
            "role": "user",
            "content": (
                f"Search for all Brisbane events this week ({fmt_date(monday)} to {fmt_date(sunday)}). "
                "Use web search on every source listed in your instructions. "
                "List every event you find with full details and a direct URL."
            )
        }],
    )

    search_calls = sum(1 for b in response.content if b.type == "tool_use")
    print(f"→ Agent performed {search_calls} web search(es)")

    raw = "".join(b.text for b in response.content if b.type == "text")
    return raw, search_calls


# ---------------------------------------------------------------------------
# Step 2: Format raw text into structured JSON (no web search needed)
# ---------------------------------------------------------------------------

FORMAT_SYSTEM = f"""You are a JSON formatter. The user will give you a list of Brisbane events described in free text.
Extract each event and return a valid JSON array. Each element must have exactly these fields:
  - title:    event name (string)
  - datetime: date and time as a short string, e.g. "Sat 14 Jun, 7:00 PM"
  - location: venue name and/or suburb (string)
  - link:     direct URL to the event page (string; use "" if unknown)
  - category: exactly one of {CATEGORIES}
  - cost:     "Free" or the price, e.g. "$25" (string)
  - source:   website or organisation name (string)

Output ONLY the JSON array — no markdown, no explanation, no code fences."""


def parse_events(raw_text: str) -> list[dict]:
    if not raw_text.strip():
        return []

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print("→ Step 2: Formatting events into JSON…")
    response = client.messages.create(
        model=FORMAT_MODEL,
        max_tokens=6000,
        system=FORMAT_SYSTEM,
        messages=[{
            "role": "user",
            "content": raw_text,
        }],
    )

    raw = "".join(b.text for b in response.content if b.type == "text")
    raw = re.sub(r"```json|```", "", raw).strip()

    match = re.search(r"\[[\s\S]*\]", raw)
    if not match:
        print("✗ No JSON array in formatter response. Raw output:")
        print(raw[:500])
        return []

    events = json.loads(match.group())
    print(f"→ Parsed {len(events)} events")
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


def format_whatsapp(events: list[dict], monday: date, sunday: date) -> list[str]:
    """
    Returns a list of WhatsApp message strings.
    WhatsApp messages have a ~4096 char limit; we split by category if needed.
    """
    if not events:
        return [f"📅 *Brisbane This Week* ({fmt_date(monday)} – {fmt_date(sunday)})\n\nNo events found this week. Check back next Monday!"]

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
    print(f"\n── Message preview ──\n{text}\n─────────────────────\n")

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
    print(f"→ WhatsApp API response: {r.status_code} — {r.text[:300]}")
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
