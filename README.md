# Brisbane Events — Weekly WhatsApp Digest

A GitHub Actions job that runs every Monday morning, searches Brisbane event sources using the Claude API, and sends you a formatted WhatsApp digest.

## What it searches

- Queensland State Library
- Brisbane City Council events
- Eventbrite Brisbane
- Meetup Brisbane
- QUT, UQ, and Griffith University public events
- Local cafés (John Mills Himself, Echo & Bonce)
- Brisbane Powerhouse, QAGOMA
- Other Brisbane listings found via web search

> **Note:** Facebook and Instagram Events cannot be scraped — Meta blocks all automated access.


## Schedule

Runs automatically every **Monday at 8:00 AM AEST** (configured as `0 22 * * 0` UTC).

To change the time, edit `.github/workflows/weekly.yml` and adjust the cron expression. Use [crontab.guru](https://crontab.guru) to find the right UTC time for your timezone.

## Running locally

```bash
pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-...
export WHATSAPP_TOKEN=...
export WHATSAPP_PHONE_ID=...
export WHATSAPP_RECIPIENT=614...

python src/agent.py
```

## How it works

1. GitHub Actions triggers on schedule
2. `agent.py` calls the Claude Sonnet API with a Brisbane events prompt
3. Claude uses its built-in web search tool to query each source (typically 8–15 searches)
4. Results are parsed from Claude's JSON response
5. Events are grouped by category and formatted as WhatsApp messages
6. Each message chunk is sent via the WhatsApp Cloud API to your number

Long digests are automatically split into multiple messages to stay within WhatsApp's character limits.

## Cost

- **GitHub Actions:** Free (well within the free tier at 1 run/week)
- **Claude API:** ~$0.05–$0.20 per run depending on how many events are found
- **WhatsApp Cloud API:** Free for the first 1,000 conversations/month
