"""
Markdown generation — Step 2 of the digest pipeline.

Reads all data/*.json files (written by collection.py) and writes a
{CITY_KEY.upper()}.md for each at the repo root.

Run: python src/markdown.py   (no env vars needed)
"""

import json
from datetime import date
from pathlib import Path

from common import CATEGORY_EMOJI, TOP_PICK_THRESHOLD, fmt_date


def write_markdown(
    events: list[dict], monday: date, sunday: date, city_name: str, city_key: str
) -> Path:
    top_picks = [e for e in events if e.get("score", 0) >= TOP_PICK_THRESHOLD]
    remaining = [e for e in events if e.get("score", 0) < TOP_PICK_THRESHOLD]

    lines: list[str] = []

    lines.append(f"# {city_name} — This Week's Events")
    lines.append(f"**{fmt_date(monday)} – {fmt_date(sunday)}**  ")
    lines.append(f"*{len(top_picks)} top picks · {len(events)} events total*")
    lines.append("")

    if top_picks:
        lines.append("## ⭐ Top Picks")
        lines.append("")
        for e in top_picks:
            cat    = e.get("category", "Community / Other")
            emoji  = CATEGORY_EMOJI.get(cat, "📌")
            cost   = e.get("cost", "See link")
            cost_s = "Free" if cost.lower() == "free" else cost
            tags   = e.get("tags", [])
            link   = e.get("link", "")

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

    out_path = Path(__file__).parent.parent / f"{city_key.upper()}.md"
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"→ Written {out_path.name} ({len(events)} events)")
    return out_path


def main() -> None:
    data_dir = Path(__file__).parent.parent / "data"
    json_files = [f for f in sorted(data_dir.glob("*.json")) if f.name != "index.json"]

    if not json_files:
        raise SystemExit("✗ No city JSON files found in data/ — run collection.py first.")

    print("Markdown generation")
    print("=" * 50)

    for json_path in json_files:
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        events  = payload["events"]
        monday  = date.fromisoformat(payload["week_start"])
        sunday  = date.fromisoformat(payload["week_end"])
        write_markdown(
            events, monday, sunday,
            city_name=payload["city"],
            city_key=payload["city_key"],
        )

    print("✓ Markdown complete.")


if __name__ == "__main__":
    main()
