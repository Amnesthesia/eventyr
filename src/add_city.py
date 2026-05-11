"""
Add City — Event Sources Discovery
------------------------------------
Discovers the best event sources for a new city using Claude + web search,
then updates sources.yml and adds the city to digest.yml's dispatch options.

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

SOURCES_FILE  = "sources.yml"
DIGEST_WF     = ".github/workflows/digest.yml"

SEARCH_MODEL = "claude-opus-4-7"

DISCOVERY_SYSTEM = f"""You are helping set up an automated weekly events digest for {CITY_NAME}.

Find the best websites to search for local in-person events in this city. Look for:
  - Official city/council government events page
  - Official tourism website (e.g. "Visit {CITY_NAME.split(',')[0]}")
  - Eventbrite listings for the city
  - Meetup groups in the city
  - Local event guides (equivalents of Broadsheet, WeekendNotes, Urban List for this city)
  - State or city library events
  - Major universities with public events pages
  - Major cultural venues: art galleries, museums, theatres, concert halls
  - Performing arts companies (symphony, ballet, theatre companies)
  - Independent music venues
  - Bookshops with community events
  - Notable local bars or cafes known for hosting events (open mics, trivia, art nights)
  - Community event platforms specific to the region

Return ONLY a JSON array of strings. Each string should describe one source in the format:
"Source Name (url)" or "Source Name — description" if no URL is known.

Example:
["City of Sydney events (cityofsydney.nsw.gov.au/events)", "Eventbrite Sydney (eventbrite.com.au)", ...]

No markdown, no explanation — just the JSON array."""


def discover_sources() -> list[str]:
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
                f"Find all the best event sources for {CITY_NAME}. "
                "Search the web to find accurate, current URLs for each source type listed. "
                "Return a JSON array of source strings."
            )
        }],
    )

    searches = sum(1 for b in response.content if b.type == "tool_use")
    print(f"→ Performed {searches} web search(es)")

    raw = "".join(b.text for b in response.content if b.type == "text")
    raw = re.sub(r"```json|```", "", raw).strip()

    match = re.search(r"\[[\s\S]*\]", raw)
    if not match:
        print("✗ No JSON array in response. Raw output:")
        print(raw[:500])
        sys.exit(1)

    sources = json.loads(match.group())
    print(f"→ Found {len(sources)} sources")
    return sources


def update_sources_yml(sources: list[str]) -> None:
    try:
        with open(SOURCES_FILE) as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        data = {}

    if CITY_KEY in data:
        print(f"✗ City key '{CITY_KEY}' already exists in {SOURCES_FILE}. Aborting.")
        sys.exit(1)

    data[CITY_KEY] = {
        "name": CITY_NAME,
        "sources": sources,
    }

    with open(SOURCES_FILE, "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    print(f"→ Updated {SOURCES_FILE} with '{CITY_KEY}'")


def update_digest_workflow() -> None:
    with open(DIGEST_WF) as f:
        content = f.read()

    # Find the options block and append the new city key.
    # Expected structure (indented with 10 spaces):
    #           options:
    #             - brisbane
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
    print(f"Add City Agent — {CITY_KEY} ({CITY_NAME})")
    print("=" * 50)

    sources = discover_sources()
    update_sources_yml(sources)
    update_digest_workflow()

    print("✓ Done. Commit sources.yml and digest.yml to complete the setup.")


if __name__ == "__main__":
    main()
