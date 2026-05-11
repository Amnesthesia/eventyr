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

## Setup

### 1. Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Add some credit (each weekly run costs roughly $0.05–$0.20)

### 2. Set up WhatsApp Cloud API (Meta)

This is the trickiest part — set aside about 15–20 minutes.

1. Go to [developers.facebook.com](https://developers.facebook.com) and create a free account
2. Create a new app → choose **Business** type
3. Add the **WhatsApp** product to your app
4. In the WhatsApp setup, you'll find:
   - A **test phone number** (the sender) — copy its **Phone Number ID**
   - A temporary **access token** — generate a permanent one (see below)
5. Add your own WhatsApp number as a **recipient** in the test section and verify it

**Getting a permanent access token:**
- In your Meta app dashboard → Settings → Advanced → create a **System User**
- Generate a token for that system user with `whatsapp_business_messaging` permission
- This token doesn't expire

Your recipient number must include the country code with no `+` or spaces, e.g. `61412345678` for an Australian number.

### 3. Create the GitHub repo

```bash
git init brisbane-events
cd brisbane-events
# copy these files in
git add .
git commit -m "Initial commit"
gh repo create brisbane-events --private --push --source=.
```

Or create the repo on GitHub first, then push.

### 4. Add secrets to GitHub

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

Add these four secrets:

| Secret name            | Value                                      |
|------------------------|--------------------------------------------|
| `ANTHROPIC_API_KEY`    | Your Anthropic API key                     |
| `WHATSAPP_TOKEN`       | Your Meta permanent system user token      |
| `WHATSAPP_PHONE_ID`    | Phone Number ID from WhatsApp setup        |
| `WHATSAPP_RECIPIENT`   | Your WhatsApp number, e.g. `61412345678`   |

### 5. Test it manually

In your GitHub repo → **Actions → Brisbane Events — Weekly Digest → Run workflow**

Check the logs to see how many events the agent found, then check your WhatsApp.

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
