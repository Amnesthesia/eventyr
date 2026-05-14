"""
Events collection — Step 1 of the digest pipeline.

Searches one tier of event sources using available providers, writing a
separate raw JSON file per provider under data/{city}/{provider}/raw/.
curate.py picks up all files via glob.

Run in parallel (one per tier):
  CITY=brisbane python src/collection.py aggregators
  CITY=brisbane python src/collection.py institutions
  CITY=brisbane python src/collection.py independents
  CITY=brisbane python src/collection.py open

Force re-run: FORCE=true CITY=brisbane python src/collection.py aggregators
"""

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic_ai
import gemini_ai
import perplexity_ai
from common import fmt_date, get_week_range, load_city_config, raw_path

CITY = os.environ["CITY"]
TIER = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TIER", "")
VALID_TIERS = ("aggregators", "institutions", "independents", "open")
if TIER not in VALID_TIERS:
    raise SystemExit(
        "Usage: collection.py <aggregators|institutions|independents|open>\n"
        "       (or set TIER env var)"
    )

FORCE     = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
city_cfg  = load_city_config(CITY)
monday, sunday = get_week_range()

_PROJECT_ROOT = Path(__file__).parent.parent


def _already_collected(provider: str) -> bool:
    path = raw_path(CITY, provider, TIER)
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
    path = raw_path(CITY, provider, TIER)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  → Written {path.relative_to(_PROJECT_ROOT)}")


def _run_anthropic() -> None:
    if not FORCE and _already_collected("anthropic"):
        print(f"  → [anthropic/{TIER}] Already collected — skipping")
        return
    try:
        raw = anthropic_ai.search_events(city_cfg, TIER, monday, sunday)
        _write_raw("anthropic", raw)
    except RuntimeError as e:
        print(f"  ⚠ [anthropic/{TIER}] {e}")


def _run_perplexity() -> None:
    tier_arg = None if TIER == "open" else TIER
    if not FORCE and _already_collected("perplexity"):
        print(f"  → [perplexity/{TIER}] Already collected — skipping")
        return
    try:
        raw = perplexity_ai.search_events(city_cfg, tier_arg, monday, sunday)
        _write_raw("perplexity", raw)
    except RuntimeError as e:
        print(f"  ⚠ [perplexity/{TIER}] {e}")


def _run_gemini() -> None:
    tier_arg = None if TIER == "open" else TIER
    if not FORCE and _already_collected("gemini"):
        print(f"  → [gemini/{TIER}] Already collected — skipping")
        return
    try:
        raw = gemini_ai.search_events(city_cfg, tier_arg, monday, sunday)
        _write_raw("gemini", raw)
    except RuntimeError as e:
        print(f"  ⚠ [gemini/{TIER}] {e}")


def main() -> None:
    city_name = city_cfg["name"]
    print(f"[{TIER}] {city_name} — {fmt_date(monday)} to {fmt_date(sunday)}")

    tasks = []
    if TIER != "open" and os.environ.get("ANTHROPIC_API_KEY"):
        tasks.append(_run_anthropic)
    if os.environ.get("PERPLEXITY_API_KEY"):
        tasks.append(_run_perplexity)
    if os.environ.get("GOOGLE_API_KEY"):
        tasks.append(_run_gemini)

    if not tasks:
        if TIER == "open":
            print("  → [open] No provider keys — skipping open tier")
            return
        raise SystemExit(
            "✗ No API keys set (need at least one of ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GOOGLE_API_KEY)."
        )

    if len(tasks) == 1:
        tasks[0]()
    else:
        with ThreadPoolExecutor(max_workers=len(tasks)) as executor:
            futures = [executor.submit(t) for t in tasks]
            for f in futures:
                f.result()

    print(f"  ✓ [{TIER}] Collection complete.")


if __name__ == "__main__":
    main()
