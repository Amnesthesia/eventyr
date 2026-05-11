"""
Brisbane Events Agent
---------------------
Searches Brisbane event sources using the Claude API (with web search),
curates and scores results against user interests, then sends a weekly
digest via WhatsApp Cloud API.

Run locally:  python src/agent.py
Run on CI:    triggered by GitHub Actions every Monday 8am AEST
"""

import os
import json
import re
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

SEARCH_MODEL = "claude-opus-4-7"   # thorough web search + reasoning
FORMAT_MODEL = "claude-sonnet-4-6" # curation, scoring, description writing

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

INTERESTS = """
WANT:
  - Intellectually stimulating talks, lectures, panels, and debates (science, philosophy, tech, history, culture)
  - Creative workshops and classes (art, writing, music, craft)
  - Social events to meet interesting people (meetups, community dinners, book clubs, open mics)
  - Live music, comedy, theatre, and immersive art experiences
  - Free or low-cost community events

SKIP entirely — do not include:
  - Spectator sports of any kind (rugby, cricket, football, racing, etc.)
  - Any event involving a "business opportunity", network marketing, or multi-level marketing
  - Paid seminars that are actually sales pitches or upsell funnels
  - Corporate networking or recruitment events
  - Online-only events (unless hosted by a Brisbane organisation for a Brisbane audience)
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
    return f"""You are a Brisbane events researcher. Today is {today.strftime('%A, %-d %B %Y')}.
Your job is to find in-person events happening THIS WEEK in Brisbane, Queensland, Australia:
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

    print("→ Step 1: Searching web for Brisbane events…")
    response = client.messages.create(
        model=SEARCH_MODEL,
        max_tokens=8000,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 30}],
        system=build_search_prompt(monday, sunday),
        messages=[{
            "role": "user",
            "content": (
                f"Search for Brisbane events this week ({fmt_date(monday)} to {fmt_date(sunday)}). "
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
  "why": "One of UQ's leading philosophers speaking publicly on a genuinely hard topic — the Q&A format means you can actually engage with her."
}}"""


def parse_events(raw_text: str) -> list[dict]:
    if not raw_text.strip():
        return []

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print("→ Step 2: Curating and enriching events…")
    response = client.messages.create(
        model=FORMAT_MODEL,
        max_tokens=8000,
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
        print("✗ No JSON array in curator response. Raw output:")
        print(raw[:500])
        return []

    events = json.loads(match.group())
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
MAX_TOP_PICKS = 6


def _fmt_tags(tags: list) -> str:
    return "  🏷 " + " · ".join(str(t) for t in tags[:6])


def format_whatsapp(events: list[dict], monday: date, sunday: date) -> list[str]:
    """
    Returns a list of WhatsApp message strings (≤ 4096 chars each).

    Message 1: header + top picks (score ≥ 8) with full detail including why + description
    Message 2+: remaining events grouped by category with description + tags
    """
    if not events:
        return [
            f"📅 *Brisbane This Week* ({fmt_date(monday)} – {fmt_date(sunday)})\n\n"
            "No events found this week. Check back next Monday!"
        ]

    top_picks   = [e for e in events if e.get("score", 0) >= TOP_PICK_THRESHOLD][:MAX_TOP_PICKS]
    top_ids     = {id(e) for e in top_picks}
    remaining   = [e for e in events if id(e) not in top_ids]

    # ── Message 1: Top Picks ──────────────────────────────────────────────────
    header = (
        f"📅 *Brisbane This Week*\n"
        f"{fmt_date(monday)} – {fmt_date(sunday)}\n"
        f"⭐ {len(top_picks)} top picks  ·  {len(events)} events found\n"
        f"{'─' * 28}"
    )

    msg1 = header + "\n\n"

    if top_picks:
        msg1 += "⭐ *TOP PICKS*\n\n"
        for e in top_picks:
            cat    = e.get("category", "Community / Other")
            emoji  = CATEGORY_EMOJI.get(cat, "📌")
            cost   = e.get("cost", "See link")
            cost_s = "Free ✓" if cost.lower() == "free" else cost
            tags   = e.get("tags", [])
            desc   = e.get("description", "")
            why    = e.get("why", "")

            entry = (
                f"• *{e.get('title', 'Untitled')}*\n"
                f"  {emoji} {e.get('datetime', '—')}  ·  {e.get('location', '—')}  ·  {cost_s}\n"
            )
            if tags:
                entry += _fmt_tags(tags) + "\n"
            if desc:
                entry += f"  {desc}\n"
            if why:
                entry += f"  💡 _{why}_\n"
            entry += f"  🔗 {e.get('link', '')}\n\n"

            msg1 += entry

    messages = [msg1.strip()]

    # ── Message 2+: Remaining events by category ──────────────────────────────
    if not remaining:
        return messages

    by_cat: dict[str, list[dict]] = {}
    for e in remaining:
        by_cat.setdefault(e.get("category", "Community / Other"), []).append(e)

    current = "📋 *All Events This Week*\n\n"

    for cat, cat_events in by_cat.items():
        emoji   = CATEGORY_EMOJI.get(cat, "📌")
        section = f"*{emoji} {cat}*\n"

        for e in cat_events:
            cost   = e.get("cost", "See link")
            cost_s = "Free ✓" if cost.lower() == "free" else cost
            tags   = e.get("tags", [])
            desc   = e.get("description", "")

            entry = (
                f"• *{e.get('title', 'Untitled')}*\n"
                f"  📆 {e.get('datetime', '—')}  ·  📍 {e.get('location', '—')}  ·  💰 {cost_s}\n"
            )
            if tags:
                entry += _fmt_tags(tags) + "\n"
            if desc:
                entry += f"  {desc}\n"
            entry += f"  🔗 {e.get('link', '')}\n\n"

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
