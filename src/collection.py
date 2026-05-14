"""
Events collection — Step 1 of the digest pipeline.

Searches one tier of event sources using available providers (Anthropic and/or
Perplexity), writing a separate raw JSON file per provider. curate.py picks up
all matching *_raw.json files via glob.

Run in parallel (one per tier):
  CITY=brisbane python src/collection.py aggregators
  CITY=brisbane python src/collection.py institutions
  CITY=brisbane python src/collection.py independents
  CITY=brisbane python src/collection.py open   # Perplexity unconstrained only

Force re-run: FORCE=true CITY=brisbane python src/collection.py aggregators
"""

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic_ai
import perplexity_ai
from common import fmt_date, get_week_range, load_city_config

CITY = os.environ["CITY"]
TIER = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TIER", "")
VALID_TIERS = ("aggregators", "institutions", "independents", "open")
if TIER not in VALID_TIERS:
    raise SystemExit(
        "Usage: collection.py <aggregators|institutions|independents|open>\n"
        "       (or set TIER env var)"
    )

FORCE    = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
city_cfg = load_city_config(CITY)
monday, sunday = get_week_range()
DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)


def _already_collected(provider: str) -> bool:
    path = DATA_DIR / f"{CITY}_{TIER}_{provider}_raw.json"
    if not path.exists():
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload.get("week_start") == monday.isoformat()
    except (json.JSONDecodeError, KeyError):
        return False


def _write_raw(provider: str, raw_text: str) -> None:
    payload = {
        "city_key":   CITY,
        "tier":       TIER,
        "week_start": monday.isoformat(),
        "week_end":   sunday.isoformat(),
        "raw_text":   raw_text,
    }
    path = DATA_DIR / f"{CITY}_{TIER}_{provider}_raw.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  → Written {path.name}")


def _run_anthropic() -> None:
    if not FORCE and _already_collected("anthropic"):
        print(f"  → [anthropic/{TIER}] Already collected — skipping")
        return
    raw = anthropic_ai.search_events(city_cfg, TIER, monday, sunday)
    _write_raw("anthropic", raw)


def _run_perplexity() -> None:
    tier_arg = None if TIER == "open" else TIER
    if not FORCE and _already_collected("perplexity"):
        print(f"  → [perplexity/{TIER}] Already collected — skipping")
        return
    raw = perplexity_ai.search_events(city_cfg, tier_arg, monday, sunday)
    _write_raw("perplexity", raw)


def main() -> None:
    city_name = city_cfg["name"]
    print(f"[{TIER}] {city_name} — {fmt_date(monday)} to {fmt_date(sunday)}")

    if TIER == "open":
        if not os.environ.get("PERPLEXITY_API_KEY"):
            print("  → [open] PERPLEXITY_API_KEY not set — skipping open tier")
            return
        _run_perplexity()
    else:
        tasks = []
        if os.environ.get("ANTHROPIC_API_KEY"):
            tasks.append(_run_anthropic)
        if os.environ.get("PERPLEXITY_API_KEY"):
            tasks.append(_run_perplexity)
        if not tasks:
            raise SystemExit("✗ Neither ANTHROPIC_API_KEY nor PERPLEXITY_API_KEY is set.")
        if len(tasks) == 1:
            tasks[0]()
        else:
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(t) for t in tasks]
                for f in futures:
                    f.result()

    print(f"  ✓ [{TIER}] Collection complete.")


if __name__ == "__main__":
    main()
