"""
GitHub Pages index — Step 3 of the digest pipeline.

Reads all data/*.json files (written by collection.py) and writes
data/index.json — a manifest of every available city with its latest
week range and event counts. Used by index.html for a city selector.

Run: python src/pages.py   (no env vars needed)
"""

import json
from datetime import date
from pathlib import Path

from common import TOP_PICK_THRESHOLD


def main() -> None:
    data_dir = Path(__file__).parent.parent / "data"
    data_dir.mkdir(exist_ok=True)

    cities = []
    for f in sorted(data_dir.glob("*.json")):
        if f.name == "index.json":
            continue
        if "_raw.json" in f.name:
            continue
        try:
            payload = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, KeyError):
            print(f"⚠ Skipping {f.name} — could not parse")
            continue

        cities.append({
            "key":            payload["city_key"],
            "name":           payload["city"],
            "week_start":     payload["week_start"],
            "week_end":       payload["week_end"],
            "event_count":    len(payload["events"]),
            "top_pick_count": sum(
                1 for e in payload["events"]
                if e.get("score", 0) >= TOP_PICK_THRESHOLD
            ),
        })

    index = {
        "generated_at": date.today().isoformat(),
        "cities": cities,
    }

    out_path = data_dir / "index.json"
    out_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ Written {out_path} ({len(cities)} city/cities)")
    print("✓ Pages index complete.")


if __name__ == "__main__":
    main()
