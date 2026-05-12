"""
iCal generator — Step 3b of the digest pipeline.
Reads data/{city}.json and writes {city}.ics to the repo root.

Run: CITY=brisbane python src/ical.py
"""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path

from common import load_city_config


CITY = os.environ["CITY"]


def parse_dt(s: str):
    """Return (dtstart_str, dtend_str, is_allday) or (None, None, False) if unparseable."""
    if not s:
        return None, None, False
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            dt = datetime.strptime(s, fmt)
            start = dt.strftime("%Y%m%dT%H%M%S")
            end = (dt + timedelta(hours=2)).strftime("%Y%m%dT%H%M%S")
            return start, end, False
        except ValueError:
            pass
    try:
        d = datetime.strptime(s[:10], "%Y-%m-%d")
        return d.strftime("%Y%m%d"), None, True
    except ValueError:
        return None, None, False


def esc(s: str) -> str:
    return str(s).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def fold(line: str) -> str:
    out = []
    while len(line.encode("utf-8")) > 75:
        out.append(line[:75])
        line = " " + line[75:]
    out.append(line)
    return "\r\n".join(out)


def main() -> None:
    cfg = load_city_config(CITY)
    tz = cfg.get("timezone", "UTC")
    city_name = cfg["name"]

    data_path = Path(__file__).parent.parent / "data" / f"{CITY}.json"
    if not data_path.exists():
        raise SystemExit(f"✗ {data_path} not found. Run curate.py first.")

    payload = json.loads(data_path.read_text(encoding="utf-8"))
    events = payload.get("events", [])

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:-//do things//{CITY}//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        fold(f"X-WR-CALNAME:{city_name} — do things"),
        f"X-WR-TIMEZONE:{tz}",
    ]

    count = 0
    for i, ev in enumerate(events):
        start, end, allday = parse_dt(ev.get("datetime_iso", ""))
        if not start:
            continue
        if allday:
            dtstart = f"DTSTART;VALUE=DATE:{start}"
            dtend = f"DTEND;VALUE=DATE:{start}"
        else:
            dtstart = f"DTSTART;TZID={tz}:{start}"
            dtend = f"DTEND;TZID={tz}:{end}"
        lines += [
            "BEGIN:VEVENT",
            f"UID:{CITY}-{i}@dothings",
            dtstart,
            dtend,
            fold(f"SUMMARY:{esc(ev.get('title', ''))}"),
            fold(f"DESCRIPTION:{esc(ev.get('description', ''))}"),
            fold(f"LOCATION:{esc(ev.get('location', ''))}"),
            fold(f"URL:{ev.get('link', '')}"),
            "END:VEVENT",
        ]
        count += 1

    lines.append("END:VCALENDAR")
    out = Path(__file__).parent.parent / f"{CITY}.ics"
    out.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    print(f"→ Written {out.name} ({count} events)")


if __name__ == "__main__":
    main()
