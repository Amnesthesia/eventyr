"""
Shared constants and helpers used across collection, markdown, pages, and messaging modules.
"""

from datetime import date, timedelta
from pathlib import Path

import yaml


CATEGORIES = [
    "Public Lecture",
    "Workshop / Class",
    "Concert / Music",
    "Social / Meetup",
    "Arts / Exhibition",
    "Community / Other",
]

CATEGORY_EMOJI = {
    "Public Lecture":    "🎓",
    "Workshop / Class":  "🛠️",
    "Concert / Music":   "🎵",
    "Social / Meetup":   "🤝",
    "Arts / Exhibition": "🎨",
    "Community / Other": "📌",
}

TOP_PICK_THRESHOLD = 8


def get_week_range() -> tuple[date, date]:
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


def fmt_date(d: date) -> str:
    return d.strftime("%-d %B %Y")  # e.g. "12 May 2025"


def load_city_config(city: str) -> dict:
    sources_path = Path(__file__).parent.parent / "sources.yml"
    with open(sources_path) as f:
        all_sources = yaml.safe_load(f)
    if city not in all_sources:
        raise SystemExit(f"Unknown city '{city}'. Add it to sources.yml via src/add_city.py.")
    return all_sources[city]
