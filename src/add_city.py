"""
Add City — Event Sources Discovery
------------------------------------
Discovers the best event sources for a new city using Claude + web search,
then updates sources.yml (three-tier format) and adds the city to digest.yml.

Usage (locally):
  ANTHROPIC_API_KEY=... CITY_NAME="Sydney, NSW, Australia" CITY_KEY=sydney python src/add_city.py

Usage (CI):
  Triggered by .github/workflows/add-city.yml
"""

import os
import json
import re
import sys

import anthropic
import yaml


ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
CITY_NAME         = os.environ["CITY_NAME"]
CITY_KEY          = os.environ["CITY_KEY"]

SOURCES_FILE = "sources.yml"
DIGEST_WF    = ".github/workflows/digest.yml"

SEARCH_MODEL = "claude-opus-4-7"

DISCOVERY_SYSTEM = f"""You are helping set up an automated weekly events digest for {CITY_NAME}.

Find the best websites to search for local in-person events in this city and
sort them into three tiers:

AGGREGATORS — platforms that index events from many sources (duplicates across
  aggregators are expected). Examples: Eventbrite, Eventfinda, Meetup, Humanitix,
  local event guides (Broadsheet, Urban List, WeekendNotes, Must Do, Fever), tourism
  portals (Visit X), local community diary sites.

INSTITUTIONS — organisations that run their own independent event programmes; each
  has unique events not listed elsewhere. Examples: city/council events pages,
  state libraries, universities, major museums, galleries, concert halls, theatres,
  performing arts companies.

INDEPENDENTS — niche, community-facing venues and groups whose events rarely appear
  in aggregators. Examples: independent bookshops with events, small music venues,
  indie galleries, hackerspaces/makerspaces, board-game communities, philosophy
  groups, language exchange groups, creative spaces, bars/cafes with regular events.

Return ONLY a JSON object with exactly three keys: "aggregators", "institutions",
"independents". Each key maps to an array of source description strings in the format
"Source Name (url)" or "Source Name — description" if no URL is known.

Example shape:
{{
  "aggregators":  ["Eventbrite Sydney (eventbrite.com.au)", ...],
  "institutions": ["City of Sydney (cityofsydney.nsw.gov.au/events)", ...],
  "independents": ["Gleebooks bookshop events (gleebooks.com.au/events)", ...]
}}

No markdown, no explanation — just the JSON object."""


def discover_sources() -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    print(f"→ Discovering event sources for {CITY_NAME}…")
    response = client.messages.create(
        model=SEARCH_MODEL,
        max_tokens=4000,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 20}],
        system=DISCOVERY_SYSTEM,
        messages=[{
            "role": "user",
            "content": (
                f"Find all the best event sources for {CITY_NAME}, sorted into the three "
                "tiers described in your instructions. Search the web to find accurate, "
                "current URLs. Return a JSON object with aggregators, institutions, and independents."
            )
        }],
    )

    searches = sum(1 for b in response.content if b.type == "server_tool_use")
    print(f"→ Performed {searches} web search(es)")

    raw = "".join(b.text for b in response.content if b.type == "text")
    raw = re.sub(r"```json|```", "", raw).strip()

    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        print("✗ No JSON object in response. Raw output:")
        print(raw[:500])
        sys.exit(1)

    sources = json.loads(match.group())
    for tier in ("aggregators", "institutions", "independents"):
        n = len(sources.get(tier, []))
        print(f"→ Found {n} {tier}")
    return sources


def update_sources_yml(sources: dict) -> None:
    try:
        with open(SOURCES_FILE) as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        data = {}

    if CITY_KEY in data:
        print(f"✗ City key '{CITY_KEY}' already exists in {SOURCES_FILE}. Aborting.")
        sys.exit(1)

    data[CITY_KEY] = {
        "name":    CITY_NAME,
        "sources": {
            "aggregators":  sources.get("aggregators",  []),
            "institutions": sources.get("institutions", []),
            "independents": sources.get("independents", []),
        },
    }

    with open(SOURCES_FILE, "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    print(f"→ Updated {SOURCES_FILE} with '{CITY_KEY}'")


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
    update_sources_yml(sources)
    update_digest_workflow()

    print("✓ Done. Commit sources.yml and digest.yml to complete the setup.")


if __name__ == "__main__":
    main()
