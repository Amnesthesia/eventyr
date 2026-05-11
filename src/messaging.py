"""
WhatsApp messaging — Step 4 (final) of the digest pipeline.

Reads data/{city}.json (written by collection.py) and sends the weekly
digest via WhatsApp Cloud API. Runs after the repo commit step so that
a messaging failure never prevents GitHub Pages from being updated.

Run: CITY=brisbane WHATSAPP_TOKEN=... WHATSAPP_PHONE_ID=... WHATSAPP_RECIPIENT=... python src/messaging.py
"""

import json
import os
from datetime import date
from pathlib import Path

import httpx

from common import CATEGORY_EMOJI, TOP_PICK_THRESHOLD, fmt_date


CITY      = os.environ["CITY"]
WA_TOKEN  = os.environ["WHATSAPP_TOKEN"]
WA_PHONE_ID = os.environ["WHATSAPP_PHONE_ID"]
WA_TO     = [n.strip() for n in os.environ["WHATSAPP_RECIPIENT"].split(",") if n.strip()]

MAX_CHARS = 4000  # WhatsApp hard limit is 4096; safe margin


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _tags_line(tags: list) -> str:
    return "  🏷 " + " · ".join(str(t) for t in tags[:6]) + "\n"


def _entry_top_pick(e: dict) -> str:
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
    if len(current) + len(entry) > MAX_CHARS:
        messages.append(current.strip())
        return continuation_header + entry
    return current + entry


def format_whatsapp(
    events: list[dict], monday: date, sunday: date, city_name: str
) -> list[str]:
    if not events:
        return [
            f"📅 *{city_name} This Week* ({fmt_date(monday)} – {fmt_date(sunday)})\n\n"
            "No events found this week. Check back next Monday!"
        ]

    top_picks = [e for e in events if e.get("score", 0) >= TOP_PICK_THRESHOLD]
    remaining = [e for e in events if e.get("score", 0) < TOP_PICK_THRESHOLD]

    messages: list[str] = []

    header = (
        f"📅 *{city_name} This Week*\n"
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
# WhatsApp Cloud API
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
    json_path = Path(__file__).parent.parent / "data" / f"{CITY}.json"
    if not json_path.exists():
        raise SystemExit(f"✗ {json_path} not found — run collection.py first.")

    payload   = json.loads(json_path.read_text(encoding="utf-8"))
    events    = payload["events"]
    monday    = date.fromisoformat(payload["week_start"])
    sunday    = date.fromisoformat(payload["week_end"])
    city_name = payload["city"]

    print(f"Messaging — {city_name} — {fmt_date(monday)} to {fmt_date(sunday)}")
    print("=" * 50)

    messages = format_whatsapp(events, monday, sunday, city_name)
    print(f"→ Digest split into {len(messages)} WhatsApp message(s)")
    print(f"→ Sending to {len(WA_TO)} recipient(s): {', '.join(WA_TO)}")

    for recipient in WA_TO:
        for i, msg in enumerate(messages, 1):
            print(f"→ [{recipient}] Sending message {i}/{len(messages)}…")
            send_whatsapp(msg, recipient)

    print("✓ Messaging complete.")


if __name__ == "__main__":
    main()
