"""
Add City — Event Sources Discovery
------------------------------------
Discovers the best event sources for a new city using available providers
(Anthropic and/or Perplexity), merges the results, then writes
sources/{city_key}.yml and adds the city to digest.yml.

Usage (locally):
  ANTHROPIC_API_KEY=... CITY_NAME="Sydney, NSW, Australia" CITY_KEY=sydney python src/add_city.py
  PERPLEXITY_API_KEY=... CITY_NAME="Sydney, NSW, Australia" CITY_KEY=sydney python src/add_city.py

Usage (CI):
  Triggered by .github/workflows/add-city.yml
"""

import os
import re
import sys

import yaml

import anthropic_ai
import gemini_ai
import perplexity_ai

CITY_NAME = os.environ["CITY_NAME"]
CITY_KEY  = os.environ["CITY_KEY"]

SOURCES_DIR = "sources"
DIGEST_WF   = ".github/workflows/digest.yml"


def _extract_domain(source_str: str) -> str:
    """Return a normalised domain from a source string like 'Name (domain.com/path)'."""
    match = re.search(r'\(([^)]+)\)', source_str)
    if match:
        url = match.group(1).lstrip("https://").lstrip("http://").lstrip("www.")
        return url.split("/")[0].lower()
    return source_str.lower()


def merge_sources(target: dict, incoming: dict) -> None:
    """Add sources from incoming into target, deduplicating by domain."""
    for tier in ("aggregators", "institutions", "independents"):
        existing = {_extract_domain(s) for s in target.get(tier, [])}
        for source in incoming.get(tier, []):
            domain = _extract_domain(source)
            if domain not in existing:
                target[tier].append(source)
                existing.add(domain)


def discover_sources() -> dict:
    sources: dict = {"aggregators": [], "institutions": [], "independents": []}

    has_anthropic  = bool(os.environ.get("ANTHROPIC_API_KEY"))
    has_perplexity = bool(os.environ.get("PERPLEXITY_API_KEY"))
    has_gemini     = bool(os.environ.get("GOOGLE_API_KEY"))

    if not has_anthropic and not has_perplexity and not has_gemini:
        raise SystemExit(
            "✗ No API keys set (need at least one of ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GOOGLE_API_KEY)."
        )

    if has_anthropic:
        merge_sources(sources, anthropic_ai.find_sources(CITY_NAME))
    if has_perplexity:
        merge_sources(sources, perplexity_ai.find_sources(CITY_NAME))
    if has_gemini:
        merge_sources(sources, gemini_ai.find_sources(CITY_NAME))

    for tier in ("aggregators", "institutions", "independents"):
        print(f"→ Total {tier}: {len(sources[tier])}")
    return sources


def write_city_file(sources: dict) -> None:
    os.makedirs(SOURCES_DIR, exist_ok=True)
    out_path = os.path.join(SOURCES_DIR, f"{CITY_KEY}.yml")

    if os.path.exists(out_path):
        print(f"✗ {out_path} already exists. Aborting.")
        sys.exit(1)

    city_data = {
        "name":    CITY_NAME,
        "sources": {
            "aggregators":  sources.get("aggregators",  []),
            "institutions": sources.get("institutions", []),
            "independents": sources.get("independents", []),
        },
    }

    with open(out_path, "w") as f:
        yaml.dump(city_data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    print(f"→ Written {out_path}")


def update_digest_workflow() -> None:
    with open(DIGEST_WF) as f:
        content = f.read()

    pattern = r'(          options:\n(?:            - \S+\n)*)'
    if not re.search(pattern, content):
        print(f"⚠ Could not locate options block in {DIGEST_WF} — skipping workflow update.")
        return

    new_entry = f"            - {CITY_KEY}\n"
    updated = re.sub(pattern, lambda m: m.group(0) + new_entry, content)

    with open(DIGEST_WF, "w") as f:
        f.write(updated)

    print(f"→ Added '{CITY_KEY}' to dispatch options in {DIGEST_WF}")


def main() -> None:
    print(f"Add City — {CITY_KEY} ({CITY_NAME})")
    print("=" * 50)

    sources = discover_sources()
    write_city_file(sources)
    update_digest_workflow()

    print(f"✓ Done. Commit sources/{CITY_KEY}.yml and digest.yml to complete the setup.")


if __name__ == "__main__":
    main()
