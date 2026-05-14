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

DATA_ROOT = Path(__file__).parent.parent / "data"


def raw_path(city: str, provider: str, tier: str) -> Path:
    return DATA_ROOT / city / provider / "raw" / f"{tier}.json"


def curated_path(city: str, provider: str, tier: str) -> Path:
    return DATA_ROOT / city / provider / "curated" / f"{tier}.json"


def get_week_range() -> tuple[date, date]:
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


def fmt_date(d: date) -> str:
    return d.strftime("%-d %B %Y")  # e.g. "12 May 2025"


def load_city_config(city: str) -> dict:
    sources_path = Path(__file__).parent.parent / "sources" / f"{city}.yml"
    if not sources_path.exists():
        raise SystemExit(f"Unknown city '{city}'. No file at {sources_path}. Run src/add_city.py to add it.")
    with open(sources_path) as f:
        return yaml.safe_load(f)
